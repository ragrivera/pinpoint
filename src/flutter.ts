// flutter.ts — `pinpoint flutter`: tap-to-pin capture for a running Flutter DEBUG app,
// with zero app code. This process owns the Dart VM Service connection (per `flutter run`,
// unlike the long-lived HTTP owner): it turns on the widget inspector's on-device select
// mode, resolves every tap to the widget's creation location (--track-widget-creation),
// grabs a widget screenshot, and streams the taps to this repo's pinpoint server. The
// reviewer annotates them on GET /flutter and Sends; when the worker finishes the batch,
// this process triggers flutter_tools' full hot reload so the fix lands on the device.
//
//   pinpoint flutter --vm-uri <uri> [--app-root <dir>]... [--port <n>] [--no-reload] [--full-screenshots]
//
//   --vm-uri    the URI `flutter run` prints ("A Dart VM Service … is available at:") — http or ws form
//   --app-root  Flutter app dir(s), for pub-root registration + "is this our widget" filtering
//               (default: the nearest directory with a pubspec.yaml, walking up from cwd)
//   --port      pinpoint server port (default: .pinpoint.json port, else 4991)
//   --no-reload never hot-reload automatically after a batch completes
//   --full-screenshots  capture the whole screen per tap instead of just the tapped widget
import { existsSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { findProject, projectPort } from './config.js';
import { Inspector, VmClient, findFlutterIsolate, findReloadService, hotReload, toWsUri } from './vmservice.ts';

const USAGE = 'usage: pinpoint flutter --vm-uri <uri> [--app-root <dir>]... [--port <n>] [--no-reload] [--full-screenshots]';
const say = (s = '') => console.log(s);

/** width/height straight from a PNG's IHDR chunk (bytes 16-23) — the widget screenshot's
 *  intrinsic size is the only rect information the inspector protocol exposes. */
export function pngSize(base64: string): { w: number; h: number } | null {
  try {
    const head = Buffer.from(base64.slice(0, 44), 'base64'); // 33 bytes cover signature + IHDR
    if (head.length < 24 || head[0] !== 0x89 || head[1] !== 0x50) return null;
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
  } catch { return null; }
}

/** file:///… creation-location URI → a path relative to the pinpoint project root (the
 *  worker's cwd), or null when it's not inside any app root (a framework/package widget). */
export function toRepoPath(fileUri: string, appRoots: string[], projectRoot: string): string | null {
  if (!fileUri.startsWith('file://')) return null; // package:/dart: URIs are never local project code
  const p = decodeURIComponent(fileUri.slice('file://'.length));
  if (!appRoots.some((r) => p === r || p.startsWith(r + '/'))) return null;
  const rel = relative(projectRoot, p);
  return rel.startsWith('..') || isAbsolute(rel) ? p : rel;
}

function nearestPubspec(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, 'pubspec.yaml'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Minimal SSE consumer over fetch — the command channel back from the server. */
async function sseListen(url: string, onEvent: (e: any) => void, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const res = await fetch(url, { signal, headers: { Accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
      const dec = new TextDecoder(); let buf = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true }); let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (data) { try { onEvent(JSON.parse(data)); } catch {} }
        }
      }
    } catch { if (signal.aborted) return; }
    if (!signal.aborted) await Bun.sleep(2000); // server restarted / dropped — reconnect
  }
}

