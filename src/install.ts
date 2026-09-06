// install.ts — `pinpoint install`: give a repo its OWN pinpoint server and wire the
// overlay into every Vite app it contains.
//
//   pinpoint install [--root <dir>] [--port <n>] [--name <project>] [--app <dir>]... [--spec <pkg>]
//                    [--dry-run] [--no-add] [--no-mcp] [--no-skill] [--no-phoenix] [--no-gitignore]
//
// Why per-project: a shared server writes every batch into the cwd it was started from, so
// pins from a second repo land in the first repo's folder, and a repo with a custom port
// block or `*.localhost` subdomains can't be told apart from its neighbour. Each installed
// repo therefore gets its own port, recorded in <root>/.pinpoint.json. The server, the
// Vite plugin and the CLI all walk up to that file, so the first Claude session opened in
// a repo becomes that repo's HTTP owner on that repo's port; later sessions follow it.
//
// What it writes (idempotent — re-running only fills in what's missing):
//   package.json + lockfile               `<pm> add -D pinpoint-live` unless already in node_modules (--no-add)
//   <root>/.pinpoint.json                 port + name + app origins (commit it: the team shares them)
//                                         name → a session-dispatch handler MUST be called pinpoint_<name>
//   <app>/vite.config.*                   `import { pinpoint } from 'pinpoint-live/vite'` + `pinpoint()` first in plugins
//   <root>/.mcp.json                      project-scope MCP server `bun run pinpoint serve` (commit it)
//   <root>/.claude/skills/pinpoint/       the /pinpoint skill for every Claude session in this repo (commit it)
//   <root>/.gitignore                     .docs/pinpoint/
//   <root>/.docs/pinpoint/feedback/       batch dir
//   ~/.claude/skills/phoenix/cache/<slug>.overrides.json   only when the phoenix skill is installed
//
// Non-Vite React apps (Next.js, Remix, CRA…) are reported, not wired: render <PinpointScript/>
// from 'pinpoint-live/react' in the root layout — the snippet is printed.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { basename, dirname, join, relative, resolve } from 'path';
import pkg from '../package.json';
import { SKILL_SRC } from './skill.ts';

const PKG = pkg.name;
const CONFIG_NAMES = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'];
const NEXT_CONFIGS = ['next.config.js', 'next.config.mjs', 'next.config.ts'];
const HOME = process.env.HOME || '~';

type Server = { host: string; port: number; note: string };
type Patch = { text: string; changed: boolean; reason?: string; preview?: string[] };

