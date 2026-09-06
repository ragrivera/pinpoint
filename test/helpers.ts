import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'net';

export const BIN = join(import.meta.dir, '..', 'bin', 'pinpoint.ts');

/** process.env without any PINPOINT_* the test runner's own session may carry (a Claude worker
 *  exports PINPOINT_ROOT, for instance), so a spawned server resolves the fixture, not the host repo. */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('PINPOINT')) env[k] = v;
  return { ...env, ...extra };
}

export function tmpProject(files: Record<string, string> = {}): { root: string; rm: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pinpoint-test-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return { root, rm: () => rmSync(root, { recursive: true, force: true }) };
}

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => (typeof a === 'object' && a ? res(a.port) : rej(new Error('no port')))); });
  });
}

export async function waitFor(fn: () => Promise<boolean>, ms = 8000, step = 100): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return; } catch {} await Bun.sleep(step); }
  throw new Error('timed out waiting');
}

/** Spawn `pinpoint serve` and talk MCP JSON-RPC to it over stdio. */
export function mcpClient(env: Record<string, string>, cwd: string) {
  const proc = Bun.spawn(['bun', BIN, 'serve'], { cwd, env: cleanEnv({ PINPOINT_ROOT: cwd, ...env }), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const pending = new Map<number, (v: any) => void>();
  let buf = '';
  (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try { const m = JSON.parse(line); const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } } catch {}
      }
    }
  })();
  let next = 1;
  const call = (method: string, params?: unknown) => new Promise<any>((res) => {
    const id = next++;
    pending.set(id, res);
    (proc.stdin as any).write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    (proc.stdin as any).flush();
  });
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call('tools/call', { name, arguments: args });
    return JSON.parse(r.result.content[0].text);
  };
  return { proc, call, tool, kill: () => { try { proc.kill(); } catch {} } };
}
