// vmservice.test.ts — the VM Service client against a scripted fake VM service
// (Bun.serve websocket answering the same JSON-RPC the Dart VM speaks).
import { describe, expect, test, afterEach } from 'bun:test';
import { VmClient, Inspector, findFlutterIsolate, findReloadService, hotReload, toWsUri, type Selection } from '../src/vmservice.ts';
import { freePort } from './helpers.ts';

describe('toWsUri', () => {
  test('flutter run http URI → ws with /ws appended', () => {
    expect(toWsUri('http://127.0.0.1:50505/AbCd123=/')).toBe('ws://127.0.0.1:50505/AbCd123=/ws');
  });
  test('no trailing slash', () => {
    expect(toWsUri('http://127.0.0.1:50505/AbCd123=')).toBe('ws://127.0.0.1:50505/AbCd123=/ws');
  });
  test('already a ws URI passes through', () => {
    expect(toWsUri('ws://127.0.0.1:50505/AbCd123=/ws')).toBe('ws://127.0.0.1:50505/AbCd123=/ws');
  });
  test('http URI already ending in /ws is kept', () => {
    expect(toWsUri('http://127.0.0.1:1/tok=/ws')).toBe('ws://127.0.0.1:1/tok=/ws');
  });
  test('https → wss', () => {
    expect(toWsUri('https://host:1/t=/')).toBe('wss://host:1/t=/ws');
  });
  test('garbage rejected', () => {
    expect(() => toWsUri('not a uri')).toThrow();
  });
});

// ─── fake VM service ──────────────────────────────────────────────────────────
type Fake = { url: string; push: (streamId: string, event: Record<string, unknown>) => void; calls: Array<{ method: string; params: any }>; stop: () => void };
function fakeVm(handlers: Record<string, (params: any) => unknown>): Promise<Fake> {
  const sockets = new Set<any>();
  const calls: Array<{ method: string; params: any }> = [];
  const streams = new Set<string>();
  return freePort().then((port) => {
    const srv = Bun.serve({
      port, hostname: '127.0.0.1',
      fetch(req, server) { return server.upgrade(req) ? undefined : new Response('ws only', { status: 400 }); },
      websocket: {
        open(ws) { sockets.add(ws); },
        close(ws) { sockets.delete(ws); },
        message(ws, raw) {
          let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
          calls.push({ method: m.method, params: m.params });
          if (m.method === 'streamListen') {
            const already = streams.has(m.params?.streamId);
            streams.add(m.params?.streamId);
            ws.send(JSON.stringify(already ? { jsonrpc: '2.0', id: m.id, error: { code: 103, message: 'Stream already subscribed' } } : { jsonrpc: '2.0', id: m.id, result: { type: 'Success' } }));
            return;
          }
          const h = handlers[m.method];
          ws.send(JSON.stringify(h ? { jsonrpc: '2.0', id: m.id, result: h(m.params) } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no fake for ${m.method}` } }));
        },
      },
    });
    return {
      url: `ws://127.0.0.1:${port}/tok=/ws`,
      push: (streamId: string, event: Record<string, unknown>) => { for (const ws of sockets) ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'streamNotify', params: { streamId, event } })); },
      calls,
      stop: () => srv.stop(true),
    };
  });
}

const ISOLATES = {
  getVM: () => ({ isolates: [{ id: 'isolates/1', name: 'background' }, { id: 'isolates/2', name: 'main' }] }),
  getIsolate: (p: any) => p.isolateId === 'isolates/2'
    ? { name: 'main', extensionRPCs: ['ext.flutter.inspector.show', 'ext.flutter.inspector.screenshot'] }
    : { name: 'background', extensionRPCs: [] },
};

let cleanup: Array<() => void> = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });
async function connected(handlers: Record<string, (params: any) => unknown>): Promise<{ vm: Fake; c: VmClient }> {
  const vm = await fakeVm(handlers);
  const c = await VmClient.connect(vm.url);
  cleanup.push(() => { c.close(); vm.stop(); });
  return { vm, c };
}

describe('VmClient + isolate discovery', () => {
  test('rpc round-trips and errors reject', async () => {
    const { c } = await connected({ ...ISOLATES, boom: () => { throw new Error('unused'); } });
    const vmInfo = await c.rpc('getVM');
    expect(vmInfo.isolates.length).toBe(2);
    await expect(c.rpc('nothing')).rejects.toThrow('no fake for nothing');
  });
  test('findFlutterIsolate picks the isolate with inspector RPCs', async () => {
    const { c } = await connected(ISOLATES);
    const iso = await findFlutterIsolate(c);
    expect(iso.id).toBe('isolates/2');
    expect(iso.name).toBe('main');
  });
  test('streamListen tolerates 103 already-subscribed', async () => {
    const { c } = await connected(ISOLATES);
    await c.streamListen('Debug');
    await c.streamListen('Debug'); // second subscribe → fake answers 103 → no throw
  });
});

