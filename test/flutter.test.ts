// flutter.test.ts — the server side of `pinpoint flutter`: the tap bus + /flutter panel,
// and a flutter-page batch riding the worker path with `source` pins (the worker brief is
// captured through a stub claude binary that appends its stdin to a file).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BIN, cleanEnv, freePort, tmpProject, waitFor } from './helpers.ts';

let port: number;
let project: ReturnType<typeof tmpProject>;
let owner: ReturnType<typeof Bun.spawn>;
let base: string;
let stubOut: string;
const feedback = () => join(project.root, '.docs', 'pinpoint', 'feedback');
const post = (path: string, body: unknown, origin?: string) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });

/** Collect SSE `data:` payloads from a flutter-bus subscription for `ms`. */
async function sseCollect(ms: number): Promise<any[]> {
  const ctl = new AbortController();
  const res = await fetch(base + '/api/flutter/events', { signal: ctl.signal });
  const out: any[] = [];
  const done = (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true }); let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const l of frame.split('\n')) if (l.startsWith('data: ')) { try { out.push(JSON.parse(l.slice(6))); } catch {} }
        }
      }
    } catch {}
  })();
  await Bun.sleep(ms);
  ctl.abort();
  await done.catch(() => {});
  return out;
}

beforeAll(async () => {
  port = await freePort();
  project = tmpProject({
    '.pinpoint.json': JSON.stringify({ port, name: 'acme', session: 'pinpoint_acme', dispatch: 'worker', apps: [{ dir: '.', origin: 'http://acme.localhost:5173' }] }),
  });
  stubOut = join(project.root, 'stub-claude.log');
  const stub = join(project.root, 'stub-claude.sh');
  writeFileSync(stub, `#!/bin/sh\ncat >> "${stubOut}"\n`);
  chmodSync(stub, 0o755);
  base = `http://127.0.0.1:${port}`;
  owner = Bun.spawn(['bun', BIN, 'serve'], { cwd: project.root, env: cleanEnv({ PINPOINT_ROOT: project.root, PINPOINT_ROLE: 'http', PINPOINT_DETACHED: '1', PINPOINT_CLAUDE: stub }), stdout: 'ignore', stderr: 'pipe' });
  await waitFor(async () => (await fetch(base + '/api/health')).ok, 15000);
}, 20000);
afterAll(() => { try { owner.kill(); } catch {} project.rm(); });

describe('flutter panel + tap bus', () => {
  test('GET /flutter serves the panel with the overlay tag', async () => {
    const r = await fetch(base + '/flutter');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    const html = await r.text();
    expect(html).toContain('Pinpoint · Flutter');
    expect(html).toContain('src="/pinpoint.js"');
  });
  test('taps: no-Origin POST lands, replays on SSE, foreign Origin is refused', async () => {
    const tap = { widget: 'ListTile', source: { file: 'app/lib/a.dart', line: 12, column: 7 }, rect: { x: 0, y: 0, w: 96, h: 48 }, screenshot: { type: 'image/png', data: 'aVZCT1J3MEtHZ28=' } };
    const r = await (await post('/api/flutter/taps', tap)).json();
    expect(r).toMatchObject({ ok: true, n: 1 });
    expect((await post('/api/flutter/taps', tap, 'http://evil.example')).status).toBe(403);
    expect((await post('/api/flutter/taps', { widget: 'X' })).status).toBe(400); // no source.file
    const events = await sseCollect(300);
    expect(events.find((e) => e.t === 'client')).toBeDefined();
    const replayed = events.filter((e) => e.t === 'tap');
    expect(replayed.length).toBe(1);
    expect(replayed[0].tap).toMatchObject({ n: 1, widget: 'ListTile', source: { file: 'app/lib/a.dart', line: 12, column: 7 } });
  });
  test('status/select/clear broadcast on the bus', async () => {
    const collecting = sseCollect(700);
    await Bun.sleep(100);
    await post('/api/flutter/status', { t: 'client', connected: true, app: 'employeex' });
    await post('/api/flutter/select', { on: false });
    await post('/api/flutter/status', { t: 'reloaded', id: 'b1', ok: true });
    await post('/api/flutter/clear', {});
    expect((await post('/api/flutter/status', { t: 'nope' })).status).toBe(400);
    const events = await collecting;
    expect(events.find((e) => e.t === 'client' && e.connected === true && e.app === 'employeex')).toBeDefined();
    expect(events.find((e) => e.t === 'select' && e.on === false)).toBeDefined();
    expect(events.find((e) => e.t === 'reloaded' && e.id === 'b1' && e.ok === true)).toBeDefined();
    expect(events.find((e) => e.t === 'cleared')).toBeDefined();
    // cleared: the next SSE subscriber sees no taps and numbering restarts
    const fresh = await sseCollect(200);
    expect(fresh.filter((e) => e.t === 'tap').length).toBe(0);
    const r = await (await post('/api/flutter/taps', { widget: 'AppBar', source: { file: 'app/lib/b.dart', line: 3, column: 1 } })).json();
    expect(r.n).toBe(1);
  });
});

describe('flutter batch → worker', () => {
  test('a /flutter-page batch keeps source pins verbatim, emits sent, and briefs the worker with pre-resolved locations', async () => {
    const collecting = sseCollect(900);
    await Bun.sleep(100);
    const body = {
      page: base + '/flutter', title: 'Pinpoint · Flutter', viewport: { w: 1200, h: 800, dpr: 2 }, general: '', to: 'worker',
      pins: [{ type: 'layout', comment: 'too cramped', fix: '', rect: { x: 0, y: 0, w: 96, h: 48 }, scrollY: 0, widget: 'ListTile', source: { file: 'app/lib/a.dart', line: 12, column: 7 }, at: '2026-09-07T00:00:00.000Z' }],
      images: [{ name: 'pin-1.png', type: 'image/png', data: 'aVZCT1J3MEtHZ28=' }],
    };
    const j = await (await post('/api/pins', body)).json();
    expect(j.ok).toBe(true);
    expect(j.worker).toBe(true);
    // the saved batch retains the source field verbatim
    const file = readdirSync(feedback()).find((n) => n.startsWith(j.id) && n.includes('.claimed-'));
    expect(file).toBeDefined();
    const saved = JSON.parse(readFileSync(join(feedback(), file!), 'utf8'));
    expect(saved.pins[0].source).toEqual({ file: 'app/lib/a.dart', line: 12, column: 7 });
    expect(saved.pins[0].widget).toBe('ListTile');
    // the bus told the CLI a batch was sent
    const events = await collecting;
    expect(events.find((e) => e.t === 'sent' && e.id === j.id && e.pins === 1)).toBeDefined();
    // the worker brief (captured by the stub claude) uses the pre-resolved branch
    await waitFor(async () => { try { return readFileSync(stubOut, 'utf8').includes('FLUTTER'); } catch { return false; } }, 8000);
    const brief = readFileSync(stubOut, 'utf8');
    expect(brief).toContain('tapped widgets on the running FLUTTER app');
    expect(brief).toContain('pre-resolved');
    expect(brief).toContain('app/lib/a.dart');
    expect(brief).toContain('dart analyze');
    expect(brief).toContain('do not hot reload');
    expect(brief).not.toContain('Grep the element'); // the DOM step must not appear
  });
});
