// vmservice.ts — a dependency-free Dart VM Service client, scoped to what `pinpoint flutter`
// needs: JSON-RPC 2.0 over the WebSocket `flutter run` prints, the widget-inspector service
// extensions (tap-to-select, creation locations, screenshots), and the full hot reload that
// flutter_tools registers as a VM service *service* (bare reloadSources reloads Dart sources
// but never recompiles through the frontend server nor re-runs build() — never call it).
//
// Protocol references (verified against Flutter 3.44-era sources):
//   Dart VM Service spec   dart-lang/sdk runtime/vm/service/service.md
//   Widget inspector       flutter/flutter packages/flutter/lib/src/widgets/widget_inspector.dart
//   reloadSources service  flutter/flutter packages/flutter_tools/lib/src/vmservice.dart
//
// Selection events: with select mode on, a tap fires BOTH `developer.inspect()` (an `Inspect`
// event on the Debug stream) and `postEvent('navigate', {fileUri, line, column, source:
// 'flutter.inspector'}, 'ToolEvent')`. ToolEvent is primary (file:line arrives directly);
// Inspect is the mandatory fallback (then the caller fetches getSelectedSummaryWidget).
// The two fire for the same tap, so selections are deduped in a short window.

export type VmEvent = { kind: string; extensionKind?: string; extensionData?: Record<string, unknown>; isolate?: { id?: string }; [k: string]: unknown };
export type Selection = { fileUri?: string; line?: number; column?: number };
export type SummaryNode = { valueId: string | null; widgetRuntimeType: string; creationLocation?: { file: string; line: number; column: number } };

/** `flutter run` prints `http://127.0.0.1:PORT/TOKEN=/` — the ws endpoint is that URI with
 *  the scheme swapped and `ws` appended to the path. Already-ws URIs pass through. */
export function toWsUri(uri: string): string {
  let u: URL;
  try { u = new URL(uri.trim()); } catch { throw new Error(`not a valid VM Service URI: ${uri}`); }
  if (u.protocol === 'ws:' || u.protocol === 'wss:') return u.toString();
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`unsupported scheme ${u.protocol} in VM Service URI`);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (u.pathname.endsWith('/ws/')) u.pathname = u.pathname.slice(0, -1);
  else if (!u.pathname.endsWith('/ws')) { if (!u.pathname.endsWith('/')) u.pathname += '/'; u.pathname += 'ws'; }
  return u.toString();
}

export class VmClient {
  private ws: WebSocket;
  private next = 1;
  private pendingRpc = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Map<string, Set<(ev: VmEvent) => void>>();
  onClose: (() => void) | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (m) => this.onMessage(String(m.data)));
    ws.addEventListener('close', () => { for (const p of this.pendingRpc.values()) { clearTimeout(p.timer); p.rej(new Error('VM Service connection closed')); } this.pendingRpc.clear(); this.onClose?.(); });
  }
  static connect(wsUri: string, timeoutMs = 10_000): Promise<VmClient> {
    return new Promise((res, rej) => {
      let ws: WebSocket;
      try { ws = new WebSocket(wsUri); } catch (e: any) { return rej(new Error(`cannot open ${wsUri}: ${e?.message || e}`)); }
      const timer = setTimeout(() => { try { ws.close(); } catch {} rej(new Error(`timed out connecting to ${wsUri}`)); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); res(new VmClient(ws)); });
      ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error(`cannot connect to ${wsUri} — is the app still running?`)); });
    });
  }
  close() { try { this.ws.close(); } catch {} }

  private onMessage(text: string) {
    let m: any; try { m = JSON.parse(text); } catch { return; }
    if (m.id !== undefined && this.pendingRpc.has(m.id)) {
      const p = this.pendingRpc.get(m.id)!; this.pendingRpc.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.rej(Object.assign(new Error(`${m.error.message || 'RPC error'}${m.error.data?.details ? ': ' + String(m.error.data.details).slice(0, 200) : ''}`), { code: m.error.code }));
      else p.res(m.result);
      return;
    }
    if (m.method === 'streamNotify' && m.params?.streamId) {
      const subs = this.listeners.get(String(m.params.streamId));
      if (subs) for (const cb of subs) { try { cb(m.params.event as VmEvent); } catch {} }
    }
  }
  rpc(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<any> {
    const id = this.next++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pendingRpc.delete(id); rej(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pendingRpc.set(id, { res, rej, timer });
      try { this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }
      catch (e: any) { this.pendingRpc.delete(id); clearTimeout(timer); rej(new Error(`send failed: ${e?.message || e}`)); }
    });
  }
  /** Subscribe to a VM stream; 103 = already subscribed (fine — e.g. after a reconnect). */
  async streamListen(streamId: string): Promise<void> {
    try { await this.rpc('streamListen', { streamId }); } catch (e: any) { if (e?.code !== 103) throw e; }
  }
  onEvent(streamId: string, cb: (ev: VmEvent) => void): void {
    let s = this.listeners.get(streamId); if (!s) { s = new Set(); this.listeners.set(streamId, s); } s.add(cb);
  }
}

