import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BIN, cleanEnv, freePort, mcpClient, tmpProject, waitFor } from './helpers.ts';

const APP_ORIGIN = 'http://acme.localhost:5173';
let port: number;
let project: ReturnType<typeof tmpProject>;
let owner: ReturnType<typeof Bun.spawn>;
let base: string;
const feedback = () => join(project.root, '.docs', 'pinpoint', 'feedback');
const post = (path: string, body: unknown, origin?: string) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
const batch = (to = '') => ({ page: `${APP_ORIGIN}/settings/profile`, title: 'Settings', viewport: { w: 1440, h: 900, dpr: 2 }, general: '', pins: [{ type: 'bug', comment: 'overlaps', rect: { x: 1, y: 2, w: 3, h: 4 }, element: { tag: 'button', path: 'main > button', text: 'Save' } }], to });

beforeAll(async () => {
  port = await freePort();
  project = tmpProject({
    '.pinpoint.json': JSON.stringify({ port, name: 'acme', session: 'pinpoint_acme', dispatch: 'session', apps: [{ dir: '.', origin: APP_ORIGIN }] }),
    // a worker record from a previous server run: loadWorkers() revives it as an exited conversation
    '.docs/pinpoint/workers/old-batch.json': JSON.stringify({ batchId: 'old-batch', workerId: 'w1', sessionUuid: '00000000-0000-0000-0000-000000000000', page: `${APP_ORIGIN}/home`, title: 'Home', state: 'idle', started: true, startedAt: '2026-01-01T00:00:00.000Z', lastAt: '2026-01-01T00:00:00.000Z', turns: 1, costUsd: 0 }),
  });
  base = `http://127.0.0.1:${port}`;
  owner = Bun.spawn(['bun', BIN, 'serve'], { cwd: project.root, env: cleanEnv({ PINPOINT_ROOT: project.root, PINPOINT_ROLE: 'http', PINPOINT_DETACHED: '1' }), stdout: 'ignore', stderr: 'pipe' });
  await waitFor(async () => (await fetch(base + '/api/health')).ok, 15000);
}, 20000);
afterAll(() => { try { owner.kill(); } catch {} project.rm(); });

describe('HTTP owner', () => {
  test('health reports the project', async () => {
    const h = await (await fetch(base + '/api/health')).json();
    expect(h.ok).toBe(true);
    expect(h.port).toBe(port);
    expect(h.root).toBe(project.root);
    expect(h.dispatch).toBe('session');
    expect(h.requiredSession).toBe('pinpoint_acme');
  });
  test('serves the overlay with the pinpoint brand prelude', async () => {
    const js = await (await fetch(base + '/pinpoint.js')).text();
    expect(js.startsWith('window.__reviewBrand = {')).toBe(true);
    const brand = JSON.parse(js.slice('window.__reviewBrand = '.length, js.indexOf('\n')).replace(/;$/, ''));
    expect(brand).toMatchObject({ name: 'Pinpoint', key: 'pinpoint', api: '/api/pins', chat: '/api/chat', dispatch: 'session', port, requiredSession: 'pinpoint_acme' });
    expect(js).toContain('dr-fp'); // the overlay body follows
  });
  test('serves an open-design mockup with the overlay injected, and nothing outside that tree', async () => {
    mkdirSync(join(project.root, '.docs', 'open-design', 'demo'), { recursive: true });
    writeFileSync(join(project.root, '.docs', 'open-design', 'demo', 'index.html'), '<!doctype html><html><body><h1>Demo</h1></body></html>');
    const r = await fetch(base + '/.docs/open-design/demo/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(await r.text()).toContain('<script src="/pinpoint.js" defer></script>\n</body>');
    expect((await fetch(base + '/.docs/open-design/demo/missing.html')).status).toBe(404);
    expect((await fetch(base + '/.pinpoint.json')).status).toBe(404); // nothing else is served statically
  });
  test('close drops a worker conversation and parks its record so a restart does not revive it', async () => {
    let chats = await (await fetch(base + '/api/chat')).json();
    expect(chats.map((c: any) => c.id)).toContain('old-batch');
    const r = await post('/api/chat/old-batch/close', {}, APP_ORIGIN);
    expect(r.status).toBe(200);
    chats = await (await fetch(base + '/api/chat')).json();
    expect(chats.map((c: any) => c.id)).not.toContain('old-batch');
    const workersDir = join(project.root, '.docs', 'pinpoint', 'workers');
    expect(existsSync(join(workersDir, 'old-batch.json'))).toBe(false);
    expect(existsSync(join(workersDir, 'old-batch.json.closed'))).toBe(true);
    expect((await post('/api/chat/old-batch/close', {}, APP_ORIGIN)).status).toBe(404);
  });
  test('rejects a foreign browser origin', async () => {
    const r = await post('/api/pins', batch(), 'https://evil.example');
    expect(r.status).toBe(403);
  });
  test('refuses an unaddressed batch while no handler session is live', async () => {
    const r = await post('/api/pins', batch(), APP_ORIGIN);
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.requiredSession).toBe('pinpoint_acme');
    expect(j.hint).toContain('/rename pinpoint_acme');
  });
  test('accepts a batch once a handler heartbeats, routes it to that session, tracks progress', async () => {
    await post('/api/sessions', { id: 'sess1', label: 'pinpoint_acme', cwd: project.root }, 'http://localhost:5173');
    const sessions = await (await fetch(base + '/api/sessions')).json();
    expect(sessions).toEqual([{ id: 'sess1', label: 'pinpoint_acme', cwd: project.root }]);

    const r = await post('/api/pins', batch(), APP_ORIGIN);
    expect(r.status).toBe(200);
    const { id } = await r.json();
    expect(id).toMatch(/-settings-profile$/);
    const file = join(feedback(), `${id}.json`);
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.to).toBe('sess1');
    expect(saved.pins).toHaveLength(1);

    let st = await (await fetch(`${base}/api/pins/${id}`)).json();
    expect(st).toMatchObject({ total: 1, resolved: 0, complete: false, claimedBy: null });

    // the CLI twin of report_pin, run from the project root
    const rep = Bun.spawnSync(['bun', BIN, 'report', id, '1', 'done', 'moved into the footer', '--by', 'sess1'], { cwd: project.root, env: cleanEnv({ PINPOINT_ROOT: project.root }) });
    expect(rep.exitCode).toBe(0);
    expect(rep.stdout.toString()).toContain(`${id} #1 done (1/1)`);
    st = await (await fetch(`${base}/api/pins/${id}`)).json();
    expect(st.complete).toBe(true);
    expect(st.progress['1']).toMatchObject({ status: 'done', note: 'moved into the footer', by: 'sess1' });
  });
});