/** Returns the process exit code. */
export async function run(argvIn: string[]): Promise<number> {
  const argv = argvIn.slice();
  const flag = (n: string) => { const i = argv.indexOf(n); if (i < 0) return false; argv.splice(i, 1); return true; };
  const opt = (n: string) => { const i = argv.indexOf(n); if (i < 0) return undefined; return argv.splice(i, 2)[1]; };
  const multi = (n: string) => { const out: string[] = []; let v: string | undefined; while ((v = opt(n)) !== undefined) out.push(v); return out; };
  const NO_RELOAD = flag('--no-reload');
  const FULL_SHOTS = flag('--full-screenshots');
  const HELP = flag('--help') || flag('-h');
  const vmUriArg = opt('--vm-uri');
  const portArg = opt('--port');
  const appRootArgs = multi('--app-root');
  if (HELP) { say(USAGE); return 0; }
  if (argv.length) { console.error(`unknown argument(s): ${argv.join(' ')}\n${USAGE}`); return 2; }
  if (!vmUriArg) { console.error(`--vm-uri is required — copy the URI flutter run prints ("A Dart VM Service … is available at: http://127.0.0.1:PORT/TOKEN=/")\n${USAGE}`); return 2; }

  const project = findProject(process.env.PINPOINT_ROOT || process.cwd());
  const PORT = Number(portArg) || Number(process.env.PINPOINT_PORT) || projectPort(process.env.PINPOINT_ROOT || process.cwd());
  const API = `http://127.0.0.1:${PORT}`;
  const post = (path: string, body: unknown) => fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);

  // 1. The pinpoint server must be up (it owns the panel + the batch loop).
  try {
    const h = await fetch(`${API}/api/health`).then((r) => r.json());
    if (!h?.ok) throw new Error('bad health');
  } catch {
    console.error(`no pinpoint server on 127.0.0.1:${PORT}\nstart one: a Claude Code session in this repo (.mcp.json), or detached:\n  PINPOINT_DETACHED=1 PINPOINT_ROLE=http nohup bun run pinpoint serve > .docs/pinpoint/server.log 2>&1 & disown`);
    return 1;
  }

  // 2. App roots: where "our" widgets live.
  const appRoots = (appRootArgs.length ? appRootArgs.map((d) => resolve(d)) : [nearestPubspec(process.cwd()) || project.root]).filter((d, i, a) => a.indexOf(d) === i);
  for (const r of appRoots) if (!existsSync(join(r, 'pubspec.yaml'))) say(`warning: ${r} has no pubspec.yaml — is it really a Flutter app root?`);

  // 3. Connect to the VM service.
  let wsUri: string;
  try { wsUri = toWsUri(vmUriArg); } catch (e: any) { console.error(String(e?.message || e)); return 2; }
  let vm: VmClient;
  try { vm = await VmClient.connect(wsUri); } catch (e: any) { console.error(`${e?.message || e}\nThe URI changes on every flutter run — copy the current one.`); return 1; }
  const iso = await findFlutterIsolate(vm).catch((e: Error) => { console.error(e.message); return null; });
  if (!iso) { vm.close(); return 1; }
  const insp = new Inspector(vm, iso.id);

  // 4. Debug-build preflight: without creation tracking there are no source locations.
  if (!(await insp.isCreationTracked().catch(() => false))) {
    console.error('this build does not track widget creation (profile/release?) — run a plain debug build (`flutter run`) without --no-track-widget-creation');
    vm.close(); return 1;
  }
  await insp.addPubRoots(appRoots).catch((e: any) => say(`warning: addPubRootDirectories failed (${e?.message || e}) — taps may resolve to framework widgets`));

  // 5. Hot reload: only flutter_tools (run/attach/IDE) registers the real thing.
  const reloadMethod = NO_RELOAD ? null : await findReloadService(vm).catch(() => null);
  if (!NO_RELOAD && !reloadMethod) say('hot reload service not found — fixes will need a manual "r" in the flutter run terminal');

  // 6. Select mode on; announce to the panel.
  await insp.enableSelect(true);
  let selectOn = true;
  await post('/api/flutter/status', { t: 'client', connected: true, app: iso.name || 'flutter' });
  say(`pinpoint flutter — connected (isolate ${iso.name || iso.id})`);
  say(`select mode ON — tap widgets on the device/emulator`);
  say(`panel: ${API}/flutter   (open this in your browser)`);
  say(`app root${appRoots.length > 1 ? 's' : ''}: ${appRoots.join(', ')}${reloadMethod ? '   hot reload: armed' : ''}`);
  say('Ctrl-C to disconnect (select mode is turned off on exit)');

  // 7. Capture: every on-device selection → summary widget → screenshot → server.
  let tapCount = 0;
  let alive = true;
  await insp.onSelection(async () => {
    try {
      const sel = await insp.getSelectedSummary();
      if (!sel) return;
      const loc = sel.creationLocation;
      if (!loc) { say(`  skipped: ${sel.widgetRuntimeType || 'widget'} has no creation location`); return; }
      const repoPath = toRepoPath(loc.file, appRoots, project.root);
      if (!repoPath) { say(`  skipped: ${sel.widgetRuntimeType} @ ${loc.file}:${loc.line} (outside the app root${appRoots.length > 1 ? 's' : ''})`); return; }
      let shot: string | null = null;
      const shotId = FULL_SHOTS ? (await insp.rootId()) ?? sel.valueId : sel.valueId;
      if (shotId) shot = await insp.screenshot(shotId, FULL_SHOTS ? 480 : 360, FULL_SHOTS ? 960 : 360);
      const size = shot ? pngSize(shot) : null;
      const r = await post('/api/flutter/taps', {
        widget: sel.widgetRuntimeType,
        source: { file: repoPath, line: loc.line, column: loc.column },
        rect: size ? { x: 0, y: 0, w: size.w, h: size.h } : undefined,
        screenshot: shot ? { type: 'image/png', data: shot } : undefined,
      });
      const j: any = r && (await r.json().catch(() => null));
      if (j?.ok) { tapCount++; say(`  #${j.n} ${sel.widgetRuntimeType} → ${repoPath}:${loc.line}`); }
      else say(`  tap dropped: server said ${JSON.stringify(j).slice(0, 120)}`);
    } catch (e: any) { say(`  tap failed: ${e?.message || e}`); }
  });

  // 8. Command channel from the panel + batch-completion watcher.
  const abort = new AbortController();
  const polling = new Set<string>();
  const pollBatch = async (id: string) => {
    if (polling.has(id)) return;
    polling.add(id);
    const deadline = Date.now() + 15 * 60_000;
    say(`batch ${id} sent — waiting for the worker to finish${reloadMethod ? ' (hot reload on completion)' : ''}`);
    while (alive && Date.now() < deadline) {
      await Bun.sleep(2500);
      try {
        const st: any = await fetch(`${API}/api/pins/${encodeURIComponent(id)}`).then((r) => r.json());
        if (st?.complete) {
          if (reloadMethod) {
            const r = await hotReload(vm, reloadMethod, iso.id);
            say(r.ok ? `batch ${id} complete — hot reloaded ✓` : `batch ${id} complete — hot reload failed: ${r.error}`);
            await post('/api/flutter/status', { t: 'reloaded', id, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
          } else say(`batch ${id} complete — press "r" in the flutter run terminal to see the fixes`);
          break;
        }
      } catch {} // server briefly away — keep polling
    }
    polling.delete(id);
  };
  void sseListen(`${API}/api/flutter/events`, (e) => {
    if (e?.t === 'select' && typeof e.on === 'boolean' && e.on !== selectOn) { selectOn = e.on; void insp.enableSelect(e.on).then(() => say(`select mode ${e.on ? 'ON' : 'off'} (panel)`)); }
    else if (e?.t === 'sent' && e.id) void pollBatch(String(e.id));
  }, abort.signal);

  // 9. Drift watch: the on-device exit button turns select mode off behind our back.
  const drift = setInterval(async () => {
    try { const on = await insp.selectEnabled(); if (on !== selectOn) { selectOn = on; await post('/api/flutter/select', { on }); say(`select mode ${on ? 'ON' : 'off'} (device)`); } } catch {}
  }, 5000);

  // 10. Teardown: on Ctrl-C or when the app goes away.
  return new Promise<number>((done) => {
    const cleanup = async (code: number, why: string) => {
      if (!alive) return; alive = false;
      clearInterval(drift); abort.abort();
      try { await insp.enableSelect(false); await insp.disposeGroup(); } catch {}
      await post('/api/flutter/status', { t: 'client', connected: false });
      vm.close();
      say(`${why} — ${tapCount} tap(s) captured this session`);
      done(code);
    };
    process.on('SIGINT', () => void cleanup(0, 'disconnected'));
    process.on('SIGTERM', () => void cleanup(0, 'disconnected'));
    vm.onClose = () => void cleanup(0, 'app stopped (VM Service closed)');
  });
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