/** The Flutter UI isolate is the one exposing the inspector extensions. Extensions register
 *  after first frame, so retry against ServiceExtensionAdded events for a still-booting app. */
export async function findFlutterIsolate(c: VmClient, timeoutMs = 30_000): Promise<{ id: string; name: string; extensionRPCs: string[] }> {
  const scan = async () => {
    const vm = await c.rpc('getVM');
    for (const ref of vm.isolates || []) {
      try {
        const iso = await c.rpc('getIsolate', { isolateId: ref.id });
        const rpcs: string[] = iso.extensionRPCs || [];
        if (rpcs.includes('ext.flutter.inspector.show')) return { id: String(ref.id), name: String(iso.name || ref.name || ''), extensionRPCs: rpcs };
      } catch {} // isolate may have exited between getVM and getIsolate
    }
    return null;
  };
  const found = await scan();
  if (found) return found;
  await c.streamListen('Isolate');
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('no Flutter isolate found (no isolate exposes ext.flutter.inspector.* — is this a Flutter debug app?)')), timeoutMs);
    c.onEvent('Isolate', (ev) => {
      if (ev.kind !== 'ServiceExtensionAdded' || !String((ev as any).extensionRPC || '').startsWith('ext.flutter.inspector.')) return;
      void scan().then((f) => { if (f) { clearTimeout(timer); res(f); } });
    });
  });
}

/** Widget-inspector wrapper for one isolate. All inspector object references live in one
 *  object group, disposed on exit so the app doesn't leak them. */
