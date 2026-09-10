#!/usr/bin/env bun
// server.ts — pinpoint's LIVE-CODE review loop. ONE process, two faces:
//   1. MCP server over stdio (the project's .mcp.json runs `pinpoint serve`):
//      wait_for_pins / get_pins / list_pins / report_pin / list_sessions.
//   2. HTTP on localhost:<port>: serves the overlay as /pinpoint.js (overlay/pinpoint.js
//      with a brand prelude), accepts POST /api/pins, and — in worker mode — spawns a
//      headless Claude per batch and exposes its chat (/api/chat).
//
// Nothing here serves the app: the project's own dev server does (the Vite plugin or
// <PinpointScript/> adds the script tag). Pins resolve to source files and routes.
// The one static exception is the project's open-design mockups (GET /.docs/open-design/**,
// rooted at the project), served with the same overlay injected so mockup pins ride the
// same worker + chat loop as app pins; the worker brief tells the two apart by the page
// path (an artifact pin edits the artifact, never app source).
//
// Dispatch. An installed project defaults to "dispatch": "worker": Send in the overlay
// writes the batch pre-claimed and spawns `claude -p` (stream-json in/out) from the repo
// root as a WORKER for that batch. The worker fixes the pins, reports progress through
// the pinpoint MCP (report_pin) and answers follow-ups typed in the overlay's chat
// drawer; its stdin stays open so the conversation continues without a cold start, it
// exits after an idle period, and a later message resumes the same Claude session
// (--resume <uuid>). Nothing has to be waiting: no named session, no wait_for_pins loop.
// "dispatch": "session" restores the original behaviour (a live pinpoint_<name> session
// claims the batch). The To: picker can still address a live session explicitly.
//
// Many sessions, one overlay: every MCP process is a SESSION with an id + label
// (the Claude session name, read from ~/.claude/sessions/<claude pid>.json).
// Sessions register with the HTTP owner (heartbeat), the overlay lists them in a
// "To:" picker, and a batch is delivered ONLY to the session it is addressed to
// ("Any" = first taker). Delivery claims the file atomically (rename to
// <id>.claimed-<session>.json) so a batch is handled exactly once.
//
// Per-project servers: the nearest `.pinpoint.json` above PINPOINT_ROOT/cwd (written by
// `pinpoint install`) names the project root and this repo's OWN HTTP port, so two
// repos never share an owner or a feedback dir. No file → cwd + 4991, session dispatch.
//
// .pinpoint.json keys: port, name, session, apps[{dir, origin}], dispatch ("worker" |
// "session"), claudeBin (path), worker { idleMinutes (30), recapOnIdle (true),
// mcp ("pinpoint" | "all"), args ([] extra claude flags) }.
//
// Env:  PINPOINT_ROOT        start the .pinpoint.json walk here (default: process.cwd());
//                            batches land in <root>/.docs/pinpoint/feedback
//       PINPOINT_PORT        HTTP port (default: .pinpoint.json port, else 4991)
//       PINPOINT_ROLE=http   standalone HTTP owner only: no session identity, never
//                            claims batches (for a detached server started from a shell)
//       PINPOINT_SESSION     override the session label; PINPOINT_SESSION_ID the id
//       PINPOINT_CLAUDE      path to the claude binary for workers
//       PINPOINT_DISPATCH    worker | session (overrides .pinpoint.json)
//       PINPOINT_OVERLAY     path to an alternative overlay script (default: overlay/pinpoint.js)
//
// Browser access: every /api/* route checks the Origin header against the project's app
// origins plus localhost / 127.0.0.1 / *.localhost. A worker runs with permission prompts
// skipped, so a foreign web page must never be able to post into it.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, extname, join, resolve, sep } from 'path';
import { findProject as findProjectFile } from './config.js';
import pkg from '../package.json';

type ModelOpt = { id: string; label: string; note?: string };
type WorkerCfg = { idleMinutes?: number; mcp?: 'pinpoint' | 'all'; args?: string[]; model?: string; models?: Array<string | Partial<ModelOpt>>; effort?: string; recapOnIdle?: boolean };
type Project = { root: string; port?: number; name?: string; file?: string; dispatch?: 'worker' | 'session'; claudeBin?: string; worker?: WorkerCfg; origins: string[]; updateCheck?: boolean };
function findProject(from: string): Project {
  const { root, file, config: j } = findProjectFile(from);
  if (!file) return { root: resolve(from), origins: [] };
  if (!j) return { root, file, origins: [] }; // unreadable file: still marks the root
  const origins = Array.isArray(j.apps) ? j.apps.map((a: any) => String(a?.origin || '')).filter(Boolean).map((o: string) => { try { return new URL(o).origin; } catch { return ''; } }).filter(Boolean) : [];
  return { root, port: Number(j.port) || undefined, name: typeof j.name === 'string' && j.name ? j.name : undefined, file, dispatch: j.dispatch === 'session' || j.dispatch === 'worker' ? j.dispatch : undefined, claudeBin: typeof j.claudeBin === 'string' ? j.claudeBin : undefined, worker: j.worker && typeof j.worker === 'object' ? j.worker : undefined, origins, updateCheck: j.updateCheck !== false };
}
const PROJECT = findProject(process.env.PINPOINT_ROOT || process.cwd());
const ROOT = PROJECT.root;
const PORT = Number(process.env.PINPOINT_PORT || PROJECT.port || 4991);
// Handler convention. An INSTALLED project (a .pinpoint.json exists) requires a live
// Claude session named pinpoint_<name> for SESSION dispatch — e.g. `/rename pinpoint_orgspace`.
// Only such sessions appear in the overlay's "To:" picker and only they claim unaddressed
// batches. Legacy repos (no file) keep the old rule: any session whose label contains "pinpoint".
const STRICT = Boolean(PROJECT.file);
const PROJECT_NAME = (PROJECT.name || basename(PROJECT.root)).toLowerCase();
const REQUIRED_SESSION = `pinpoint_${PROJECT_NAME}`;
const DISPATCH: 'worker' | 'session' = (process.env.PINPOINT_DISPATCH === 'worker' || process.env.PINPOINT_DISPATCH === 'session') ? process.env.PINPOINT_DISPATCH : PROJECT.dispatch || (STRICT ? 'worker' : 'session');
function isHandler(label: string): boolean {
  const l = label.toLowerCase();
  return STRICT ? l.includes(`pinpoint_${PROJECT_NAME}`) || l.includes(`pinpoint-${PROJECT_NAME}`) : l.includes('pinpoint');
}
const FEEDBACK_DIR = join(ROOT, '.docs', 'pinpoint', 'feedback');
const HOME = process.env.HOME || homedir();
const OVERLAY_PATH = process.env.PINPOINT_OVERLAY || join(import.meta.dir, '..', 'overlay', 'pinpoint.js');
const CLAUDE_BIN = PROJECT.claudeBin || process.env.PINPOINT_CLAUDE || Bun.which('claude') || join(HOME, '.local', 'bin', 'claude');
const WORKER_IDLE_MS = Math.max(1, Number(PROJECT.worker?.idleMinutes ?? 30)) * 60_000;
// The idle timeout is the worker's last moment, and it is the one moment it cannot write for itself:
// stop() closes its stdin. So spend one short turn asking for a recap first, then let it go. Set
// worker.recapOnIdle false to exit straight away.
const RECAP_ON_IDLE = PROJECT.worker?.recapOnIdle !== false;
const RECAP_GRACE_MS = 120_000; // it never answered — leave anyway
const RECAP_PROMPT = [
  'You are about to be closed for inactivity, so this is your last word in this conversation.',
  'Reply with a recap line and nothing else — no tool calls, no preamble:',
  '',
  'recap: Goal was <the ask>; <where it stands now>. Next: <what is on the reviewer>.',
].join('\n');
const WORKER_MCP: 'pinpoint' | 'all' = PROJECT.worker?.mcp === 'all' ? 'all' : 'pinpoint';
const WORKER_ARGS: string[] = Array.isArray(PROJECT.worker?.args) ? PROJECT.worker!.args!.map(String) : [];
// Which Claude a worker runs (`--model <id>`; the empty id means the claude binary's own
// default). Aliases rather than dated ids, so the list does not rot; a project can replace it
// with worker.models in .pinpoint.json and preselect one with worker.model. The overlay's model
// pill offers exactly this list and the server refuses anything outside it — a typo would
// otherwise surface only as a worker that dies on spawn.
const ANY_MODEL: ModelOpt = { id: '', label: 'Default', note: 'whatever claude is set to' };
const DEFAULT_MODELS: ModelOpt[] = [
  ANY_MODEL,
  { id: 'fable', label: 'Fable', note: 'most capable, priciest' },
  { id: 'opus', label: 'Opus', note: 'strong all-rounder' },
  { id: 'opus[1m]', label: 'Opus 1M', note: 'opus, 1M-token context' },
  { id: 'sonnet', label: 'Sonnet', note: 'faster, cheaper' },
  { id: 'haiku', label: 'Haiku', note: 'fastest, small fixes' },
];
const MODELS: ModelOpt[] = (() => {
  const raw = PROJECT.worker?.models;
  if (!Array.isArray(raw) || !raw.length) return DEFAULT_MODELS;
  const list = raw
    .map((m): ModelOpt => (typeof m === 'string' ? { id: m, label: m } : { id: String(m?.id ?? ''), label: String(m?.label || m?.id || ANY_MODEL.label), ...(m?.note ? { note: String(m.note) } : {}) }))
    .filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i);
  return list.some((m) => m.id === '') ? list : [ANY_MODEL, ...list];
})();
// How hard the worker thinks (`claude --effort`). The CLI takes low | medium | high | xhigh | max;
// '' leaves it alone. Unlike the model, the CLI never reports the effort it settled on, so the pill
// can only name what was picked here — "Default" means whatever claude does on its own.
const EFFORTS: ModelOpt[] = [
  { id: '', label: 'Default', note: 'whatever claude does on its own' },
  { id: 'low', label: 'Low', note: 'least thinking, cheapest' },
  { id: 'medium', label: 'Medium', note: 'balanced' },
  { id: 'high', label: 'High', note: 'more thinking on hard steps' },
  { id: 'xhigh', label: 'X-High', note: 'harder still' },
  { id: 'max', label: 'Max', note: 'think as long as it takes' },
];
const isEffort = (id: string) => EFFORTS.some((e) => e.id === id);
const effortIds = () => EFFORTS.map((e) => e.id || '(default)').join(', ');
const DEFAULT_EFFORT = typeof PROJECT.worker?.effort === 'string' && isEffort(PROJECT.worker.effort) ? PROJECT.worker.effort : '';
const isModel = (id: string) => MODELS.some((m) => m.id === id);
const modelIds = () => MODELS.map((m) => m.id || '(default)').join(', ');
const DEFAULT_MODEL = typeof PROJECT.worker?.model === 'string' && isModel(PROJECT.worker.model) ? PROJECT.worker.model : '';
// Worker state lives beside, not inside, the feedback dir: older pinpoint MCP processes treat
// every unclaimed *.json in feedback/ as a batch and would claim-rename these files.
const WORKERS_DIR = join(ROOT, '.docs', 'pinpoint', 'workers');
// The overlay's Look (size, blur, opacity, hover, layout, dock edge, tint) belongs to the
// reviewer, not to an origin: localStorage is per port, so :4403 and :4404 would each open
// with their own. The last saved copy lives here and rides along with BRAND on every load.
const LOOK_FILE = join(ROOT, '.docs', 'pinpoint', 'look.json');
const LOOK_MAX = 64_000;
const savedLook = (): unknown => { try { return JSON.parse(readFileSync(LOOK_FILE, 'utf8')); } catch { return null; } };
const WORKER_MCP_CFG = join(WORKERS_DIR, 'mcp.json');
const BRAND = { name: 'Pinpoint', key: 'pinpoint', api: '/api/pins', sessions: '/api/sessions', chat: '/api/chat', dispatch: DISPATCH, server: 'pinpoint', port: PORT, requiredSession: STRICT ? REQUIRED_SESSION : null, models: MODELS, model: DEFAULT_MODEL, efforts: EFFORTS, effort: DEFAULT_EFFORT, idleMinutes: WORKER_IDLE_MS / 60_000, recapOnIdle: RECAP_ON_IDLE };

