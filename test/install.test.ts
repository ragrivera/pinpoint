import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { BIN, cleanEnv, tmpProject } from './helpers.ts';

const VITE_MULTILINE = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
  ],
  server: { host: 'acme.localhost', port: 8404 },
});
`;
const VITE_INLINE = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()] });
`;
const SKILL = readFileSync(join(import.meta.dir, '..', 'skill', 'SKILL.md'), 'utf8');

function monorepo() {
  const p = tmpProject({
    'package.json': JSON.stringify({ name: 'acme-root', private: true, workspaces: ['apps/*'] }),
    '.gitignore': 'node_modules/\n',
    'apps/web/package.json': JSON.stringify({ name: '@acme/web' }),
    'apps/web/vite.config.ts': VITE_MULTILINE,
    'apps/api/package.json': JSON.stringify({ name: '@acme/api' }),
  });
  mkdirSync(join(p.root, '.git'));
  return p;
}
const install = (root: string, ...extra: string[]) => {
  const r = Bun.spawnSync(['bun', BIN, 'install', '--root', root, '--no-add', '--no-phoenix', ...extra], { cwd: root, env: cleanEnv() });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

describe('pinpoint install', () => {
  test('wires a monorepo: .pinpoint.json, vite plugin, .mcp.json, skill, gitignore — then is idempotent', () => {
    const p = monorepo();
    try {
      const first = install(p.root);
      expect(first.code).toBe(0);
      expect(first.out).toContain('dev server: http://acme.localhost:8404   (config literal)');

      const cfg = JSON.parse(readFileSync(join(p.root, '.pinpoint.json'), 'utf8'));
      expect(cfg).toMatchObject({ name: 'acme', session: 'pinpoint_acme', dispatch: 'worker', apps: [{ dir: 'apps/web', origin: 'http://acme.localhost:8404' }] });
      expect(cfg.port).toBeGreaterThanOrEqual(8491); // app block 8400 + 91, bumped past ports in use on this machine
      expect(cfg.port).toBeLessThan(8511);
      expect(cfg.server).toBeUndefined();

      const vite = readFileSync(join(p.root, 'apps/web/vite.config.ts'), 'utf8');
      expect(vite).toContain("import react from '@vitejs/plugin-react';\nimport { pinpoint } from 'pinpoint-live/vite';");
      expect(vite).toContain('plugins: [\n    pinpoint(),\n    react(),');

      const mcp = JSON.parse(readFileSync(join(p.root, '.mcp.json'), 'utf8'));
      expect(mcp.mcpServers.pinpoint).toEqual({ command: 'bun', args: ['run', 'pinpoint', 'serve'] });

      expect(readFileSync(join(p.root, '.claude/skills/pinpoint/SKILL.md'), 'utf8')).toBe(SKILL);
      expect(readFileSync(join(p.root, '.gitignore'), 'utf8')).toContain('\n.docs/pinpoint/\n');
      expect(existsSync(join(p.root, '.docs/pinpoint/feedback'))).toBe(true);
      expect(first.out).toContain('pinpoint-live: not in node_modules (--no-add) — add it: bun add -D pinpoint-live');

      const second = install(p.root);
      expect(second.code).toBe(0);
      expect(second.out).toContain('vite.config: already wired');
      expect(second.out).toContain('.pinpoint.json: unchanged');
      expect(second.out).toContain('.mcp.json: pinpoint server present');
      expect(second.out).toContain('SKILL.md: up to date');
      expect(second.out).toContain('Applied 0 change(s)');
      expect(readFileSync(join(p.root, 'apps/web/vite.config.ts'), 'utf8')).toBe(vite);
    } finally { p.rm(); }
  });

  test('inline plugins array, existing .mcp.json merge, root vite app, --port', () => {
    const p = tmpProject({
      'package.json': JSON.stringify({ name: '@acme/site' }),
      'vite.config.ts': VITE_INLINE,
      '.mcp.json': JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }),
      'pnpm-lock.yaml': '',
    });
    mkdirSync(join(p.root, '.git'));
    try {
      const r = install(p.root, '--port', '6191');
      expect(r.code).toBe(0);
      expect(readFileSync(join(p.root, 'vite.config.ts'), 'utf8')).toContain('plugins: [pinpoint(), react()]');
      expect(readFileSync(join(p.root, 'vite.config.ts'), 'utf8')).toContain('import { pinpoint } from "pinpoint-live/vite";');
      const cfg = JSON.parse(readFileSync(join(p.root, '.pinpoint.json'), 'utf8'));
      expect(cfg).toMatchObject({ port: 6191, name: 'acme', session: 'pinpoint_acme', apps: [{ dir: '.', origin: 'http://localhost:5173' }] });
      const mcp = JSON.parse(readFileSync(join(p.root, '.mcp.json'), 'utf8'));
      expect(Object.keys(mcp.mcpServers).sort()).toEqual(['other', 'pinpoint']);
      expect(r.out).toContain('add it: pnpm add -D pinpoint-live'); // package manager from the lockfile
    } finally { p.rm(); }
  });

  test('--dry-run writes nothing; a Next.js app gets the <PinpointScript/> snippet', () => {
    const p = tmpProject({
      'package.json': JSON.stringify({ name: 'acme' }),
      'apps/web/vite.config.ts': VITE_MULTILINE,
      'apps/site/next.config.mjs': 'export default {};',
    });
    mkdirSync(join(p.root, '.git'));
    try {
      const r = install(p.root, '--dry-run', '--port', '7191');
      expect(r.code).toBe(0);
      expect(r.out).toContain('Nothing written.');
      expect(r.out).toContain('apps/site  (Next.js — not wired automatically)');
      expect(r.out).toContain('<PinpointScript origin="http://127.0.0.1:7191" />');
      expect(existsSync(join(p.root, '.pinpoint.json'))).toBe(false);
      expect(existsSync(join(p.root, '.mcp.json'))).toBe(false);
      expect(readFileSync(join(p.root, 'apps/web/vite.config.ts'), 'utf8')).toBe(VITE_MULTILINE);
    } finally { p.rm(); }
  });

  test('refuses to guess when a config has several plugins arrays', () => {
    const p = tmpProject({
      'package.json': JSON.stringify({ name: 'acme' }),
      'vite.config.ts': "import { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [], worker: { plugins: [] } });\n",
    });
    mkdirSync(join(p.root, '.git'));
    try {
      const r = install(p.root);
      expect(r.code).toBe(0);
      expect(r.out).toContain('2 `plugins: [` arrays found — wire by hand');
      expect(readFileSync(join(p.root, 'vite.config.ts'), 'utf8')).not.toContain('pinpoint');
    } finally { p.rm(); }
  });
});