export class Inspector {
  constructor(private c: VmClient, public isolateId: string, private group = 'pinpoint-1') {}
  private ext(method: string, params: Record<string, unknown> = {}, timeoutMs?: number) {
    return this.c.rpc(`ext.flutter.inspector.${method}`, { isolateId: this.isolateId, ...params }, timeoutMs);
  }
  /** ext.flutter.inspector.show is the bool service extension behind on-device select mode. */
  async enableSelect(on: boolean): Promise<void> { await this.ext('show', { enabled: String(on) }); }
  async selectEnabled(): Promise<boolean> { const r = await this.ext('show'); return String(r?.enabled) === 'true'; }
  async isCreationTracked(): Promise<boolean> { const r = await this.ext('isWidgetCreationTracked'); return r?.result === true || String(r?.result) === 'true'; }
  /** Tell the inspector which directories are "the local project" so summaries resolve the
   *  reviewer's widget instead of a framework one. Varargs: arg0..argN. */
  async addPubRoots(dirs: string[]): Promise<void> {
    if (!dirs.length) return;
    const args: Record<string, string> = {};
    dirs.forEach((d, i) => { args[`arg${i}`] = d; });
    await this.ext('addPubRootDirectories', args);
  }
  /** The currently selected widget from the SUMMARY tree (nearest local-project widget). */
  async getSelectedSummary(): Promise<SummaryNode | null> {
    const r = await this.ext('getSelectedSummaryWidget', { objectGroup: this.group });
    const node = r?.result ?? r;
    if (!node || typeof node !== 'object') return null;
    const loc = node.creationLocation;
    return {
      valueId: typeof node.valueId === 'string' ? node.valueId : null,
      widgetRuntimeType: String(node.widgetRuntimeType || node.description || ''),
      ...(loc && loc.file ? { creationLocation: { file: String(loc.file), line: Number(loc.line) || 0, column: Number(loc.column) || 0 } } : {}),
    };
  }
  /** PNG screenshot of one inspector object (base64), or null when it can't render. */
  async screenshot(id: string, width: number, height: number, opts: { margin?: number; maxPixelRatio?: number } = {}): Promise<string | null> {
    try {
      const r = await this.ext('screenshot', { id, width: String(width), height: String(height), margin: String(opts.margin ?? 8), maxPixelRatio: String(opts.maxPixelRatio ?? 2) }, 20_000);
      const png = r?.result ?? r;
      return typeof png === 'string' && png.length ? png : null;
    } catch { return null; }
  }
  /** valueId of the root of the summary tree (for full-screen screenshots), cached. */
  private rootIdCache: string | null | undefined;
  async rootId(): Promise<string | null> {
    if (this.rootIdCache !== undefined) return this.rootIdCache;
    let id: string | null = null;
    try {
      const r = await this.ext('getRootWidgetSummaryTree', { objectGroup: this.group }, 20_000);
      const node = r?.result ?? r;
      id = node && typeof node.valueId === 'string' ? node.valueId : null;
    } catch {}
    this.rootIdCache = id;
    return id;
  }
  async disposeGroup(): Promise<void> { try { await this.ext('disposeGroup', { objectGroup: this.group }); } catch {} }
  /** On-device tap selections. Primary: the `navigate` ToolEvent (carries file:line:column).
   *  Fallback: the Debug stream's `Inspect` event (caller then reads getSelectedSummary).
   *  Both fire per tap — dedupe inside `windowMs`. */
  async onSelection(cb: (sel: Selection) => void, windowMs = 300): Promise<void> {
    let lastAt = 0; let lastKey = '';
    const fire = (sel: Selection) => {
      const key = sel.fileUri ? `${sel.fileUri}:${sel.line}` : '';
      const now = Date.now();
      if (now - lastAt < windowMs && (key === lastKey || !key || !lastKey)) { if (key && !lastKey) lastKey = key; return; }
      lastAt = now; lastKey = key;
      cb(sel);
    };
    await this.c.streamListen('ToolEvent');
    this.c.onEvent('ToolEvent', (ev) => {
      if (ev.extensionKind !== 'navigate') return;
      const d: any = ev.extensionData || {};
      if (d.source && d.source !== 'flutter.inspector') return;
      fire({ fileUri: d.fileUri ? String(d.fileUri) : undefined, line: d.line != null ? Number(d.line) : undefined, column: d.column != null ? Number(d.column) : undefined });
    });
    await this.c.streamListen('Debug');
    this.c.onEvent('Debug', (ev) => { if (ev.kind === 'Inspect') fire({}); });
  }
}

/** flutter_tools registers `reloadSources` as a VM *service* (full recompile + reload +
 *  reassemble). DDS replays existing registrations to new Service-stream subscribers, so
 *  subscribe-then-wait suffices. Returns the namespaced method (e.g. "s0.reloadSources"),
 *  or null when nothing registered it (bare `dart`, --no-dds — degrade to "press r"). */
export async function findReloadService(c: VmClient, waitMs = 2_500): Promise<string | null> {
  let method: string | null = null;
  await c.streamListen('Service');
  c.onEvent('Service', (ev) => { if (ev.kind === 'ServiceRegistered' && (ev as any).service === 'reloadSources') method = String((ev as any).method || '') || null; });
  const end = Date.now() + waitMs;
  while (!method && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return method;
}
export async function hotReload(c: VmClient, method: string, isolateId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await c.rpc(method, { isolateId }, 60_000);
    // flutter_tools answers { type: 'Success' } (or a ReloadReport-shaped body on older paths)
    const ok = r?.type === 'Success' || r?.success === true || r?.result?.success === true;
    return ok ? { ok } : { ok: false, error: JSON.stringify(r).slice(0, 200) };
  } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
}