// ─── Update check ─────────────────────────────────────────────────────────────
// So people notice a newer pinpoint: at most once every 4 hours — on owner start and whenever a worker
// (re)starts — `git ls-remote --tags` the package repo (the user's own git credentials, so a private
// repo works too) and compare the highest vX.Y.Z tag with this package's version. Never blocks a
// spawn (background, 8s cap); the result rides on /api/health and the overlay prelude, where the
// drawer shows a chip. Off with "updateCheck": false in .pinpoint.json or PINPOINT_NO_UPDATE_CHECK=1;
// PINPOINT_UPDATE_REPO points the check at another remote (tests, forks).
type UpdateInfo = { current: string; latest: string; available: boolean; checkedAt: string; repo: string; command: string };
const UPDATE_CHECK = PROJECT.updateCheck !== false && process.env.PINPOINT_NO_UPDATE_CHECK !== '1';
const UPDATE_EVERY_MS = 4 * 60 * 60_000;
const repoSpec = String((pkg as any).repository?.url ?? (pkg as any).repository ?? '');
const gh = /^github:([\w.-]+\/[\w.-]+)$/.exec(repoSpec);
const UPDATE_REPO = process.env.PINPOINT_UPDATE_REPO || (gh ? `https://github.com/${gh[1]}.git` : repoSpec);
const semver = (v: string) => { const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
const semverCmp = (a: string, b: string) => { const x = semver(a), y = semver(b); if (!x || !y) return 0; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
let update: UpdateInfo | null = null;
let updateCheckedAt = 0, updateRunning = false;
async function checkUpdate(): Promise<UpdateInfo | null> {
  const proc = Bun.spawn(['git', 'ls-remote', '--tags', '--refs', UPDATE_REPO], { stdout: 'pipe', stderr: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 8_000);
  const out = await new Response(proc.stdout).text().catch(() => '');
  clearTimeout(timer);
  if ((await proc.exited) !== 0) return null;
  const tags = out.split('\n').map((l) => l.split('refs/tags/')[1] || '').filter((t) => semver(t));
  if (!tags.length) return null;
  const latest = tags.sort(semverCmp).pop()!.replace(/^v/, '');
  const spec = gh ? `github:${gh[1]}#v${latest}` : `${pkg.name}@${latest}`;
  return { current: pkg.version, latest, available: semverCmp(latest, pkg.version) > 0, checkedAt: new Date().toISOString(), repo: UPDATE_REPO, command: `bun add -D ${spec}` };
}
function maybeCheckUpdate() {
  if (!UPDATE_CHECK || !UPDATE_REPO || updateRunning || Date.now() - updateCheckedAt < UPDATE_EVERY_MS) return;
  updateRunning = true; updateCheckedAt = Date.now();
  checkUpdate().then((u) => {
    if (u && (!update || update.latest !== u.latest)) log(u.available ? `update available: ${pkg.name} ${u.current} → ${u.latest}  (${u.command})` : `up to date: ${pkg.name} ${u.current}`);
    if (u) update = u;
  }).catch(() => {}).finally(() => { updateRunning = false; });
}

// ─── Session identity ─────────────────────────────────────────────────────────
type Session = { id: string; label: string; cwd: string; seenAt: number };
const HTTP_ONLY = process.env.PINPOINT_ROLE === 'http';
function claudeSessionName(pid: number): string | null {
  try { const j = JSON.parse(readFileSync(join(HOME, '.claude', 'sessions', `${pid}.json`), 'utf8')); return typeof j.name === 'string' ? j.name : null; } catch { return null; }
}
// The label is read fresh (not frozen at startup) so a `/rename` of the Claude
// session takes effect without restarting this process.
const SELF: Session | null = HTTP_ONLY ? null : {
  id: process.env.PINPOINT_SESSION_ID || String(process.ppid),
  get label() { return process.env.PINPOINT_SESSION || claudeSessionName(process.ppid) || `${basename(ROOT)}#${process.ppid}`; },
  cwd: ROOT,
  seenAt: Date.now(),
};
const SESSION_TTL_MS = 45_000;
const registry = new Map<string, Session>(); // only meaningful on the HTTP owner
function upsertSession(s: Omit<Session, 'seenAt'>) { registry.set(s.id, { ...s, seenAt: Date.now() }); }
function liveSessions(): Session[] { const now = Date.now(); return [...registry.values()].filter((s) => now - s.seenAt < SESSION_TTL_MS).sort((a, b) => a.label.localeCompare(b.label)); }
// Read per request so overlay edits are live without restarting the MCP.
const overlay = () => `window.__reviewBrand = ${JSON.stringify({ ...BRAND, update, look: savedLook() })};\n` + readFileSync(OVERLAY_PATH, 'utf8');

// ─── Open-design artifacts ────────────────────────────────────────────────────
// Mockup explorers under <root>/.docs/open-design are served from here with the overlay
// injected, so pins on a mockup use the same Send → worker → chat loop as pins on the app.
// Only that prefix is served (GET); everything else stays API-only.
const ARTIFACT_PREFIX = '/.docs/open-design/';
const ARTIFACT_ROOT = join(ROOT, '.docs', 'open-design');
const ARTIFACT_MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon' };
const ARTIFACT_INJECT = '<script src="/pinpoint.js" defer></script>';
// The decoded artifact path of a batch page, or null when the page is the app.
const artifactPath = (page: string): string | null => { try { const p = decodeURIComponent(new URL(page).pathname); return p.startsWith(ARTIFACT_PREFIX) ? p : null; } catch { return null; } };
function serveArtifact(pathname: string): Response | null {
  let p: string; try { p = decodeURIComponent(pathname); } catch { return null; }
  if (!p.startsWith(ARTIFACT_PREFIX)) return null;
  if (p.endsWith('/')) p += 'index.html';
  const file = resolve(ROOT, '.' + p);
  if (!file.startsWith(ARTIFACT_ROOT + sep) || !existsSync(file) || statSync(file).isDirectory()) return new Response('not found', { status: 404 });
  const ext = extname(file).toLowerCase();
  if (ext !== '.html') return new Response(Bun.file(file), { headers: { 'Content-Type': ARTIFACT_MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' } });
  let html = readFileSync(file, 'utf8');
  if (!html.includes('pinpoint.js')) html = html.includes('</body>') ? html.replace('</body>', ARTIFACT_INJECT + '\n</body>') : html + ARTIFACT_INJECT;
  return new Response(html, { headers: { 'Content-Type': ARTIFACT_MIME['.html'], 'Cache-Control': 'no-store' } });
}

// ─── Flutter capture ──────────────────────────────────────────────────────────
// `pinpoint flutter` (a separate CLI process) owns the Dart VM Service connection to a
// running Flutter debug app: the reviewer taps widgets ON the device (inspector select
// mode) and each tap arrives here pre-resolved to source (POST /api/flutter/taps, no
// Origin header → passes the gate like every native client). The GET /flutter panel
// renders the taps as annotatable pin cards and sends a normal batch; pins carry
// `source: {file, line, column}` + `widget` instead of a DOM element. The bus below is
// in-memory only — taps are scratch state until they become a batch.
const FLUTTER_PANEL_PATH = process.env.PINPOINT_FLUTTER_PANEL || join(import.meta.dir, '..', 'overlay', 'flutter-panel.html');
const FLUTTER_TAP_MAX = 30; // ring: older unsent taps fall off
type FlutterTap = { n: number; widget: string; source: { file: string; line: number; column: number }; rect?: unknown; screenshot?: { type: string; data: string } | null; at: string };
const flutterBus = {
  taps: [] as FlutterTap[],
  nextTap: 1,
  client: { connected: false, app: '' },
  subs: new Set<(e: Record<string, unknown>) => void>(),
  emit(e: Record<string, unknown>) { const ev = { at: new Date().toISOString(), ...e }; for (const s of this.subs) { try { s(ev); } catch {} } },
};
const flutterPage = (page: string): boolean => { try { const p = new URL(page).pathname; return p === '/flutter' || p.startsWith('/flutter/'); } catch { return false; } };
function serveFlutterPanel(): Response {
  let html: string;
  try { html = readFileSync(FLUTTER_PANEL_PATH, 'utf8'); } catch { return new Response('flutter panel missing', { status: 500 }); }
  if (!html.includes('pinpoint.js')) html = html.includes('</body>') ? html.replace('</body>', ARTIFACT_INJECT + '\n</body>') : html + ARTIFACT_INJECT;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
// SSE for the flutter bus: replay client state + unsent taps, then live events. Same framing
// as the worker chat stream (plain `data:` lines, 2s retry, heartbeat comments).
function flutterSse(req: Request, headers: Record<string, string>) {
  let sub: ((e: Record<string, unknown>) => void) | null = null; let hb: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      const push = (e: unknown) => { try { c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch {} };
      c.enqueue(enc.encode('retry: 2000\n\n'));
      push({ t: 'client', at: new Date().toISOString(), ...flutterBus.client });
      for (const tap of flutterBus.taps) push({ t: 'tap', at: tap.at, tap });
      push({ t: 'sync', at: new Date().toISOString() });
      sub = push; flutterBus.subs.add(sub);
      hb = setInterval(() => { try { c.enqueue(enc.encode(': hb\n\n')); } catch {} }, 20_000);
      req.signal.addEventListener('abort', () => { if (sub) flutterBus.subs.delete(sub); if (hb) clearInterval(hb); try { c.close(); } catch {} });
    },
    cancel() { if (sub) flutterBus.subs.delete(sub); if (hb) clearInterval(hb); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...headers } });
}

const log = (...a: unknown[]) => console.error('[pinpoint]', ...a); // stderr — stdout is the MCP channel

// ─── Pin store: the directory is the source of truth, shared by every session ──
type PinStatus = 'working' | 'done' | 'skipped' | 'question';
type Progress = Record<string, { status: PinStatus; note?: string; at: string; by?: string }>;
type Batch = { id: string; receivedAt: string; page: string; title: string; general: string; pins: unknown[]; state?: unknown; viewport?: unknown; to?: string; model?: string; effort?: string; claimedBy?: string; progress?: Progress };
const CLAIMED = /\.claimed-([^.]+)\.json$/;
// Batch files: <id>.json / <id>.claimed-<who>.json (nothing else belongs in feedback/).
const isBatchFile = (n: string) => n.endsWith('.json') && !n.startsWith('_');
const pending: Batch[] = [];
const waiters: Array<(b: Batch | null) => void> = [];
const seen = new Set<string>();

class PinError extends Error { constructor(public status: number, message: string, public hint: string) { super(message); } }
function handlers(): Session[] { return liveSessions().filter((s) => isHandler(s.label)); }
// An unaddressed batch is routed to the handler session when exactly ONE is live; with
// several it stays "any" and the first handler to scan the directory claims it.
function defaultTarget(): string { const h = handlers(); return h.length === 1 ? h[0].id : ''; }
function receive(input: Omit<Batch, 'id' | 'receivedAt'> & { images?: unknown }) {
  const { images, ...body } = input;
  const ts = new Date();
  const toRaw = (body.to || '').trim();
  const model = String(body.model ?? DEFAULT_MODEL).trim(); // req.json() is unvalidated: a non-string must 400, not throw
  if (!isModel(model)) throw new PinError(400, `Unknown model ${model}`, `This server offers: ${modelIds()} — add others to worker.models in .pinpoint.json.`);
  const effort = String(body.effort ?? DEFAULT_EFFORT).trim();
  if (!isEffort(effort)) throw new PinError(400, `Unknown effort ${effort}`, `This server offers: ${effortIds()}.`);
  const explicitSession = Boolean(toRaw) && toRaw !== 'any' && toRaw !== 'worker';
  const wantsWorker = toRaw === 'worker' || (!explicitSession && DISPATCH === 'worker');
  if (STRICT && explicitSession && !handlers().some((x) => x.id === toRaw)) throw new PinError(409, `Session ${toRaw} is not a live ${REQUIRED_SESSION} handler`, `Open the To: picker and choose a listed session (or the headless worker).`);
  if (!wantsWorker && !explicitSession && STRICT && !handlers().length) throw new PinError(409, `No ${REQUIRED_SESSION} session is active`, `Open or rename a Claude session for this repo (/rename ${REQUIRED_SESSION}), or pick "Headless worker" in the To: picker / set "dispatch": "worker" in .pinpoint.json.`);
  if (wantsWorker && !httpOwner) throw new PinError(503, 'Not the HTTP owner', 'Only the owning pinpoint server can spawn workers.');
  let route = 'page';
  try { route = new URL(body.page).pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'root'; } catch {}
  const id = `${ts.toISOString().replace(/[:.]/g, '-')}-${route}`;
  mkdirSync(FEEDBACK_DIR, { recursive: true });
  if (wantsWorker) {
    // Pre-claimed for the worker: it reads the batch by id (get_pins { id }) and reports
    // through report_pin, so nothing else may claim it and the overlay never shows "waiting".
    const workerId = 'w' + Math.random().toString(36).slice(2, 8);
    const { refs, blocks } = saveFiles(id, images);
    const b: Batch & { images?: string[] } = { id, receivedAt: ts.toISOString(), ...body, to: workerId, claimedBy: workerId, ...(refs.length ? { images: refs.map((r) => r.file) } : {}) };
    writeFileSync(join(FEEDBACK_DIR, `${id}.claimed-${workerId}.json`), JSON.stringify(b, null, 2));
    const w = new Worker({ batchId: id, workerId, sessionUuid: crypto.randomUUID(), page: b.page, title: b.title, state: 'starting', started: false, startedAt: ts.toISOString(), lastAt: ts.toISOString(), turns: 0, costUsd: 0, model, effort });
    workers.set(id, w);
    w.emit({ t: 'batch', pins: b.pins.length, general: b.general || '', page: b.page, title: b.title, images: publicRefs(refs) });
    w.sendRaw(withImages(batchPrompt(b), refs, blocks));
    log('pins received', id, `${b.pins.length} pin(s)`, `→ worker ${workerId}`);
    if (flutterPage(b.page)) flutterBus.emit({ t: 'sent', id, pins: b.pins.length }); // `pinpoint flutter` polls the batch and hot-reloads on completion
    return { ...b, worker: true };
  }
  const { refs } = saveFiles(id, images); // a session reads them with its Read tool
  const b: Batch & { images?: string[] } = { id, receivedAt: ts.toISOString(), ...body, to: explicitSession ? toRaw : defaultTarget(), ...(refs.length ? { images: refs.map((r) => r.file) } : {}) };
  writeFileSync(join(FEEDBACK_DIR, `${id}.json`), JSON.stringify(b, null, 2));
  log('pins received', id, `${b.pins.length} pin(s)`, `→ session ${b.to || 'any'}`);
  if (flutterPage(b.page)) flutterBus.emit({ t: 'sent', id, pins: b.pins.length });
  return b;
}
function deliver(b: Batch) { const w = waiters.shift(); if (w) w(b); else pending.push(b); }
// Claim-on-read: an unclaimed batch addressed to this session (or to anyone)
// is renamed to <id>.claimed-<session>.json in one atomic step; whoever wins
// the rename delivers it, everyone else skips it. Batches addressed to another
// session are left untouched (list_pins still shows them).
function scanNewBatches() {
  if (!SELF || !existsSync(FEEDBACK_DIR)) return;
  for (const f of readdirSync(FEEDBACK_DIR).filter((n) => isBatchFile(n) && !CLAIMED.test(n)).sort()) {
    if (seen.has(f)) continue;
    let b: Batch;
    try { b = JSON.parse(readFileSync(join(FEEDBACK_DIR, f), 'utf8')) as Batch; } catch { continue; /* partial write — retry next scan */ }
    const to = (b.to || '').trim();
    if (to && to !== 'any' && to !== SELF.id) { seen.add(f); continue; } // someone else's
    // Unaddressed batches are for the pinpoint review session(s) only — idle
    // sessions that merely have this MCP loaded must not claim-steal them.
    if ((!to || to === 'any') && !isHandler(SELF.label)) { seen.add(f); continue; }
    try { renameSync(join(FEEDBACK_DIR, f), join(FEEDBACK_DIR, f.replace(/\.json$/, `.claimed-${SELF.id}.json`))); }
    catch { seen.add(f); continue; } // lost the race
    seen.add(f); deliver({ ...b, claimedBy: SELF.id });
  }
}
function listSaved(limit = 20) {
  if (!existsSync(FEEDBACK_DIR)) return [];
  return readdirSync(FEEDBACK_DIR).filter(isBatchFile).sort().reverse().slice(0, limit)
    .map((f) => { const b = JSON.parse(readFileSync(join(FEEDBACK_DIR, f), 'utf8')) as Batch; return { id: b.id, receivedAt: b.receivedAt, page: b.page, pins: b.pins.length, to: b.to || 'any', claimedBy: CLAIMED.exec(f)?.[1] ?? null, worker: workers.has(b.id) || null, general: (b.general || '').slice(0, 80) }; });
}
// Per-pin progress, written into the batch file by whichever session is fixing it
// (report_pin). The overlay polls GET /api/pins/:id and renders it as a progress
// toast, so the reviewer sees pins resolve without watching the terminal.
const PIN_STATUSES: PinStatus[] = ['working', 'done', 'skipped', 'question'];
function reportPin(id: string, pin: number, status: PinStatus, note?: string) {
  const f = findSaved(id); if (!f) return { error: 'batch not found: ' + id };
  if (!PIN_STATUSES.includes(status)) return { error: `status must be one of ${PIN_STATUSES.join(', ')}` };
  const b = JSON.parse(readFileSync(f, 'utf8')) as Batch;
  // pin 0 = the general note (the only item in a note-only batch, or an extra one alongside pins)
  if (!Number.isInteger(pin) || pin < 0 || pin > b.pins.length || (pin === 0 && !(b.general || '').trim())) return { error: b.pins.length ? `pin must be 1..${b.pins.length} (or 0 for the general note)` : 'note-only batch: use pin 0' };
  b.progress = { ...(b.progress || {}), [pin]: { status, note: note ? String(note).slice(0, 200) : undefined, at: new Date().toISOString(), by: SELF?.id } };
  writeFileSync(f, JSON.stringify(b, null, 2));
  const st = batchStatus(id)!;
  log('pin progress', id, `#${pin} ${status}`, `${st.resolved}/${st.total}`);
  return st;
}
function batchStatus(id: string) {
  const f = findSaved(id); if (!f) return null;
  const b = JSON.parse(readFileSync(f, 'utf8')) as Batch;
  const claimedBy = CLAIMED.exec(basename(f))?.[1] ?? null;
  const w = workers.get(id);
  const live = claimedBy ? liveSessions().find((x) => x.id === claimedBy) : null;
  const progress = b.progress || {};
  // Items that must reach a terminal status: every pin, or just the general note (key "0") when there are no pins.
  const keys = b.pins.length ? b.pins.map((_, i) => String(i + 1)) : (b.general || '').trim() ? ['0'] : [];
  const resolved = keys.filter((k) => progress[k] && progress[k].status !== 'working').length;
  const claimedLabel = w ? `worker · ${w.rec.state}` : live?.label ?? (claimedBy && /^\d+$/.test(claimedBy) ? claudeSessionName(Number(claimedBy)) : null);
  return { id: b.id, page: b.page, receivedAt: b.receivedAt, to: b.to || 'any', claimedBy, claimedLabel, worker: w ? w.rec.state : null, total: b.pins.length, noteOnly: !b.pins.length, resolved, complete: keys.length > 0 && resolved >= keys.length, progress };
}
function findSaved(id: string): string | null {
  if (!existsSync(FEEDBACK_DIR)) return null;
  const f = readdirSync(FEEDBACK_DIR).find((n) => n === `${id}.json` || (n.startsWith(`${id}.claimed-`) && n.endsWith('.json')));
  return f ? join(FEEDBACK_DIR, f) : null;
}
mkdirSync(FEEDBACK_DIR, { recursive: true });
for (const f of readdirSync(FEEDBACK_DIR)) seen.add(f); // history is not "unread"
if (SELF) {
  try { watch(FEEDBACK_DIR, () => scanNewBatches()); } catch (e) { log('fs.watch unavailable, polling only', e); }
  setInterval(scanNewBatches, 2000).unref();
}

// ─── "/" picker: the skills and custom commands a worker can run (user + project) ──
type SkillRow = { name: string; description: string; scope: 'user' | 'project'; kind: 'skill' | 'command' | 'builtin' };
// Claude Code built-ins a stream-json worker honours when sent as a plain message (verified 2.1.263):
// /compact → status "compacting", then a system/compact_boundary line; /clear → a conversation_reset
// line and a fresh session id on the next init (the transcript file follows the init's id).
const BUILTINS: SkillRow[] = [
  { name: 'clear', description: 'Clear the conversation — the worker forgets everything so far and starts from a blank context', scope: 'user', kind: 'builtin' },
  { name: 'compact', description: 'Compact the conversation — summarise the earlier context to free tokens', scope: 'user', kind: 'builtin' },
];
// Minimal YAML frontmatter reader: key: value pairs, block scalars (| / >) and wrapped plain scalars folded onto one line.
function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text); const o: Record<string, string> = {}; if (!m) return o;
  let key = '';
  for (const l of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(l);
    if (kv) { key = kv[1]; const v = kv[2].trim(); o[key] = /^[|>][-+]?$/.test(v) ? '' : v; }
    else if (key && /^\s+\S/.test(l)) o[key] = (o[key] ? o[key] + ' ' : '') + l.trim();
  }
  for (const k of Object.keys(o)) o[k] = o[k].replace(/^["']|["']$/g, '').trim();
  return o;
}
function listSkills(): SkillRow[] {
  const out: SkillRow[] = [];
  const scan = (root: string, scope: 'user' | 'project') => {
    const sk = join(root, 'skills');
    if (existsSync(sk)) for (const name of readdirSync(sk)) { // statSync follows symlinked skill folders
      let dir = false; try { dir = statSync(join(sk, name)).isDirectory(); } catch {} if (!dir) continue; const f = join(sk, name, 'SKILL.md'); if (!existsSync(f)) continue;
      const o = frontmatter(readFileSync(f, 'utf8')); if (o['user-invocable'] === 'false') continue;
      out.push({ name: o.name || name, description: (o.description || '').slice(0, 200), scope, kind: 'skill' });
    }
    const cm = join(root, 'commands');
    if (existsSync(cm)) for (const f of readdirSync(cm)) {
      if (!f.endsWith('.md')) continue; const t = readFileSync(join(cm, f), 'utf8'); const o = frontmatter(t);
      const body = t.replace(/^---[\s\S]*?\n---\s*/, '');
      out.push({ name: f.slice(0, -3), description: (o.description || body.split('\n').find((l) => l.trim()) || '').trim().slice(0, 200), scope, kind: 'command' });
    }
  };
  scan(join(HOME, '.claude'), 'user'); scan(join(ROOT, '.claude'), 'project');
  return BUILTINS.concat(out.sort((a, b) => a.name.localeCompare(b.name)));
}

// ─── Workers: one headless Claude per batch, chat over its stdin/stdout ────────
type WState = 'starting' | 'working' | 'idle' | 'exited' | 'error';
type WorkerRec = { batchId: string; workerId: string; sessionUuid: string; page: string; title: string; state: WState; started: boolean; startedAt: string; lastAt: string; turns: number; costUsd: number; model?: string; effort?: string; exitCode?: number | null };
type ChatEvent = { t: string; at: string; [k: string]: unknown };
const workers = new Map<string, Worker>();
const rel = (p: unknown) => (typeof p === 'string' ? p.replace(ROOT + '/', '') : '');
function toolSummary(name: string, input: any): string {
  try {
    const i = input || {};
    if (name.endsWith('report_pin')) return `pin ${i.pin} → ${i.status}${i.note ? ' · ' + i.note : ''}`;
    if (name.endsWith('get_pins')) return i.id ? `batch ${i.id}` : 'unread batches';
    switch (name) {
      case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return rel(i.file_path || i.notebook_path) + (i.offset ? `:${i.offset}` : '');
      case 'Bash': return String(i.description || i.command || '').slice(0, 160);
      case 'Grep': return `${i.pattern}${i.path ? ' in ' + rel(i.path) : ''}`;
      case 'Glob': return String(i.pattern || '');
      case 'Agent': case 'Task': return String(i.description || '').slice(0, 120);
      case 'TodoWrite': return `${(i.todos || []).length} todos`;
      default: return JSON.stringify(i).slice(0, 160);
    }
  } catch { return ''; }
}
const flat = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => (x && x.type === 'text' ? x.text : '')).join('\n') : '');
const pinRows = (pins: unknown[], offset = 0) => (pins as any[]).map((p, i) => ({ n: offset + i + 1, type: p?.type || '', comment: p?.comment || '', fix: p?.fix || '', element: p?.element ? { tag: p.element.tag, path: p.element.path, text: p.element.text } : undefined, near: p?.near, rect: p?.rect, scrollY: p?.scrollY, source: p?.source && p.source.file ? { file: String(p.source.file), line: Number(p.source.line) || 0, column: Number(p.source.column) || 0 } : undefined, widget: p?.widget ? String(p.widget) : undefined, state: p?.state ?? undefined }));
function batchPrompt(b: Batch): string {
  const pins = pinRows(b.pins);
  const art = artifactPath(b.page); // set when the pins are on an open-design mockup this server serves, not on the app
  const artDir = art ? dirname(join(ROOT, '.' + art)) : '';
  const flutter = !art && flutterPage(b.page); // pins tapped on a running Flutter app via `pinpoint flutter` — pre-resolved to source
  return [
    art
      ? `You are the PINPOINT headless worker for batch ${b.id} in ${ROOT}. A reviewer pinned feedback on an open-design MOCKUP that this server serves from the repo (${art}) — not on the running app. No one is watching a terminal: work autonomously, keep every change surgical, and do not commit.`
      : flutter
      ? `You are the PINPOINT headless worker for batch ${b.id} in ${ROOT}. A reviewer tapped widgets on the running FLUTTER app (captured over the widget-inspector protocol by \`pinpoint flutter\`); every pin is pre-resolved to its source location. No one is watching a terminal: work autonomously, keep every change surgical, and do not commit.`
      : `You are the PINPOINT headless worker for batch ${b.id} in ${ROOT}. A reviewer pinned feedback on the running app. No one is watching a terminal: work autonomously, keep every change surgical, and do not commit.`,
    `Page: ${b.page}`,
    `Title: ${b.title || ''}`,
    b.viewport ? `Viewport: ${JSON.stringify(b.viewport)}` : '',
    (b.general || '').trim() ? `General note (pin 0): ${(b.general || '').trim()}` : '',
    pins.length ? `Pins (${pins.length}):\n${JSON.stringify(pins, null, 2)}` : 'No pins: the general note is the whole request. Report it as pin 0.',
    ``,
    `Workflow:`,
    art
      ? `1. This is a design artifact, not app source. Work only inside its folder (${artDir}): edit the authoring source — index.src.html when the folder has one (its README says so), otherwise the served .html — and for a Mode B bundle rebuild afterwards: cp index.src.html index.html && bun ~/.claude/skills/open-design/scripts/harden-mode-b.mjs "${artDir}". Never touch apps/* or packages/* for a mockup pin; if a pin clearly asks for the real app to change, say so and report it as "question". Each pin's "state" records the explorer layout/scenario it was drawn on — honor it. The pinpoint MCP tool get_pins { id: "${b.id}" } returns the raw batch again if you need it.`
      : flutter
      ? `1. Each pin carries "source" { file, line, column } — the tapped widget's constructor call site, from Flutter's --track-widget-creation — plus "widget" (its runtime type). Open the file at that line; the fix usually lives there or in the widget it builds. Ignore the rect (screen coordinates are not captured; sizes only) and grep only when a pin somehow lacks "source". Attached screenshots follow pin order: the k-th screenshot belongs to the k-th pin that has one. The pinpoint MCP tool get_pins { id: "${b.id}" } returns the raw batch again if you need it.`
      : `1. Resolve each pin to source. Grep the element's rendered text (not the CSS path, which is brittle) across the app that serves this route; the route narrows it to a route file plus its feature components. The pinpoint MCP tool get_pins { id: "${b.id}" } returns the raw batch again if you need it.`,
    `2. Report progress with the pinpoint MCP tool report_pin { id: "${b.id}", pin: N, status }: "working" when you start a pin, then "done", "skipped" or "question" when you finish it (question = you answered instead of building; put the answer in note, ≤200 chars). Pin 0 is the general note. Every pin must reach a terminal status.`,
    `3. Fix in place, following the repo's CLAUDE.md conventions and its own package manager. Re-read a file right before editing it and use exact-match edits; never reformat whole files.`,
    art
      ? `4. Verify only what you touched: after the rebuild, fetch the page from this server (curl -s http://127.0.0.1:${PORT}${art}) and confirm it still carries the overlay tag and no Babel/CDN script crept back in.`
      : flutter
      ? `4. Verify only what you touched: run \`dart analyze\` on the changed files (from the Flutter app's own directory). Do not run the app and do not hot reload — the reviewer's \`pinpoint flutter\` client hot-reloads the device itself once every pin has a terminal status.`
      : `4. Verify only what you touched: lint on the changed files and the workspace's type-check script.`,
    `5. Reply with a numbered list matching the pin numbers: what you understood, then what you did (or why not). Keep it short; the reviewer reads it in a chat drawer beside the page and may follow up here. If something is genuinely ambiguous, state your assumption, do the work, and say so.`,
    `6. Never open a reply with a timestamp line (e.g. *[2026-09-06 23:28:58]*), even when the project's CLAUDE.md asks for one: the drawer stamps every message itself. Put commands and code in fenced blocks; the drawer gives those a copy button.`,
    `7. To ask the reviewer to choose, end the reply with a fenced block whose language is \`question\`: the first line is the question, then one choice per line starting with "- " (2 to 6, each a short sentence that stands alone as an answer). The drawer shows the choices as buttons plus a free-text field it adds itself (so never add an "other" choice); a tap only selects, and Submit sends the answer as the reviewer's next message. Several \`question\` blocks in one reply become one stepper with a single Submit, and the answers arrive together as one line per question: "<question> \u2192 <answer>". Only when the answers genuinely coexist (surfaces to reach, features to include \u2014 never "which design" or a yes/no), use the fence \`question multi\` instead: taps toggle, and the picks arrive joined with " + " (e.g. "Desktop + Mobile"); say in the question what picking several means. Decide per question; single-pick is the default. Never lay choices out as A/B/C prose or ask them to type a letter.`,
  ].filter((l) => l !== undefined).join('\n');
}
// Pins sent from the chat drawer into an existing conversation are appended to the saved batch,
// so they number on from the originals and get_pins / report_pin / the progress card all see them.
type PinAppend = { first: number; count: number; total: number; rows: unknown[] };
function appendPins(id: string, raw: unknown): PinAppend {
  const list = Array.isArray(raw) ? raw.filter((p) => p && typeof p === 'object') : [];
  if (!list.length) return { first: 0, count: 0, total: 0, rows: [] };
  const f = findSaved(id); if (!f) throw new PinError(404, 'batch not found: ' + id, 'Its file is gone from the feedback dir — start a new conversation.');
  const b = JSON.parse(readFileSync(f, 'utf8')) as Batch;
  const first = b.pins.length + 1;
  b.pins = [...b.pins, ...list];
  writeFileSync(f, JSON.stringify(b, null, 2));
  return { first, count: list.length, total: b.pins.length, rows: pinRows(list, first - 1) };
}
// /clear forgets the batch's pins as well (Robin, 2026-09-07): the next pins from the drawer start at
// #1 again and the progress card / conversation picker stop counting the forgotten ones. The general
// note stays as the batch's origin record; the chat.jsonl still holds the old pins' text. Returns how
// many pins were dropped.
function resetPins(id: string): number {
  const f = findSaved(id); if (!f) return 0;
  const b = JSON.parse(readFileSync(f, 'utf8')) as Batch;
  const n = b.pins.length;
  if (n || b.progress) { b.pins = []; delete b.progress; writeFileSync(f, JSON.stringify(b, null, 2)); }
  return n;
}
function followUpPrompt(text: string, id: string, a: PinAppend): string {
  const last = a.first + a.count - 1;
  const range = `#${a.first}${a.count > 1 ? '–#' + last : ''}`;
  // first === 1: the batch had no pins before (note-only start, or /clear forgot them) — nothing to number on from.
  const where = a.first === 1 ? `the first pin${a.count === 1 ? '' : 's'} of batch ${id} in this conversation (${a.total} in total)` : `added to batch ${id}, numbered on from the originals (now ${a.total} in total)`;
  return [
    text,
    ``,
    `${a.count} new pin${a.count === 1 ? '' : 's'} (${range}), ${where}. Treat them like the first batch: resolve each to source, report_pin { id: "${id}", pin: N, status } ("working", then "done" / "skipped" / "question"), fix in place, verify what you touched, and reply by pin number.`,
    JSON.stringify(a.rows, null, 2),
  ].join('\n');
}
// Screenshots from the drawer: saved under workers/<batch>/img-*.ext (served back at
// /api/chat/:id/img/<file> for the transcript) and handed to the worker as inline image
// blocks, with the saved path in the text so it can Read the file if it needs to zoom.
type ImgRef = { url: string; name: string; type: string; bytes: number; file: string; img?: boolean };
type UserContent = string | Array<Record<string, unknown>>;
const IMG_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
// A screenshot travels inline as an image block, because that is the only way the model can look at
// it. Anything else — a log, a CSV, a PDF, a .tsx — is written beside the transcript and named in the
// prompt: the worker has Read, so a path costs nothing and keeps a 3 MB file out of the context.
const safeExt = (name: string) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || ''); return m ? m[1].toLowerCase() : 'bin'; };
function saveFiles(batchId: string, raw: unknown): { refs: ImgRef[]; blocks: Array<Record<string, unknown>> } {
  const list = Array.isArray(raw) ? raw.slice(0, 6) : [];
  const dir = join(WORKERS_DIR, batchId); const refs: ImgRef[] = []; const blocks: Array<Record<string, unknown>> = [];
  list.forEach((im: any, i: number) => {
    const type = String(im?.type || ''); const data = String(im?.data || '').replace(/^data:[^,]*,/, '');
    if (!data || data.length > 8_000_000) return; // ~6 MB decoded, image or not
    const name = String(im?.name || '').slice(0, 80);
    const img = Boolean(IMG_EXT[type]);
    mkdirSync(dir, { recursive: true });
    const file = `${img ? 'img' : 'file'}-${Date.now()}-${i}.${img ? IMG_EXT[type] : safeExt(name)}`;
    const bytes = Buffer.from(data, 'base64');
    writeFileSync(join(dir, file), bytes);
    refs.push({ url: `/api/chat/${encodeURIComponent(batchId)}/img/${file}`, name: name || file, type, bytes: bytes.length, file: join(dir, file), img });
    if (img) blocks.push({ type: 'image', source: { type: 'base64', media_type: type, data } });
  });
  return { refs, blocks };
}
const withImages = (text: string, refs: ImgRef[], blocks: Array<Record<string, unknown>>): UserContent => {
  if (!refs.length) return text;
  const shots = refs.filter((r) => r.img !== false && IMG_EXT[r.type]);
  const files = refs.filter((r) => !shots.includes(r));
  const notes = [
    shots.length ? `${shots.length} screenshot${shots.length === 1 ? '' : 's'} attached inline; also saved at: ${shots.map((r) => r.file).join(', ')} — Read a path if you need to zoom in.` : '',
    files.length ? `${files.length} file${files.length === 1 ? '' : 's'} attached, saved at: ${files.map((r) => `${r.file} (${r.name})`).join(', ')} — Read them.` : '',
  ].filter(Boolean);
  return [{ type: 'text', text: `${text}\n\n(${notes.join(' ')})` }, ...blocks];
};
const publicRefs = (refs: ImgRef[]) => refs.map(({ url, name, type, bytes, img }) => ({ url, name, type, bytes, img: img !== false && Boolean(IMG_EXT[type]) }));
class Worker {
  proc: ReturnType<typeof Bun.spawn> | null = null;
  private announced = false; // "worker ready" once per process, not once per turn
  subs = new Set<(e: ChatEvent) => void>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private recapAsked = false; // one final-recap prompt per idle stretch, never a loop
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false; // stdin already closed: the exit is on its way, do not ask twice
  private spawnedModel = ''; // the --model this process actually started with
  private spawnedEffort = ''; // ditto --effort: both only change on a restart
  private inflight = 0; // messages written but not yet answered — never end a process holding one
  private queue: UserContent[] = [];
  closed = false; // closed from the picker: the record parks as <id>.json.closed so loadWorkers() skips it; transcript + images stay
  constructor(public rec: WorkerRec) { this.saveRec(); }
  get chatFile() { return join(WORKERS_DIR, `${this.rec.batchId}.chat.jsonl`); }
  get recFile() { return join(WORKERS_DIR, `${this.rec.batchId}.json${this.closed ? '.closed' : ''}`); }
  saveRec() { mkdirSync(WORKERS_DIR, { recursive: true }); writeFileSync(this.recFile, JSON.stringify(this.rec, null, 2)); }
  history(): ChatEvent[] { try { return readFileSync(this.chatFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
  emit(e: { t: string; [k: string]: unknown }) {
    const ev: ChatEvent = { at: new Date().toISOString(), ...e } as ChatEvent;
    appendFileSync(this.chatFile, JSON.stringify(ev) + '\n');
    this.rec.lastAt = ev.at;
    for (const s of this.subs) { try { s(ev); } catch {} }
  }
  setState(state: WState, extra?: Record<string, unknown>) { this.rec.state = state; this.saveRec(); this.emit({ t: 'status', state, ...(extra || {}) }); }
  /** Reviewer message (+ screenshots, + pins already appended to this batch): echoed to the transcript, then fed to the worker (spawning / resuming it if needed). */
  send(text: string, images?: unknown, pins?: PinAppend) {
    this.recapAsked = false; // a real message: this conversation earns another recap when it next goes quiet
    const { refs, blocks } = saveFiles(this.rec.batchId, images);
    const withPins = Boolean(pins && pins.count > 0);
    this.emit({ t: 'user', text, images: publicRefs(refs), ...(withPins ? { pins: { first: pins!.first, count: pins!.count } } : {}) });
    this.sendRaw(withImages(withPins ? followUpPrompt(text, this.rec.batchId, pins!) : text, refs, blocks));
  }
  sendRaw(content: UserContent) {
    this.clearIdle();
    // A model change lands on the next process: queue the message, end this one, and let the
    // exit handler resume the same Claude session with the new --model. Only while nothing is in
    // flight — a turn in progress (or a message already handed over) is never thrown away.
    if (this.proc && this.stalePicks() && !this.inflight) { this.queue.push(content); this.stop(this.spawnedModel === (this.rec.model || '') ? 'effort change' : 'model change'); return; }
    if (!this.proc) { this.queue.push(content); this.start(this.rec.started); return; }
    if (this.rec.state !== 'working') this.setState('working');
    this.write(content);
  }
  private write(content: UserContent) {
    if (!this.proc) return;
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
    try { (this.proc.stdin as any).write(line); (this.proc.stdin as any).flush(); this.inflight += 1; } catch (e) { this.emit({ t: 'error', text: `stdin write failed: ${String((e as any)?.message || e)}` }); }
  }
  start(resume: boolean) {
    if (this.proc) return;
    maybeCheckUpdate(); // a spawn is when someone is looking; every 4 hours at most, never waits
    if (!existsSync(CLAUDE_BIN)) { this.setState('error', { text: `claude binary not found at ${CLAUDE_BIN} — set claudeBin in .pinpoint.json or PINPOINT_CLAUDE` }); return; }
    const args = [CLAUDE_BIN, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '-n', `pin-${this.rec.batchId.slice(-24)}`];
    args.push(resume ? '--resume' : '--session-id', this.rec.sessionUuid);
    if (WORKER_MCP === 'pinpoint') { writeWorkerMcpCfg(); args.push('--strict-mcp-config', '--mcp-config', WORKER_MCP_CFG); }
    this.spawnedModel = this.rec.model || '';
    if (this.spawnedModel) args.push('--model', this.spawnedModel);
    this.spawnedEffort = this.rec.effort || '';
    if (this.spawnedEffort) args.push('--effort', this.spawnedEffort);
    args.push(...WORKER_ARGS);
    try {
      this.proc = Bun.spawn(args, {
        cwd: ROOT,
        env: { ...process.env, PINPOINT_ROOT: ROOT, PINPOINT_SESSION_ID: this.rec.workerId, PINPOINT_SESSION: `worker:${this.rec.batchId}` },
        stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      });
    } catch (e) { this.proc = null; this.setState('error', { text: `spawn failed: ${String((e as any)?.message || e)}` }); return; }
    this.rec.started = true; this.announced = false; this.stopping = false; this.inflight = 0;
    this.setState('starting', { resume, pid: this.proc.pid });
    log(`worker ${this.rec.workerId} ${resume ? 'resumed' : 'started'} pid ${this.proc.pid} for ${this.rec.batchId}`);
    void this.pump(this.proc.stdout as ReadableStream<Uint8Array>, (l) => this.onLine(l));
    void this.pump(this.proc.stderr as ReadableStream<Uint8Array>, (l) => { if (l.trim() && !/^\s*$/.test(l)) this.emit({ t: 'stderr', text: l.slice(0, 400) }); });
    const p = this.proc;
    p.exited.then((code) => {
      if (this.proc !== p) return;
      this.proc = null; this.clearIdle(); if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null; }
      this.rec.exitCode = code;
      const clean = code === 0 || this.rec.state === 'idle';
      this.setState(clean ? 'exited' : 'error', { code });
      log(`worker ${this.rec.workerId} exited ${code}`);
      if (this.queue.length) this.start(true); // a message arrived while it was shutting down
    });
    for (const q of this.queue.splice(0)) this.write(q);
  }
  private async pump(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void) {
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of stream as any) {
        buf += dec.decode(chunk, { stream: true }); let i;
        while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onLine(l); }
      }
    } catch {}
    if (buf.trim()) onLine(buf);
  }
  private onLine(line: string) {
    let m: any; try { m = JSON.parse(line); } catch { this.emit({ t: 'stderr', text: line.slice(0, 400) }); return; }
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') { // one init per turn: announce only the first after a (re)start
          if (typeof m.session_id === 'string') this.rec.sessionUuid = m.session_id;
          if (!this.announced) { this.announced = true; this.setState('working', { model: m.model, ready: true }); } else if (this.rec.state !== 'working') this.setState('working');
        } else if (m.subtype === 'compact_boundary') { // /compact (or auto-compaction) finished
          const c = m.compact_metadata || {};
          this.emit({ t: 'status', state: this.rec.state, compacted: true, pre: Number(c.pre_tokens) || 0, post: Number(c.post_tokens) || 0 });
        }
        break;
      case 'conversation_reset': // /clear — the next system/init carries the new session id, which is the one --resume needs
        this.emit({ t: 'status', state: this.rec.state, reset: true, pins: resetPins(this.rec.batchId) }); // pins: how many the batch forgot with it
        break;
      case 'assistant':
        for (const c of m.message?.content ?? []) {
          if (c.type === 'text' && String(c.text || '').trim()) this.emit({ t: 'assistant', text: c.text });
          else if (c.type === 'tool_use') this.emit({ t: 'tool', name: c.name, summary: toolSummary(String(c.name), c.input) });
        }
        break;
      case 'user': // tool results echo back as user turns; surface only failures
        for (const c of Array.isArray(m.message?.content) ? m.message.content : []) if (c.type === 'tool_result' && c.is_error) this.emit({ t: 'tool_error', text: flat(c.content).slice(0, 300) });
        break;
      case 'result':
        this.rec.turns += 1; this.rec.costUsd += Number(m.total_cost_usd || 0); this.inflight = Math.max(0, this.inflight - 1);
        this.emit({ t: 'result', ok: !m.is_error, subtype: m.subtype, ms: m.duration_ms, cost: m.total_cost_usd, turns: m.num_turns, text: m.is_error ? String(m.result || m.error || 'error') : '' });
        this.setState('idle');
        if (this.recapAsked) this.stop('idle timeout'); else this.armIdle(); // the recap was the last turn
        this.applyPicks(); // picked mid-turn: end the process now so the next message starts on it
        break;
      default: break; // hooks, rate limits, partials
    }
  }
  private armIdle() { this.clearIdle(); this.idleTimer = setTimeout(() => this.idleOut(), WORKER_IDLE_MS); }
  /** Idle for long enough to close: ask for a recap first so the reviewer comes back to where things
   *  stand, then exit when that turn's `result` lands (or when the grace runs out). */
  private idleOut() {
    if (!RECAP_ON_IDLE || !this.proc || this.recapAsked || this.inflight || !this.rec.turns) { this.stop('idle timeout'); return; }
    this.recapAsked = true;
    this.emit({ t: 'status', state: this.rec.state, recap: true }); // the drawer explains the turn that just started
    log(`worker ${this.rec.workerId} idle — asking for a recap before exit`);
    this.sendRaw(RECAP_PROMPT); // not send(): a prompt the reviewer did not type does not belong in the transcript as theirs
    this.clearIdle(); this.idleTimer = setTimeout(() => this.stop('idle timeout'), RECAP_GRACE_MS);
  }
  private clearIdle() { if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; } }
  /** Pick the Claude this conversation runs. The live process keeps the model it was spawned with,
   *  so the switch lands on the next one — which resumes the same session, losing nothing. */
  setModel(model: string) {
    const next = (model || '').trim();
    if (!isModel(next)) throw new PinError(400, `Unknown model ${next}`, `This server offers: ${modelIds()} — add others to worker.models in .pinpoint.json.`);
    if ((this.rec.model || '') === next) return;
    this.rec.model = next; this.saveRec();
    this.emit({ t: 'status', state: this.rec.state, model: next, modelSet: true });
    log(`worker ${this.rec.workerId} model → ${next || '(default)'}`);
    this.applyPicks();
  }
  /** How hard it thinks. Same deal as the model: the live process keeps what it was spawned with. */
  setEffort(effort: string) {
    const next = (effort || '').trim();
    if (!isEffort(next)) throw new PinError(400, `Unknown effort ${next}`, `This server offers: ${effortIds()}.`);
    if ((this.rec.effort || '') === next) return;
    this.rec.effort = next; this.saveRec();
    this.emit({ t: 'status', state: this.rec.state, effort: next, effortSet: true });
    log(`worker ${this.rec.workerId} effort → ${next || '(default)'}`);
    this.applyPicks();
  }
  private stalePicks() { return this.spawnedModel !== (this.rec.model || '') || this.spawnedEffort !== (this.rec.effort || ''); }
  /** End an idle process whose model or effort is stale, so the restart cost is paid while the reviewer
   *  types rather than after they hit send. Mid-turn work is never interrupted: `result` calls this again. */
  private applyPicks() {
    if (!this.proc || !this.stalePicks() || this.inflight) return;
    this.stop(this.spawnedModel === (this.rec.model || '') ? 'effort change' : 'model change');
  }
  /** Close stdin so Claude ends the conversation; a later message resumes it by session id. */
  stop(reason: string) {
    this.clearIdle();
    if (!this.proc || this.stopping) return;
    this.stopping = true;
    this.emit({ t: 'status', state: this.rec.state, stopping: reason });
    const p = this.proc;
    try { (p.stdin as any).end(); } catch {}
    this.killTimer = setTimeout(() => { if (this.proc === p) { try { p.kill(); } catch {} } }, 15_000);
  }
  /** Close the conversation for good: end the process (if any), drop it from /api/chat and park the record so a restart does not bring it back. */
  close(reason: string) {
    this.stop(reason);
    const live = this.recFile; this.closed = true;
    try { if (existsSync(live)) renameSync(live, this.recFile); else this.saveRec(); } catch {}
    workers.delete(this.rec.batchId);
    this.emit({ t: 'status', state: this.rec.state, closed: true });
    log(`worker ${this.rec.workerId} closed ${this.rec.batchId}`);
  }
  /** Continue in a terminal: end the process (if any) and post the `claude --resume` command for this conversation's
   *  Claude session into the transcript (persisted, so it survives a reload). One process per session — once a
   *  terminal has it, a message here would resume the same session under a new worker. */
  handoff(): { command: string; cwd: string; session: string } {
    this.stop('handed off to a terminal');
    const cwd = /^[\w./-]+$/.test(ROOT) ? ROOT : `'${ROOT.replace(/'/g, "'\\''")}'`;
    const h = { command: `cd ${cwd} && claude --resume ${this.rec.sessionUuid}`, cwd: ROOT, session: this.rec.sessionUuid };
    this.emit({ t: 'status', state: this.rec.state, handoff: true, ...h });
    log(`worker ${this.rec.workerId} handed off ${this.rec.batchId} to a terminal (${this.rec.sessionUuid})`);
    return h;
  }
}
// Workers load only this MCP (fast start, no unrelated servers) unless worker.mcp = "all".
function writeWorkerMcpCfg() { mkdirSync(WORKERS_DIR, { recursive: true }); writeFileSync(WORKER_MCP_CFG, JSON.stringify({ mcpServers: { pinpoint: { command: process.execPath, args: [import.meta.path], env: { PINPOINT_ROOT: ROOT } } } }, null, 2)); }
function loadWorkers() {
  if (!existsSync(WORKERS_DIR)) return;
  for (const f of readdirSync(WORKERS_DIR).filter((n) => n.endsWith('.json') && n !== 'mcp.json')) {
    try {
      const rec = JSON.parse(readFileSync(join(WORKERS_DIR, f), 'utf8')) as WorkerRec;
      if (!rec.batchId || workers.has(rec.batchId)) continue;
      if (rec.state !== 'error') rec.state = 'exited'; // the process died with the previous server; a message resumes it
      workers.set(rec.batchId, new Worker(rec));
    } catch {}
  }
}
function listChats() {
  return [...workers.values()].sort((a, b) => (a.rec.lastAt < b.rec.lastAt ? 1 : -1)).map((w) => {
    let pins = 0, general = '';
    try { const f = findSaved(w.rec.batchId); if (f) { const b = JSON.parse(readFileSync(f, 'utf8')) as Batch; pins = b.pins.length; general = (b.general || '').slice(0, 120); } } catch {}
    return { id: w.rec.batchId, page: w.rec.page, title: w.rec.title, state: w.rec.state, session: w.rec.sessionUuid, model: w.rec.model || '', effort: w.rec.effort || '', startedAt: w.rec.startedAt, lastAt: w.rec.lastAt, turns: w.rec.turns, costUsd: Math.round(w.rec.costUsd * 1000) / 1000, pins, general };
  });
}
function sse(w: Worker, req: Request, headers: Record<string, string>) {
  let sub: ((e: ChatEvent) => void) | null = null; let hb: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      const push = (e: unknown) => { try { c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch {} };
      c.enqueue(enc.encode('retry: 2000\n\n'));
      for (const e of w.history()) push(e);
      push({ t: 'sync', at: new Date().toISOString(), state: w.rec.state });
      sub = push; w.subs.add(sub);
      hb = setInterval(() => { try { c.enqueue(enc.encode(': hb\n\n')); } catch {} }, 20_000);
      req.signal.addEventListener('abort', () => { if (sub) w.subs.delete(sub); if (hb) clearInterval(hb); try { c.close(); } catch {} });
    },
    cancel() { if (sub) w.subs.delete(sub); if (hb) clearInterval(hb); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...headers } });
}

