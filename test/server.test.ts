import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BIN, cleanEnv, freePort, mcpClient, tmpProject, waitFor } from './helpers.ts';

const APP_ORIGIN = 'http://acme.localhost:5173';
let port: number;
let project: ReturnType<typeof tmpProject>;
let upstream: ReturnType<typeof tmpProject>; // a fake package repo with version tags for the update check
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
    // a second revived conversation, so the model tests do not depend on the close test's ordering
    '.docs/pinpoint/workers/model-batch.json': JSON.stringify({ batchId: 'model-batch', workerId: 'w2', sessionUuid: '00000000-0000-0000-0000-000000000002', page: `${APP_ORIGIN}/home`, title: 'Home', state: 'exited', started: true, startedAt: '2026-01-01T00:00:00.000Z', lastAt: '2026-01-01T00:00:00.000Z', turns: 1, costUsd: 0 }),
  });
  base = `http://127.0.0.1:${port}`;
  upstream = tmpProject({ 'README.md': 'pinpoint' });
  const git = (...a: string[]) => { const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: upstream.root }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'init'); git('tag', 'v0.1.0'); git('tag', 'v9.9.9'); git('tag', 'not-a-version');
  owner = Bun.spawn(['bun', BIN, 'serve'], { cwd: project.root, env: cleanEnv({ PINPOINT_ROOT: project.root, PINPOINT_ROLE: 'http', PINPOINT_DETACHED: '1', PINPOINT_UPDATE_REPO: upstream.root }), stdout: 'ignore', stderr: 'pipe' });
  await waitFor(async () => (await fetch(base + '/api/health')).ok, 15000);
}, 20000);
afterAll(() => { try { owner.kill(); } catch {} project.rm(); upstream.rm(); });