describe('Inspector', () => {
  test('selection: navigate ToolEvent carries file:line and Inspect dedupes', async () => {
    const { vm, c } = await connected(ISOLATES);
    const insp = new Inspector(c, 'isolates/2');
    const got: Selection[] = [];
    await insp.onSelection((s) => got.push(s), 200);
    vm.push('ToolEvent', { kind: 'Extension', extensionKind: 'navigate', extensionData: { fileUri: 'file:///repo/lib/a.dart', line: 12, column: 7, source: 'flutter.inspector' } });
    vm.push('Debug', { kind: 'Inspect' }); // same tap's twin event — must be deduped
    await Bun.sleep(80);
    expect(got.length).toBe(1);
    expect(got[0]).toEqual({ fileUri: 'file:///repo/lib/a.dart', line: 12, column: 7 });
    await Bun.sleep(200); // outside the window: a lone Inspect (no ToolEvent) must fire as a fallback
    vm.push('Debug', { kind: 'Inspect' });
    await Bun.sleep(80);
    expect(got.length).toBe(2);
    expect(got[1]).toEqual({});
  });
  test('getSelectedSummary maps the node, screenshot returns base64, select toggles', async () => {
    const { vm, c } = await connected({
      ...ISOLATES,
      'ext.flutter.inspector.show': (p: any) => ({ enabled: p.enabled ?? 'false' }),
      'ext.flutter.inspector.isWidgetCreationTracked': () => ({ result: true }),
      'ext.flutter.inspector.getSelectedSummaryWidget': () => ({ result: { valueId: 'inspector-0', widgetRuntimeType: 'ListTile', creationLocation: { file: 'file:///repo/lib/a.dart', line: 12, column: 7 } } }),
      'ext.flutter.inspector.screenshot': () => ({ result: 'aVZCT1J3MEtHZ28=' }),
      'ext.flutter.inspector.addPubRootDirectories': () => ({}),
      'ext.flutter.inspector.disposeGroup': () => ({}),
    });
    const insp = new Inspector(c, 'isolates/2');
    await insp.enableSelect(true);
    expect(await insp.isCreationTracked()).toBe(true);
    await insp.addPubRoots(['/repo/app']);
    const sel = await insp.getSelectedSummary();
    expect(sel?.widgetRuntimeType).toBe('ListTile');
    expect(sel?.creationLocation).toEqual({ file: 'file:///repo/lib/a.dart', line: 12, column: 7 });
    expect(await insp.screenshot('inspector-0', 300, 200)).toBe('aVZCT1J3MEtHZ28=');
    await insp.disposeGroup();
    const show = vm.calls.filter((x) => x.method === 'ext.flutter.inspector.show');
    expect(show[0].params).toMatchObject({ isolateId: 'isolates/2', enabled: 'true' });
    const roots = vm.calls.find((x) => x.method === 'ext.flutter.inspector.addPubRootDirectories');
    expect(roots?.params.arg0).toBe('/repo/app');
  });
  test('creation tracking off → false (release/profile preflight)', async () => {
    const { c } = await connected({ ...ISOLATES, 'ext.flutter.inspector.isWidgetCreationTracked': () => ({ result: false }) });
    expect(await new Inspector(c, 'isolates/2').isCreationTracked()).toBe(false);
  });
});

describe('hot reload service', () => {
  test('ServiceRegistered → findReloadService → hotReload calls the namespaced method', async () => {
    const { vm, c } = await connected({ ...ISOLATES, 's0.reloadSources': () => ({ type: 'Success' }) });
    setTimeout(() => vm.push('Service', { kind: 'ServiceRegistered', service: 'reloadSources', method: 's0.reloadSources', alias: 'Flutter Tools' }), 50);
    const method = await findReloadService(c, 2000);
    expect(method).toBe('s0.reloadSources');
    const r = await hotReload(c, method!, 'isolates/2');
    expect(r.ok).toBe(true);
    expect(vm.calls.find((x) => x.method === 's0.reloadSources')?.params.isolateId).toBe('isolates/2');
  });
  test('nothing registered → null (degrade to "press r")', async () => {
    const { c } = await connected(ISOLATES);
    expect(await findReloadService(c, 300)).toBe(null);
  });
});