describe('MCP follower', () => {
  let mcp: ReturnType<typeof mcpClient>;
  beforeAll(() => { mcp = mcpClient({ PINPOINT_SESSION: 'pinpoint_acme', PINPOINT_SESSION_ID: 'mcp1' }, project.root); });
  afterAll(() => mcp.kill());

  test('initialize + tools/list', async () => {
    const init = await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(init.result.serverInfo.name).toBe('pinpoint');
    const tools = await mcp.call('tools/list');
    expect(tools.result.tools.map((t: any) => t.name).sort()).toEqual(['get_pins', 'list_pins', 'list_sessions', 'report_pin', 'wait_for_pins']);
  });
  test('list_sessions sees itself as the handler through the owner registry', async () => {
    await waitFor(async () => ((await fetch(base + '/api/sessions')).json() as Promise<any[]>).then((s) => s.some((x) => x.id === 'mcp1')));
    const s = await mcp.tool('list_sessions');
    expect(s.selfIsHandler).toBe(true);
    expect(s.requiredSession).toBe('pinpoint_acme');
    expect(s.sessions.some((x: any) => x.id === 'mcp1' && x.label === 'pinpoint_acme')).toBe(true);
  });
  test('claims an addressed batch exactly once (rename) and delivers it to wait_for_pins', async () => {
    const waiting = mcp.tool('wait_for_pins', { timeout_seconds: 10 });
    const r = await post('/api/pins', batch('mcp1'), APP_ORIGIN);
    const { id } = await r.json();
    const got = await waiting;
    expect(got.id).toBe(id);
    expect(got.claimedBy).toBe('mcp1');
    await waitFor(async () => readdirSync(feedback()).includes(`${id}.claimed-mcp1.json`));
    expect(existsSync(join(feedback(), `${id}.json`))).toBe(false);
    const listed = await mcp.tool('list_pins', { limit: 5 });
    expect(listed.find((b: any) => b.id === id)).toMatchObject({ claimedBy: 'mcp1', to: 'mcp1', pins: 1 });
    const again = await mcp.tool('get_pins', { id });
    expect(again.id).toBe(id);
    const prog = await mcp.tool('report_pin', { id, pin: 1, status: 'done' });
    expect(prog.complete).toBe(true);
  });
});