/** Returns the process exit code. */
export async function run(argvIn: string[]): Promise<number> {
  const argv = argvIn.slice();
  const flag = (n: string) => { const i = argv.indexOf(n); if (i < 0) return false; argv.splice(i, 1); return true; };
  const opt = (n: string) => { const i = argv.indexOf(n); if (i < 0) return undefined; return argv.splice(i, 2)[1]; };
  const multi = (n: string) => { const out: string[] = []; let v: string | undefined; while ((v = opt(n)) !== undefined) out.push(v); return out; };
  const DRY = flag('--dry-run');
  const NO_ADD = flag('--no-add');
  const NO_MCP = flag('--no-mcp');
  const NO_SKILL = flag('--no-skill');
  const NO_PHOENIX = flag('--no-phoenix');
  const NO_GITIGNORE = flag('--no-gitignore');
  const HELP = flag('--help') || flag('-h');
  const portArg = opt('--port');
  const nameArg = opt('--name');
  const rootArg = opt('--root');
  const spec = opt('--spec') || PKG;
  const appArgs = multi('--app');
  if (HELP || argv.length) {
    if (argv.length) console.error(`unknown argument(s): ${argv.join(' ')}\n`);
    console.error(readFileSync(import.meta.path, 'utf8').split('\n').slice(0, 27).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return argv.length ? 2 : 0;
  }
  if (portArg !== undefined && !/^\d{2,5}$/.test(portArg)) { console.error(`--port must be a number, got "${portArg}"`); return 2; }

  const say = (s = '') => console.log(s);
  const tag = DRY ? '(dry-run) would' : '';
  const ROOT = findRoot(rootArg || process.cwd());
  const rel = (p: string) => relative(ROOT, p) || '.';
  const configIn = (dir: string) => CONFIG_NAMES.map((n) => join(dir, n)).find(existsSync);
  const nextIn = (dir: string) => NEXT_CONFIGS.map((n) => join(dir, n)).find(existsSync);

  // ─── apps ───────────────────────────────────────────────────────────────────
  const candidates = (): string[] => {
    const dirs = [ROOT];
    for (const ws of ['apps', 'packages']) {
      const d = join(ROOT, ws);
      if (!existsSync(d)) continue;
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (!e.startsWith('.') && e !== 'node_modules' && statSync(p).isDirectory()) dirs.push(p);
      }
    }
    return dirs;
  };
  const apps = appArgs.length ? appArgs.map((a) => resolve(ROOT, a)) : candidates().filter(configIn);
  const nextApps = appArgs.length ? [] : candidates().filter((d) => !configIn(d) && nextIn(d));

  say(`pinpoint install${DRY ? ' (dry-run)' : ''}  →  ${ROOT}`);
  say();
  if (!apps.length && !nextApps.length) {
    say('No vite.config.* (or next.config.*) found at the root or under apps/* or packages/*.');
    say('Pass --app <dir> for an unusual layout, or wire a non-Vite dev server by hand:');
    say(`  import { PinpointScript } from '${PKG}/react';   //  <PinpointScript origin="http://127.0.0.1:<port>" />`);
    say('  or  <script src="http://127.0.0.1:<port>/pinpoint.js" defer></script>  in the dev HTML.');
    return 1;
  }

  const cfgPath = join(ROOT, '.pinpoint.json');
  let existing: { port?: number; name?: string; apps?: unknown; dispatch?: string } = {};
  if (existsSync(cfgPath)) { try { existing = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { existing = {}; } }

  type AppResult = { dir: string; server: Server; origin: string; config: string; preview?: string[] };
  const results: AppResult[] = [];
  const writes: Array<() => void> = [];

  for (const app of apps) {
    const cfgFile = configIn(app);
    if (!cfgFile) { say(`  ${rel(app)}: no vite.config.* — skipped`); continue; }
    const cfgText = readFileSync(cfgFile, 'utf8');
    const server = detectServer(app, cfgText);
    const origin = `http://${server.host}:${server.port}`;
    const p = patchConfig(cfgText);
    let config: string;
    if (p.changed) { config = `${tag} patch`.trim(); writes.push(() => writeFileSync(cfgFile, p.text)); }
    else config = p.reason || 'unchanged';
    results.push({ dir: rel(app), server, origin, config, preview: p.preview });
  }

  const { port, note: portNote } = pickPort(results.map((r) => r.server.port), existing.port, portArg);
  const nameInfo = nameArg ? { name: nameArg, note: '--name' } : existing.name ? { name: existing.name, note: '.pinpoint.json (kept)' } : detectName(ROOT, apps);
  const NAME = slugName(nameInfo.name);
  const SESSION = `pinpoint_${NAME}`;
  const appPortClash = results.find((r) => r.server.port === port);
  if (appPortClash) { say(`✗ port ${port} is already ${appPortClash.dir}'s dev port — pass a different --port`); return 1; }

  for (const r of results) {
    say(`  ${r.dir}`);
    say(`    dev server: ${r.origin}   (${r.server.note})`);
    say(`    vite.config: ${r.config}`);
    for (const l of r.preview || []) say(`      ${l}`);
  }
  for (const app of nextApps) {
    say(`  ${rel(app)}  (Next.js — not wired automatically)`);
    say(`    render once in the root layout:  import { PinpointScript } from '${PKG}/react';`);
    say(`                                     <PinpointScript origin="http://127.0.0.1:${port}" />`);
  }
  say();

  // dependency
  const installed = existsSync(join(ROOT, 'node_modules', PKG, 'package.json'));
  if (installed) say(`  ${PKG}: installed`);
  else if (NO_ADD) say(`  ${PKG}: not in node_modules (--no-add) — add it: ${addCommand(ROOT, spec).join(' ')}`);
  else {
    const cmd = addCommand(ROOT, spec);
    say(`  ${PKG}: ${`${tag} run \`${cmd.join(' ')}\``.trim()}`);
    writes.push(() => {
      const r = spawnSync(cmd[0], cmd.slice(1), { cwd: ROOT, stdio: 'inherit' });
      if (r.status !== 0) say(`  ✗ \`${cmd.join(' ')}\` failed — add the package by hand (a git spec works too: --spec github:ragrivera/pinpoint)`);
    });
  }

  // .pinpoint.json
  const cfgOut = {
    port,
    name: NAME,
    session: SESSION,
    dispatch: existing.dispatch === 'session' ? 'session' : 'worker', // headless worker per batch (chat in the overlay); 'session' = a live pinpoint_<name> session claims it
    apps: results.map((r) => ({ dir: r.dir, origin: r.origin })),
    installedAt: new Date().toISOString(),
  };
  const cfgSame = existing.port === port && existing.name === NAME && JSON.stringify(existing.apps) === JSON.stringify(cfgOut.apps);
  say(`  .pinpoint.json: ${cfgSame ? 'unchanged' : `${tag} write`.trim()}  port ${port}  (${portNote})`);
  if (!cfgSame) writes.push(() => writeFileSync(cfgPath, JSON.stringify(cfgOut, null, 2) + '\n'));
  say(`  handler session: ${SESSION}  (${nameInfo.note}; only used with "dispatch": "session")`);

  // .mcp.json — project-scope MCP server, shared through git
  if (!NO_MCP) {
    const mcpFile = join(ROOT, '.mcp.json');
    let mcp: any = {};
    if (existsSync(mcpFile)) { try { mcp = JSON.parse(readFileSync(mcpFile, 'utf8')); } catch { mcp = null; } }
    const want = { command: 'bun', args: ['run', 'pinpoint', 'serve'] };
    if (mcp === null) say('  .mcp.json: unreadable — add by hand: "pinpoint": { "command": "bun", "args": ["run", "pinpoint", "serve"] }');
    else {
      const cur = mcp.mcpServers?.pinpoint;
      if (cur) say(`  .mcp.json: pinpoint server ${JSON.stringify(cur) === JSON.stringify(want) ? 'present' : 'present (customised — left alone)'}`);
      else {
        say(`  .mcp.json: ${`${tag} add pinpoint server (bun run pinpoint serve)`.trim()}`);
        writes.push(() => writeFileSync(mcpFile, JSON.stringify({ ...mcp, mcpServers: { ...(mcp.mcpServers || {}), pinpoint: want } }, null, 2) + '\n'));
      }
    }
  }

  // project skill — the /pinpoint instructions for every Claude session in this repo
  if (!NO_SKILL) {
    const f = join(ROOT, '.claude', 'skills', 'pinpoint', 'SKILL.md');
    const src = readFileSync(SKILL_SRC, 'utf8');
    if (!existsSync(f)) { say(`  .claude/skills/pinpoint/SKILL.md: ${`${tag} write`.trim()}`); writes.push(() => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, src); }); }
    else say(`  .claude/skills/pinpoint/SKILL.md: ${readFileSync(f, 'utf8') === src ? 'up to date' : 'exists, differs (pinpoint skill --force refreshes it)'}`);
  }

  // .gitignore
  if (!NO_GITIGNORE) {
    const gi = join(ROOT, '.gitignore');
    const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    const has = /^\s*\.docs\/pinpoint\/?(feedback\/?)?\s*$/m.test(cur);
    say(`  .gitignore: ${has ? 'already ignores .docs/pinpoint' : `${tag} add .docs/pinpoint/`.trim()}`);
    if (!has) writes.push(() => appendFileSync(gi, `${cur.endsWith('\n') || !cur ? '' : '\n'}\n# pinpoint live-review state: batches, worker chats, server log (written by the overlay; never commit)\n.docs/pinpoint/\n`));
  }

  // feedback dir
  const feedbackDir = join(ROOT, '.docs', 'pinpoint', 'feedback');
  say(`  .docs/pinpoint/feedback/: ${existsSync(feedbackDir) ? 'exists' : `${tag} create`.trim()}`);
  if (!existsSync(feedbackDir)) writes.push(() => mkdirSync(feedbackDir, { recursive: true }));

  // phoenix override — so `/phoenix` in this repo starts the owner alongside the stack (only when that skill exists)
  if (!NO_PHOENIX) {
    const cacheDir = join(HOME, '.claude', 'skills', 'phoenix', 'cache');
    if (existsSync(cacheDir)) {
      const slug = ROOT.replace(/\//g, '-').replace(/^-/, '');
      const f = join(cacheDir, `${slug}.overrides.json`);
      let cur: any = {};
      if (existsSync(f)) { try { cur = JSON.parse(readFileSync(f, 'utf8')); } catch { cur = {}; } }
      const list: any[] = Array.isArray(cur.extra_services) ? cur.extra_services : [];
      const svc = {
        name: 'Pinpoint overlay server',
        port,
        command: 'PINPOINT_DETACHED=1 PINPOINT_ROLE=http bun run pinpoint serve',
        cwd: '.',
        after: 'Infra',
        note: `This repo's own live-app pin overlay server (pinpoint; port from .pinpoint.json). Must be up for the Pinpoint pill to appear. Health: curl -s http://127.0.0.1:${port}/api/health. Launch detached (nohup+disown); PINPOINT_DETACHED=1 keeps it alive without a stdin holder.`,
      };
      const i = list.findIndex((s) => s && s.name === svc.name);
      const same = i >= 0 && list[i].port === port && list[i].command === svc.command;
      say(`  phoenix override: ${same ? 'current' : `${tag} ${i >= 0 ? 'update' : 'add'} ${f.replace(HOME, '~')}`.trim()}`);
      if (!same) {
        if (i >= 0) list[i] = { ...list[i], ...svc }; else list.push(svc);
        cur.extra_services = list;
        writes.push(() => writeFileSync(f, JSON.stringify(cur, null, 2) + '\n'));
      }
    }
  }

  if (!DRY) for (const w of writes) w();
  say();
  say(DRY ? `Nothing written. Re-run without --dry-run to apply ${writes.length} change(s).` : `Applied ${writes.length} change(s).`);
  say();
  say('Next:');
  say(`  1. Restart the Vite dev servers — the plugin only loads on startup: ${results.filter((r) => r.config !== 'unchanged').map((r) => r.dir).join(', ') || '(none changed)'}`);
  say(`  2. Restart Claude Code in this repo (or /mcp → reconnect) so it picks up .mcp.json and approves the pinpoint server;`);
  say(`     the first session owns http://127.0.0.1:${port}. Without a session: PINPOINT_DETACHED=1 PINPOINT_ROLE=http nohup bun run pinpoint serve > .docs/pinpoint/server.log 2>&1 & disown`);
  say(`  3. Open ${results[0]?.origin ?? 'the app'} — the Pinpoint pill should be there. Press R, pin, Send.`);
  say(`  4. Commit .pinpoint.json, .mcp.json and .claude/skills/pinpoint/ so the rest of the team gets the same setup.`);
  const manual = results.filter((r) => /by hand/.test(r.config));
  if (manual.length) {
    say();
    say(`Wire by hand (${manual.map((r) => r.dir).join(', ')}): add \`import { pinpoint } from '${PKG}/vite';\` and put \`pinpoint()\` in the plugins array.`);
  }
  return 0;
}