describe('HTTP owner', () => {
  test('health reports the project', async () => {
    const h = await (await fetch(base + '/api/health')).json();
    expect(h.ok).toBe(true);
    expect(h.port).toBe(port);
    expect(h.root).toBe(project.root);
    expect(h.dispatch).toBe('session');
    expect(h.requiredSession).toBe('pinpoint_acme');
  });
  test('reports a newer version from the package repo tags on health and in the prelude', async () => {
    await waitFor(async () => Boolean((await (await fetch(base + '/api/health')).json()).update), 10000);
    const h = await (await fetch(base + '/api/health')).json();
    expect(h.update).toMatchObject({ latest: '9.9.9', available: true, repo: upstream.root });
    expect(h.update.command).toContain('9.9.9');
    const js = await (await fetch(base + '/pinpoint.js')).text();
    const brand = JSON.parse(js.slice('window.__reviewBrand = '.length, js.indexOf('\n')).replace(/;$/, ''));
    expect(brand.update).toMatchObject({ latest: '9.9.9', available: true });
  });
  test('serves the overlay with the pinpoint brand prelude', async () => {
    const js = await (await fetch(base + '/pinpoint.js')).text();
    expect(js.startsWith('window.__reviewBrand = {')).toBe(true);
    const brand = JSON.parse(js.slice('window.__reviewBrand = '.length, js.indexOf('\n')).replace(/;$/, ''));
    expect(brand).toMatchObject({ name: 'Pinpoint', key: 'pinpoint', api: '/api/pins', chat: '/api/chat', dispatch: 'session', port, requiredSession: 'pinpoint_acme' });
    expect(brand).toMatchObject({ idleMinutes: 30, recapOnIdle: true }); // the drawer counts down to the idle close with these
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
  test('handoff ends the worker and posts the resume command for its Claude session', async () => {
    const r = await post('/api/chat/old-batch/handoff', {}, APP_ORIGIN);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ ok: true, cwd: project.root, session: '00000000-0000-0000-0000-000000000000' });
    expect(j.command).toContain(project.root);
    expect(j.command).toEndWith(' && claude --resume 00000000-0000-0000-0000-000000000000');
    const chats = await (await fetch(base + '/api/chat')).json();
    expect(chats.find((c: any) => c.id === 'old-batch').session).toBe('00000000-0000-0000-0000-000000000000');
    // the transcript keeps the command, so the drawer shows it again after a reload
    const lines = readFileSync(join(project.root, '.docs', 'pinpoint', 'workers', 'old-batch.chat.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1])).toMatchObject({ t: 'status', handoff: true, command: j.command });
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
  test('offers the worker models on health and in the prelude', async () => {
    const h = await (await fetch(base + '/api/health')).json();
    expect(h.model).toBe('');
    expect(h.models.map((m: any) => m.id)).toEqual(['', 'fable', 'opus', 'opus[1m]', 'sonnet', 'haiku']);
    const js = await (await fetch(base + '/pinpoint.js')).text();
    const brand = JSON.parse(js.slice('window.__reviewBrand = '.length, js.indexOf('\n')).replace(/;$/, ''));
    expect(brand.models[0]).toMatchObject({ id: '', label: 'Default' });
  });
  test('sets a conversation model, persists it on the record, and refuses one it does not offer', async () => {
    const r = await post('/api/chat/model-batch/model', { model: 'sonnet' }, APP_ORIGIN);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, model: 'sonnet' });
    const chats = await (await fetch(base + '/api/chat')).json();
    expect(chats.find((c: any) => c.id === 'model-batch').model).toBe('sonnet');
    const rec = JSON.parse(readFileSync(join(project.root, '.docs', 'pinpoint', 'workers', 'model-batch.json'), 'utf8'));
    expect(rec.model).toBe('sonnet'); // a restart brings the choice back
    const lines = readFileSync(join(project.root, '.docs', 'pinpoint', 'workers', 'model-batch.chat.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1])).toMatchObject({ t: 'status', modelSet: true, model: 'sonnet' });
    const bad = await post('/api/chat/model-batch/model', { model: 'gpt-9' }, APP_ORIGIN);
    expect(bad.status).toBe(400);
    expect((await bad.json()).hint).toContain('worker.models');
    expect(JSON.parse(readFileSync(join(project.root, '.docs', 'pinpoint', 'workers', 'model-batch.json'), 'utf8')).model).toBe('sonnet');
  });
  test('sets a conversation effort, persists it on the record, and refuses one it does not offer', async () => {
    const r = await post('/api/chat/model-batch/effort', { effort: 'xhigh' }, APP_ORIGIN);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, effort: 'xhigh' });
    const chats = await (await fetch(base + '/api/chat')).json();
    expect(chats.find((c: any) => c.id === 'model-batch').effort).toBe('xhigh');
    const rec = JSON.parse(readFileSync(join(project.root, '.docs', 'pinpoint', 'workers', 'model-batch.json'), 'utf8'));
    expect(rec.effort).toBe('xhigh'); // a restart brings the choice back, like the model
    const lines = readFileSync(join(project.root, '.docs', 'pinpoint', 'workers', 'model-batch.chat.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1])).toMatchObject({ t: 'status', effortSet: true, effort: 'xhigh' });
    const bad = await post('/api/chat/model-batch/effort', { effort: 'ludicrous' }, APP_ORIGIN);
    expect(bad.status).toBe(400);
    expect(JSON.parse(readFileSync(join(project.root, '.docs', 'pinpoint', 'workers', 'model-batch.json'), 'utf8')).effort).toBe('xhigh');
  });
  test('offers the effort levels on health and in the prelude', async () => {
    const h = await (await fetch(base + '/api/health')).json();
    expect(h.efforts.map((e: any) => e.id)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    const js = await (await fetch(base + '/pinpoint.js')).text();
    const brand = JSON.parse(js.slice('window.__reviewBrand = '.length, js.indexOf('\n')).replace(/;$/, ''));
    expect(brand.efforts[0]).toMatchObject({ id: '', label: 'Default' });
  });
  test('refuses a batch asking for an effort the server does not offer', async () => {
    const r = await post('/api/pins', { ...batch(), effort: 'ludicrous' }, APP_ORIGIN);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain('Unknown effort');
  });
  test('refuses a batch asking for a model the server does not offer', async () => {
    const r = await post('/api/pins', { ...batch(), model: 'gpt-9' }, APP_ORIGIN);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain('gpt-9');
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

// The picked model has to reach the claude process itself, so this stands up a worker-dispatch
// project whose claudeBin is a script that records its argv and exits.
describe('worker dispatch spawns claude with the picked model', () => {
  const ORIGIN = 'http://models.localhost:5173';
  let wPort: number;
  let wProject: ReturnType<typeof tmpProject>;
  let wOwner: ReturnType<typeof Bun.spawn>;
  let wBase: string;
  const argv = (n: string) => readFileSync(join(wProject.root, n), 'utf8').trim().split('\n');

  beforeAll(async () => {
    wPort = await freePort();
    wProject = tmpProject({
      'fake-claude.sh': [
        '#!/bin/sh',
        'printf \'%s\\n\' "$@" > "$(dirname "$0")/argv-$$.txt"',
        'printf \'%s\\n\' "${CLAUDE_CODE_ARTIFACT-unset}" > "$(dirname "$0")/artifact-env-$$.txt"',
        'echo \'{"type":"system","subtype":"init","model":"stub"}\'',
        'while IFS= read -r line; do',
        '  printf \'%s\\n\' "$line" >> "$(dirname "$0")/stdin-$$.txt"',
        '  echo \'{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"num_turns":1,"total_cost_usd":0}\'',
        'done',
      ].join('\n') + '\n',
    });
    writeFileSync(join(wProject.root, '.pinpoint.json'), JSON.stringify({ port: wPort, name: 'models', dispatch: 'worker', claudeBin: join(wProject.root, 'fake-claude.sh'), apps: [{ dir: '.', origin: ORIGIN }] }));
    Bun.spawnSync(['chmod', '+x', join(wProject.root, 'fake-claude.sh')]);
    wBase = `http://127.0.0.1:${wPort}`;
    wOwner = Bun.spawn(['bun', BIN, 'serve'], { cwd: wProject.root, env: cleanEnv({ PINPOINT_ROOT: wProject.root, PINPOINT_ROLE: 'http', PINPOINT_DETACHED: '1', PINPOINT_NO_UPDATE_CHECK: '1' }), stdout: 'ignore', stderr: 'pipe' });
    await waitFor(async () => (await fetch(wBase + '/api/health')).ok, 15000);
  }, 20000);
  afterAll(() => { try { wOwner.kill(); } catch {} wProject.rm(); });

  const sendBatch = async (model?: string, extra: Record<string, unknown> = {}) => {
    const r = await fetch(wBase + '/api/pins', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ page: `${ORIGIN}/home`, title: 'Home', general: 'look at this', pins: [], to: 'worker', ...(model === undefined ? {} : { model }), ...extra }) });
    expect(r.status).toBe(200);
    return (await r.json()).id as string;
  };
  const args = async () => {
    let file = '';
    await waitFor(async () => { file = readdirSync(wProject.root).find((n) => n.startsWith('argv-')) || ''; return Boolean(file); }, 10000);
    const a = argv(file);
    Bun.spawnSync(['rm', join(wProject.root, file)]);
    return a;
  };

  /** The argv belongs to THIS batch's process: its session id is in there. */
  const spawnedFor = async (id: string) => {
    const a = await args();
    const chat = (await (await fetch(wBase + '/api/chat')).json()).find((c: any) => c.id === id);
    expect(a).toContain(chat.session);
    return { a, chat };
  };

  test('passes --model through to claude and records it on the conversation', async () => {
    const id = await sendBatch('sonnet');
    const { a, chat } = await spawnedFor(id);
    expect(a).toContain('--model');
    expect(a[a.indexOf('--model') + 1]).toBe('sonnet');
    expect(a).toContain('--dangerously-skip-permissions');
    expect(chat.model).toBe('sonnet');
  }, 20000);

  const wPost = (path: string, body: unknown) => fetch(wBase + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(body) }); // this block's own server, not the session-dispatch fixture
  const chatRow = async (id: string) => (await (await fetch(wBase + '/api/chat')).json()).find((c: any) => c.id === id);

  test('a switch restarts the worker on the new model and resumes the same Claude session', async () => {
    const id = await sendBatch('sonnet');
    const first = await spawnedFor(id);
    expect(first.a[first.a.indexOf('--model') + 1]).toBe('sonnet');
    expect(first.a).toContain('--session-id'); // a fresh conversation
    await waitFor(async () => (await chatRow(id)).state === 'idle', 10000); // the stub answered the batch
    // the live process keeps the model it was spawned with, so the switch ends it while it is quiet
    expect((await wPost(`/api/chat/${id}/model`, { model: 'haiku' })).status).toBe(200);
    await waitFor(async () => ['exited', 'error'].includes((await chatRow(id)).state), 10000);
    // and the next message brings the SAME session back on the new model
    expect((await wPost(`/api/chat/${id}`, { text: 'again' })).status).toBe(200);
    const second = await spawnedFor(id);
    expect(second.a[second.a.indexOf('--model') + 1]).toBe('haiku');
    expect(second.a).toContain('--resume');
    expect(second.a).toContain(first.chat.session); // new process, same conversation
    expect((await chatRow(id)).model).toBe('haiku');
  }, 30000);

  // A headless worker lacks tools an interactive session has (Artifact, AskUserQuestion, plan mode,
  // claude.ai connectors). It once spent five turns telling the reviewer it "can't" make an artifact;
  // the brief is what stops that, so it has to reach the process.
  test('the brief tells the worker a missing tool is not a missing capability, with its own resume command', async () => {
    const id = await sendBatch('');
    const { chat } = await spawnedFor(id);
    let raw = '';
    await waitFor(async () => {
      const f = readdirSync(wProject.root).filter((n) => n.startsWith('stdin-')).map((n) => readFileSync(join(wProject.root, n), 'utf8')).find((t) => t.includes(id));
      raw = f || '';
      return Boolean(f);
    }, 10000);
    expect(raw).toContain('A missing tool is not a missing capability');
    expect(raw).toContain('Artifact');
    expect(raw).toContain(`claude --resume ${chat.session}`);
    expect(raw).toContain('reply with the link');
  }, 20000);

  // claude -p leaves the Artifact tool off unless CLAUDE_CODE_ARTIFACT is on. Without it a worker asked for an
  // artifact can only hand the reviewer a step; with it the worker publishes and replies with the link.
  test('every worker starts with CLAUDE_CODE_ARTIFACT=1, so it has the Artifact tool', async () => {
    const id = await sendBatch('');
    await spawnedFor(id);
    let vals: string[] = [];
    await waitFor(async () => {
      vals = readdirSync(wProject.root).filter((n) => n.startsWith('artifact-env-')).map((n) => readFileSync(join(wProject.root, n), 'utf8').trim());
      return vals.length > 0;
    }, 10000);
    expect(vals.every((v) => v === '1')).toBe(true);
  }, 20000);

  test('leaves --model off when the batch picks the default', async () => {
    const id = await sendBatch('');
    const { a, chat } = await spawnedFor(id);
    expect(a).not.toContain('--model');
    expect(chat.model).toBe('');
  }, 20000);

  test('passes --effort through to claude, and leaves it off for the default', async () => {
    const id = await sendBatch('', { effort: 'xhigh' });
    const { a, chat } = await spawnedFor(id);
    expect(a[a.indexOf('--effort') + 1]).toBe('xhigh');
    expect(chat.effort).toBe('xhigh');
    const plain = await sendBatch('');
    expect((await spawnedFor(plain)).a).not.toContain('--effort');
  }, 30000);

  test('an attached file is saved beside the transcript and named in the worker prompt', async () => {
    const data = Buffer.from('id,name\n1,acme\n').toString('base64');
    const id = await sendBatch('', { images: [{ name: 'customers.csv', type: 'text/csv', data }] });
    await spawnedFor(id);
    const dir = join(wProject.root, '.docs', 'pinpoint', 'workers', id);
    const saved = readdirSync(dir).find((f) => f.startsWith('file-') && f.endsWith('.csv'));
    expect(saved).toBeTruthy();
    expect(readFileSync(join(dir, saved!), 'utf8')).toBe('id,name\n1,acme\n'); // written as-is, not re-encoded
    const served = await fetch(`${wBase}/api/chat/${encodeURIComponent(id)}/img/${saved}`, { headers: { Origin: ORIGIN } });
    expect(served.status).toBe(200);
    // handed back as a download: an attached .html must not run as script on the pinpoint origin
    expect(served.headers.get('content-type')).toBe('application/octet-stream');
    expect(served.headers.get('content-disposition')).toContain('attachment');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    // the worker is told where it is, since a non-image cannot travel inline
    const line = readFileSync(join(wProject.root, '.docs', 'pinpoint', 'workers', `${id}.chat.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e: any) => e.t === 'batch');
    expect(line.images[0]).toMatchObject({ name: 'customers.csv', img: false });
  }, 30000);
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

// The Look (size, blur, tint, dock edge) is the reviewer's, not the origin's: localStorage is per
// port, so the server keeps one copy per project and ships it to every app with BRAND.
describe('Look', () => {
  const lookFile = () => join(project.root, '.docs', 'pinpoint', 'look.json');
  const prelude = async () => {
    const js = await (await fetch(base + '/pinpoint.js')).text();
    return JSON.parse(js.slice('window.__reviewBrand = '.length, js.indexOf('\n')).replace(/;$/, ''));
  };

  test('nothing saved yet: GET is empty and the prelude carries no look', async () => {
    expect(await (await fetch(base + '/api/look')).json()).toEqual({});
    expect((await prelude()).look).toBe(null);
  });
  test('a saved look persists to disk, reads back, and rides along with every overlay load', async () => {
    const look = { look: { size: 1.2, blur: 30, tint: '#1d0e34' }, dock: 'left', items: { hub: { opacity: 0.4 } } };
    expect((await post('/api/look', look, APP_ORIGIN)).status).toBe(200);
    expect(JSON.parse(readFileSync(lookFile(), 'utf8'))).toEqual(look);
    expect(await (await fetch(base + '/api/look')).json()).toEqual(look);
    expect((await prelude()).look).toEqual(look);
  });
  test('refuses a non-object body', async () => {
    const r = await post('/api/look', ['not', 'an', 'object'], APP_ORIGIN);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain('object');
  });
  test('refuses a blob too large to ship with every page load', async () => {
    const r = await post('/api/look', { items: { big: 'x'.repeat(70_000) } }, APP_ORIGIN);
    expect(r.status).toBe(413);
    // the oversized write is refused, so the good copy is still what every app gets
    expect((await (await fetch(base + '/api/look')).json()).dock).toBe('left');
  });
  test('rejects a foreign browser origin like every other route', async () => {
    expect((await post('/api/look', { look: { tint: '#000000' } }, 'http://evil.example')).status).toBe(403);
  });
});

// worker.artifacts: false is the project's way out. It has to win over a server that inherited the switch from
// its own environment (a Claude session's .mcp.json env, say), so the worker gets CLAUDE_CODE_ARTIFACT=0.
describe('worker.artifacts: false', () => {
  const ORIGIN = 'http://noart.localhost:5173';
  let port: number;
  let project: ReturnType<typeof tmpProject>;
  let owner: ReturnType<typeof Bun.spawn>;
  let base: string;

  beforeAll(async () => {
    port = await freePort();
    project = tmpProject({
      'fake-claude.sh': [
        '#!/bin/sh',
        'printf \'%s\\n\' "${CLAUDE_CODE_ARTIFACT-unset}" > "$(dirname "$0")/artifact-env-$$.txt"',
        'echo \'{"type":"system","subtype":"init","model":"stub"}\'',
        'while IFS= read -r line; do',
        '  echo \'{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"num_turns":1,"total_cost_usd":0}\'',
        'done',
      ].join('\n') + '\n',
    });
    writeFileSync(join(project.root, '.pinpoint.json'), JSON.stringify({ port, name: 'noart', dispatch: 'worker', claudeBin: join(project.root, 'fake-claude.sh'), worker: { artifacts: false }, apps: [{ dir: '.', origin: ORIGIN }] }));
    Bun.spawnSync(['chmod', '+x', join(project.root, 'fake-claude.sh')]);
    base = `http://127.0.0.1:${port}`;
    owner = Bun.spawn(['bun', BIN, 'serve'], { cwd: project.root, env: cleanEnv({ PINPOINT_ROOT: project.root, PINPOINT_ROLE: 'http', PINPOINT_DETACHED: '1', PINPOINT_NO_UPDATE_CHECK: '1', CLAUDE_CODE_ARTIFACT: '1' }), stdout: 'ignore', stderr: 'pipe' });
    await waitFor(async () => (await fetch(base + '/api/health')).ok, 15000);
  }, 20000);
  afterAll(() => { try { owner.kill(); } catch {} project.rm(); });

  test('turns the Artifact tool off even when the server environment has it on', async () => {
    const r = await fetch(base + '/api/pins', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ page: `${ORIGIN}/home`, title: 'Home', general: 'look at this', pins: [], to: 'worker' }) });
    expect(r.status).toBe(200);
    let v = '';
    await waitFor(async () => {
      const f = readdirSync(project.root).find((n) => n.startsWith('artifact-env-'));
      v = f ? readFileSync(join(project.root, f), 'utf8').trim() : '';
      return Boolean(v);
    }, 10000);
    expect(v).toBe('0');
  }, 20000);
});
