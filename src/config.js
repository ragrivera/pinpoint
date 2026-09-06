// config.js — find the project's `.pinpoint.json` (written by `pinpoint install`).
// Plain JS on purpose: the Vite plugin and the React helper import this from a Node
// process, where TypeScript sources are not loadable. The server, installer and CLI
// (which run under Bun) import it too, so every part of pinpoint resolves the project
// root and port the same way: the nearest `.pinpoint.json` above `from`, else `from`.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const CONFIG_FILE = '.pinpoint.json';
export const DEFAULT_PORT = 4991;

/** Walk up from `from` to the nearest `.pinpoint.json`. */
export function findProject(from = process.cwd()) {
  let dir = resolve(from);
  for (;;) {
    const file = join(dir, CONFIG_FILE);
    if (existsSync(file)) {
      let config = null;
      try { config = JSON.parse(readFileSync(file, 'utf8')); } catch { config = null; }
      return { root: dir, file, config };
    }
    const up = dirname(dir);
    if (up === dir) return { root: resolve(from), file: null, config: null };
    dir = up;
  }
}

/** The pinpoint server port for the project above `from`. */
export function projectPort(from = process.cwd()) {
  const { config } = findProject(from);
  const p = Number(config && config.port);
  return p > 0 ? p : DEFAULT_PORT;
}