// ─── HTTP face (first session owns it; others run MCP-only and read the dir) ──
// Browser callers must come from the project's own app origins (or localhost). Non-browser
// callers (curl, `pinpoint report`) send no Origin and pass. A worker runs with permission
// prompts skipped, so a foreign page must never be able to post pins or chat into it.
const APP_ORIGINS = new Set(PROJECT.origins);
function originOk(o: string | null): boolean {
  if (!o) return true;
  if (APP_ORIGINS.has(o)) return true;
  try { const h = new URL(o).hostname; return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost'); } catch { return false; }
}
const corsFor = (req: Request) => ({ 'Access-Control-Allow-Origin': req.headers.get('origin') || '*', Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
let httpOwner = true;
try {
  Bun.serve({
    port: PORT, hostname: '127.0.0.1', idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/pinpoint.js') return new Response(overlay(), { headers: { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' } });
      const origin = req.headers.get('origin');
      if (!originOk(origin)) { log('refused origin', origin, url.pathname); return new Response('forbidden origin', { status: 403 }); }
      const CORS = corsFor(req);
      if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
      if (req.method === 'GET') { const art = serveArtifact(url.pathname); if (art) return art; }
      if (url.pathname === '/flutter' && req.method === 'GET') return serveFlutterPanel();
      if (url.pathname === '/api/flutter/events' && req.method === 'GET') return flutterSse(req, CORS);
      if (url.pathname === '/api/flutter/taps' && req.method === 'POST') {
        const j = await req.json().catch(() => null);
        const src = j?.source;
        if (!src || typeof src.file !== 'string' || !src.file) return Response.json({ ok: false, error: 'source.file required' }, { status: 400, headers: CORS });
        const shot = j?.screenshot;
        const okShot = shot && IMG_EXT[String(shot.type)] && typeof shot.data === 'string' && shot.data.length > 0 && shot.data.length <= 3_000_000; // ~2 MB decoded
        const tap: FlutterTap = {
          n: flutterBus.nextTap++,
          widget: String(j?.widget || '').slice(0, 120),
          source: { file: String(src.file).slice(0, 500), line: Number(src.line) || 0, column: Number(src.column) || 0 },
          rect: j?.rect,
          screenshot: okShot ? { type: String(shot.type), data: String(shot.data) } : null,
          at: new Date().toISOString(),
        };
        flutterBus.taps.push(tap);
        if (flutterBus.taps.length > FLUTTER_TAP_MAX) flutterBus.taps.splice(0, flutterBus.taps.length - FLUTTER_TAP_MAX);
        flutterBus.emit({ t: 'tap', tap });
        log('flutter tap', `#${tap.n}`, tap.widget, `${tap.source.file}:${tap.source.line}`);
        return Response.json({ ok: true, n: tap.n }, { headers: CORS });
      }
      if (url.pathname === '/api/flutter/status' && req.method === 'POST') {
        const j = await req.json().catch(() => ({}));
        if (j?.t === 'client') { flutterBus.client = { connected: Boolean(j.connected), app: String(j.app || '').slice(0, 120) }; flutterBus.emit({ t: 'client', ...flutterBus.client }); }
        else if (j?.t === 'reloaded') flutterBus.emit({ t: 'reloaded', id: String(j.id || ''), ok: j.ok !== false, ...(j.error ? { error: String(j.error).slice(0, 200) } : {}) });
        else return Response.json({ ok: false, error: 't must be "client" or "reloaded"' }, { status: 400, headers: CORS });
        return Response.json({ ok: true }, { headers: CORS });
      }
      if (url.pathname === '/api/flutter/select' && req.method === 'POST') {
        const j = await req.json().catch(() => ({}));
        flutterBus.emit({ t: 'select', on: Boolean(j?.on) });
        return Response.json({ ok: true }, { headers: CORS });
      }
      if (url.pathname === '/api/flutter/clear' && req.method === 'POST') {
        flutterBus.taps = []; flutterBus.nextTap = 1;
        flutterBus.emit({ t: 'cleared' });
        return Response.json({ ok: true }, { headers: CORS });
      }
      if (url.pathname === '/api/health') return Response.json({ ok: true, root: ROOT, port: PORT, project: PROJECT.file ?? null, name: PROJECT_NAME, dispatch: DISPATCH, claudeBin: CLAUDE_BIN, requiredSession: STRICT ? REQUIRED_SESSION : null, feedbackDir: FEEDBACK_DIR, model: DEFAULT_MODEL, models: MODELS, effort: DEFAULT_EFFORT, efforts: EFFORTS, sessions: liveSessions().length, handlers: handlers().length, workers: [...workers.values()].filter((w) => w.proc).length, update }, { headers: CORS });
      if (url.pathname === '/api/skills' && req.method === 'GET') return Response.json(listSkills(), { headers: CORS });
      if (url.pathname === '/api/look') {
        if (req.method === 'GET') return Response.json(savedLook() ?? {}, { headers: CORS });
        if (req.method === 'POST') {
          const j = await req.json().catch(() => null);
          if (!j || typeof j !== 'object' || Array.isArray(j)) return Response.json({ ok: false, error: 'Look must be an object' }, { status: 400, headers: CORS });
          const body = JSON.stringify(j, null, 2);
          // Every /pinpoint.js response carries this blob, so a runaway one would bloat every page load.
          if (body.length > LOOK_MAX) return Response.json({ ok: false, error: `Look must be under ${LOOK_MAX} bytes` }, { status: 413, headers: CORS });
          mkdirSync(dirname(LOOK_FILE), { recursive: true }); writeFileSync(LOOK_FILE, body);
          return Response.json({ ok: true }, { headers: CORS });
        }
      }
      if (url.pathname === '/api/pins' && req.method === 'POST') {
        try { const b = receive(await req.json()); return Response.json({ ok: true, id: b.id, worker: Boolean((b as any).worker) }, { headers: CORS }); }
        catch (e: any) { const st = e instanceof PinError ? e.status : 500; log('pins refused', st, e?.message); return Response.json({ ok: false, error: String(e?.message || e), hint: e?.hint ?? null, requiredSession: STRICT ? REQUIRED_SESSION : null }, { status: st, headers: CORS }); }
      }
      const m = /^\/api\/pins\/([^/]+)$/.exec(url.pathname);
      if (m && req.method === 'GET') { const st = batchStatus(decodeURIComponent(m[1])); return st ? Response.json(st, { headers: CORS }) : Response.json({ error: 'not found' }, { status: 404, headers: CORS }); }
      if (url.pathname === '/api/sessions' && req.method === 'GET') return Response.json((STRICT ? handlers() : liveSessions()).map(({ id, label, cwd }) => ({ id, label, cwd })), { headers: CORS });
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const s = await req.json();
        if (typeof s.id === 'string' && typeof s.label === 'string') upsertSession({ id: s.id, label: s.label, cwd: String(s.cwd || '') });
        return Response.json({ ok: true }, { headers: CORS });
      }
      if (url.pathname === '/api/chat' && req.method === 'GET') return Response.json(listChats(), { headers: CORS });
      const cm = /^\/api\/chat\/([^/]+)(?:\/(events|stop|close|handoff|model|effort)|\/img\/([^/]+))?$/.exec(url.pathname);
      if (cm) {
        const id = decodeURIComponent(cm[1]);
        const w = workers.get(id);
        if (!w) return Response.json({ error: 'no worker for this batch', hint: 'It was handled by a Claude session instead of a headless worker, or the batch id is wrong.' }, { status: 404, headers: CORS });
        if (cm[3] && req.method === 'GET') {
          const file = basename(decodeURIComponent(cm[3]));
          const path = join(WORKERS_DIR, id, file);
          if (!/^(img|file)-[\w.-]+$/.test(file) || !existsSync(path)) return new Response('not found', { status: 404, headers: CORS });
          // A screenshot renders in an <img>; anything else is handed back as a download. Serving an
          // attached .html or .svg with its own content type would run the reviewer's file as script
          // on this origin — the one the overlay and the API live on.
          const asFile = !file.startsWith('img-');
          return new Response(Bun.file(path), { headers: { ...CORS, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', ...(asFile ? { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${file}"` } : {}) } });
        }
        if (cm[2] === 'events' && req.method === 'GET') return sse(w, req, CORS);
        if (cm[2] === 'stop' && req.method === 'POST') { w.stop('stopped from the overlay'); return Response.json({ ok: true }, { headers: CORS }); }
        if (cm[2] === 'close' && req.method === 'POST') { w.close('closed from the overlay'); return Response.json({ ok: true }, { headers: CORS }); }
        if (cm[2] === 'handoff' && req.method === 'POST') return Response.json({ ok: true, ...w.handoff() }, { headers: CORS });
        if (cm[2] === 'model' && req.method === 'POST') {
          const j = await req.json().catch(() => ({}));
          try { w.setModel(String(j?.model ?? '')); return Response.json({ ok: true, model: w.rec.model || '', state: w.rec.state }, { headers: CORS }); }
          catch (e: any) { const st = e instanceof PinError ? e.status : 500; return Response.json({ ok: false, error: String(e?.message || e), hint: e?.hint ?? null, models: MODELS }, { status: st, headers: CORS }); }
        }
        if (cm[2] === 'effort' && req.method === 'POST') {
          const j = await req.json().catch(() => ({}));
          try { w.setEffort(String(j?.effort ?? '')); return Response.json({ ok: true, effort: w.rec.effort || '', state: w.rec.state }, { headers: CORS }); }
          catch (e: any) { const st = e instanceof PinError ? e.status : 500; return Response.json({ ok: false, error: String(e?.message || e), hint: e?.hint ?? null, efforts: EFFORTS }, { status: st, headers: CORS }); }
        }
        if (!cm[2] && req.method === 'POST') {
          const j = await req.json().catch(() => ({}));
          const text = String(j?.text ?? '').trim();
          const hasImages = Array.isArray(j?.images) && j.images.length > 0;
          const hasPins = Array.isArray(j?.pins) && j.pins.length > 0;
          if (!text && !hasImages && !hasPins) return Response.json({ error: 'text, images or pins required' }, { status: 400, headers: CORS });
          try {
            if (typeof j?.model === 'string') w.setModel(j.model); // the pill moved while the message was being typed
            if (typeof j?.effort === 'string') w.setEffort(j.effort);
            const added = appendPins(id, j?.pins); // pins from the drawer join this batch before the worker hears about them
            w.send((text || (added.count ? 'See the new pins.' : 'See the attached screenshot.')).slice(0, 20_000), j?.images, added);
            return Response.json({ ok: true, state: w.rec.state, pins: added.count, total: added.total }, { headers: CORS });
          } catch (e: any) { const st = e instanceof PinError ? e.status : 500; log('chat refused', st, e?.message); return Response.json({ ok: false, error: String(e?.message || e), hint: e?.hint ?? null }, { status: st, headers: CORS }); }
        }
      }
      return new Response('not found', { status: 404, headers: CORS });
    },
  });
} catch { httpOwner = false; log(`port ${PORT} in use (this project's pinpoint owner) — MCP-only follower; reading ${FEEDBACK_DIR}`); }
if (httpOwner) {
  log(`http://127.0.0.1:${PORT}  pins → ${FEEDBACK_DIR}  dispatch=${DISPATCH}`);
  writeWorkerMcpCfg();
  loadWorkers();
  maybeCheckUpdate();
  if (DISPATCH === 'worker' && !existsSync(CLAUDE_BIN)) log(`WARNING: claude binary not found at ${CLAUDE_BIN}; worker dispatch will fail (set claudeBin in .pinpoint.json)`);
}
if (SELF) {
  log(`session ${SELF.id} "${SELF.label}"`);
  const heartbeat = () => {
    if (httpOwner) { upsertSession(SELF); return; }
    fetch(`http://127.0.0.1:${PORT}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(SELF) }).catch(() => {});
  };
  heartbeat();
  setInterval(heartbeat, 15_000).unref();
}

// ─── MCP face ─────────────────────────────────────────────────────────────────
const DISPATCH_NOTE = DISPATCH === 'worker' ? ` This project dispatches batches to headless workers by default; only batches explicitly addressed to this session (To: picker) arrive here.` : '';
const TOOLS = [
  { name: 'wait_for_pins', description: 'Block until the user presses "Send to Claude" in the PINPOINT overlay on a live app page or on an open-design mockup this server serves (or until timeout_seconds elapses). Returns the batch: page URL (route), general note, and pins (rect, element path/text, type, comment, fix). Resolve each pin to its source component, fix in place, reply by pin number.' + DISPATCH_NOTE,
    inputSchema: { type: 'object', properties: { timeout_seconds: { type: 'number', description: 'Max seconds to wait (default 240).' } } } },
  { name: 'get_pins', description: 'Return unread pin batches immediately (non-blocking), or one saved batch by id (headless workers fetch their batch this way).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'list_pins', description: 'List saved pin batches (newest first): id, page, pin count, who it was addressed to, who claimed it, whether a headless worker owns it. Unclaimed batches addressed to a gone session can be fetched with get_pins by id.', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'list_sessions', description: 'This session\'s id + label, the project\'s dispatch mode, and every live pinpoint session the overlay can address ("To:" picker).', inputSchema: { type: 'object', properties: {} } },
  { name: 'report_pin', description: 'Report progress on one pin of a batch so the PINPOINT overlay\'s progress toast updates in the browser. Call with status "working" when you start a pin and "done" / "skipped" / "question" when you finish it (question = you answered instead of building). pin is the 1-based on-screen number; pin 0 = the general note (required for a note-only batch).',
    inputSchema: { type: 'object', required: ['id', 'pin', 'status'], properties: { id: { type: 'string', description: 'Batch id (from wait_for_pins / get_pins).' }, pin: { type: 'number', description: '1-based pin number.' }, status: { type: 'string', enum: ['working', 'done', 'skipped', 'question'] }, note: { type: 'string', description: 'Optional one-liner shown on hover (≤200 chars).' } } } },
];
const sessionInfo = () => ({ self: SELF, requiredSession: STRICT ? REQUIRED_SESSION : null, dispatch: DISPATCH, selfIsHandler: SELF ? isHandler(SELF.label) : null });
function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'wait_for_pins': {
      if (STRICT && SELF && !isHandler(SELF.label)) return Promise.resolve({ notHandler: true, session: SELF.label, requiredSession: REQUIRED_SESSION, dispatch: DISPATCH, hint: `This session will not receive ${PROJECT_NAME} pins: installed projects deliver only to a session named ${REQUIRED_SESSION}${DISPATCH === 'worker' ? ', and this project dispatches to headless workers by default (the reviewer must pick this session in the To: picker)' : ''}. Run /rename ${REQUIRED_SESSION} (the label is re-read live, no restart), then call wait_for_pins again.` });
      if (pending.length) return Promise.resolve(pending.shift());
      const t = Math.min(Number(args.timeout_seconds ?? 240), 3600) * 1000;
      return new Promise((res) => {
        const w = (b: Batch | null) => { clearTimeout(timer); res(b ?? { timedOut: true, dispatch: DISPATCH, hint: 'No pins yet — call wait_for_pins again or ask the user.' + DISPATCH_NOTE }); };
        const timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); w(null); }, t);
        waiters.push(w);
      });
    }
    case 'get_pins': {
      if (args.id) { const f = findSaved(String(args.id)); return Promise.resolve(f ? JSON.parse(readFileSync(f, 'utf8')) : { error: 'not found' }); }
      const out = pending.splice(0, pending.length);
      return Promise.resolve(out.length ? out : { unread: 0, hint: 'Nothing unread. list_pins shows saved batches.' + DISPATCH_NOTE });
    }
    case 'list_pins': return Promise.resolve(listSaved(Number(args.limit ?? 20)));
    case 'report_pin': return Promise.resolve(reportPin(String(args.id), Number(args.pin), String(args.status) as PinStatus, args.note == null ? undefined : String(args.note)));
    case 'list_sessions': {
      if (httpOwner) return Promise.resolve({ ...sessionInfo(), sessions: liveSessions().map(({ id, label, cwd }) => ({ id, label, cwd })) });
      return fetch(`http://127.0.0.1:${PORT}/api/sessions`).then((r) => r.json()).then((sessions) => ({ ...sessionInfo(), sessions })).catch(() => ({ ...sessionInfo(), sessions: [], hint: 'HTTP owner unreachable' }));
    }
    default: return Promise.reject(new Error(`unknown tool ${name}`));
  }
}
const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
async function handle(msg: any) {
  const { id, method, params } = msg;
  const reply = (result: unknown) => id !== undefined && write({ jsonrpc: '2.0', id, result });
  try {
    switch (method) {
      case 'initialize': return reply({ protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'pinpoint', version: pkg.version } });
      case 'notifications/initialized': return;
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': { const r = await callTool(params.name, params.arguments || {}); return reply({ content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }); }
      default: if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e: any) { if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } }); }
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk; let i;
  while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { void handle(JSON.parse(line)); } catch { log('bad json', line.slice(0, 80)); } }
});
// Detached launch (PINPOINT_DETACHED=1): no MCP consumer on stdin, so don't exit on EOF —
// a plain `nohup bun server.ts &` otherwise binds, logs the banner, and dies instantly.
if (process.env.PINPOINT_DETACHED !== '1') process.stdin.on('end', () => process.exit(0));