// ─── root ─────────────────────────────────────────────────────────────────────
function findRoot(from: string): string {
  let dir = resolve(from);
  let pkgDir: string | null = null;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (!pkgDir && existsSync(join(dir, 'package.json'))) pkgDir = dir;
    const up = dirname(dir);
    if (up === dir) return pkgDir || resolve(from);
    dir = up;
  }
}

function readEnvVar(dir: string, key: string): string | undefined {
  for (const f of ['.env.local', '.env']) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\n#]+)"?`, 'm').exec(readFileSync(p, 'utf8'));
    if (m) return m[1].trim();
  }
  return undefined;
}

// Best-effort read of the dev server's host + port. Vite configs are code, so this is a
// heuristic over the `server: { … }` block: literal numbers, `Number(env.PORT) || 5173`
// (resolved through the app's .env), and `host: 'x.localhost' | true`. The result is
// printed so a wrong guess is visible; `--port`/`--app` and the .pinpoint.json file are
// the escape hatches. The overlay itself doesn't depend on this — it's for the record
// (and the server's Origin allowlist, which also accepts localhost / *.localhost).
export function detectServer(appDir: string, cfg: string): Server {
  const s = cfg.search(/\bserver\s*:\s*\{/);
  const scope = s >= 0 ? cfg.slice(s, s + 1500) : cfg;
  let host = 'localhost';
  const hm = /\bhost\s*:\s*(['"`])([^'"`]+)\1/.exec(scope);
  if (hm && hm[2] !== '0.0.0.0' && hm[2] !== '::') host = hm[2];
  let port = 5173;
  let note = 'vite default';
  const pm = /\bport\s*:\s*([^,\n}\]]+)/.exec(scope);
  if (pm) {
    const expr = pm[1].trim();
    const lit = /^(\d{2,5})$/.exec(expr);
    const ev = /env\.([A-Z0-9_]+)/.exec(expr);
    const fb = /\|\|\s*['"]?(\d{2,5})/.exec(expr);
    const v = ev ? readEnvVar(appDir, ev[1]) : undefined;
    if (lit) { port = Number(lit[1]); note = 'config literal'; }
    else if (v && /^\d+$/.test(v)) { port = Number(v); note = `.env ${ev![1]}`; }
    else if (fb) { port = Number(fb[1]); note = `config fallback${ev ? ` (${ev[1]} unset)` : ''}`; }
    else note = `unparsed "${expr.slice(0, 30)}" → default`;
  }
  return { host, port, note };
}

// A session-dispatch handler for an installed repo must be named pinpoint_<name>. Prefer
// the npm scope the apps share (`@orgspace/core` → orgspace: the product name survives a
// repo directory rename), then the root package name, then the directory name.
function detectName(root: string, appDirs: string[]): { name: string; note: string } {
  const scopes = new Set<string>();
  for (const d of appDirs) {
    try { const m = /^@([^/]+)\//.exec(String(JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).name || '')); if (m) scopes.add(m[1]); } catch { /* no package.json */ }
  }
  if (scopes.size === 1) return { name: [...scopes][0], note: 'npm scope of the apps' };
  try { const n = String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name || ''); if (n) return { name: n.replace(/^@[^/]+\//, ''), note: 'root package.json name' }; } catch { /* none */ }
  return { name: basename(root), note: 'directory name' };
}
const slugName = (x: string) => x.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

// ─── config patch ─────────────────────────────────────────────────────────────
export function patchConfig(text: string): Patch {
  if (new RegExp(`['"]${PKG}/vite['"]`).test(text)) return { text, changed: false, reason: 'already wired' };
  if (/vite-pinpoint/.test(text)) return { text, changed: false, reason: 'already wired (local vite-pinpoint plugin — switch its import to ' + PKG + '/vite when convenient)' };
  const arrays = [...text.matchAll(/\bplugins\s*:\s*\[/g)];
  if (arrays.length !== 1) return { text, changed: false, reason: `${arrays.length} \`plugins: [\` arrays found — wire by hand` };
  const imports = [...text.matchAll(/^import[^;]*;[ \t]*$/gm)];
  if (!imports.length) return { text, changed: false, reason: 'no import statements found — wire by hand' };
  const last = imports[imports.length - 1];
  const at = last.index! + last[0].length;
  const q = /from\s+"/.test(last[0]) ? '"' : "'";
  const importLine = `import { pinpoint } from ${q}${PKG}/vite${q};`;
  let out = text.slice(0, at) + '\n' + importLine + text.slice(at);
  const m = /\bplugins\s*:\s*\[/.exec(out)!;
  const after = m.index + m[0].length;
  const nl = out.indexOf('\n', after);
  let pluginLine: string;
  if (nl < 0 || /\S/.test(out.slice(after, nl))) {
    // inline array: `plugins: [react()]` → `[pinpoint(), react()]`; empty `[]` → `[pinpoint()]`
    const rest = out.slice(after);
    const empty = /^\s*\]/.test(rest);
    out = out.slice(0, after) + (empty ? 'pinpoint()' : 'pinpoint(), ') + rest;
    pluginLine = 'pinpoint() (inline)';
  } else {
    const indent = (/^([ \t]*)\S/.exec(out.slice(nl + 1)) || [, '  '])[1] as string;
    pluginLine = `${indent}pinpoint(),`;
    out = out.slice(0, nl + 1) + pluginLine + '\n' + out.slice(nl + 1);
  }
  return { text: out, changed: true, preview: [`+ ${importLine}`, `+ ${pluginLine.trim()}  (first entry of plugins)`] };
}

// ─── dependency ───────────────────────────────────────────────────────────────
export function addCommand(root: string, spec: string): string[] {
  const has = (f: string) => existsSync(join(root, f));
  let pm = 'bun';
  if (has('bun.lock') || has('bun.lockb')) pm = 'bun';
  else if (has('pnpm-lock.yaml')) pm = 'pnpm';
  else if (has('yarn.lock')) pm = 'yarn';
  else if (has('package-lock.json')) pm = 'npm';
  else { try { const p = String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager || ''); if (p) pm = p.split('@')[0]; } catch {} }
  switch (pm) {
    case 'pnpm': return ['pnpm', 'add', '-D', ...(has('pnpm-workspace.yaml') ? ['-w'] : []), spec];
    case 'yarn': return ['yarn', 'add', '-D', ...(has('yarn.lock') && /workspaces/.test(safeRead(join(root, 'package.json'))) ? ['-W'] : []), spec];
    case 'npm': return ['npm', 'install', '-D', spec];
    default: return ['bun', 'add', '-D', spec];
  }
}
const safeRead = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

// ─── port ─────────────────────────────────────────────────────────────────────
function portInUse(p: number): boolean {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}
function pickPort(appPorts: number[], existing: number | undefined, portArg?: string): { port: number; note: string } {
  if (portArg) return { port: Number(portArg), note: '--port' };
  if (existing) return { port: existing, note: '.pinpoint.json (kept)' };
  // Convention: the repo's port block + 91 (8404 → 8491, 4903 → 4991, 5173 → 5191) so
  // the pinpoint port reads as part of the project, then bump past anything taken.
  const base = Math.floor(Math.min(...(appPorts.length ? appPorts : [4900])) / 100) * 100 + 91;
  for (let p = base; p < base + 20; p++) if (!appPorts.includes(p) && !portInUse(p)) return { port: p, note: p === base ? 'derived from app ports' : `derived, ${base} taken` };
  return { port: base, note: 'derived (could not verify free)' };
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
