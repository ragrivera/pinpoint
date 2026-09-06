// skill.ts — `pinpoint skill`: put the /pinpoint Claude Code skill where Claude will find it.
//
//   pinpoint skill            → <project root>/.claude/skills/pinpoint/SKILL.md   (commit it: the team shares it)
//   pinpoint skill --user     → ~/.claude/skills/pinpoint/SKILL.md               (this machine, every repo)
//   pinpoint skill --link     → symlink the package's skill/ dir instead of copying (edits flow both ways)
//   pinpoint skill --force    → overwrite an existing copy
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { findProject } from './config.js';

export const SKILL_SRC_DIR = join(import.meta.dir, '..', 'skill');
export const SKILL_SRC = join(SKILL_SRC_DIR, 'SKILL.md');

/** Returns the process exit code. */
export function run(argv: string[]): number {
  const user = argv.includes('--user');
  const link = argv.includes('--link');
  const force = argv.includes('--force');
  const unknown = argv.filter((a) => !['--user', '--link', '--force'].includes(a));
  if (unknown.length) { console.error(`unknown argument(s): ${unknown.join(' ')}\nusage: pinpoint skill [--user] [--link] [--force]`); return 2; }
  const base = user ? join(process.env.HOME || homedir(), '.claude', 'skills') : join(findProject(process.env.PINPOINT_ROOT || process.cwd()).root, '.claude', 'skills');
  const dir = join(base, 'pinpoint');
  const isLink = existsSync(dir) || isSymlink(dir) ? isSymlink(dir) : false;
  if (link) {
    if (isLink && readlinkSync(dir) === SKILL_SRC_DIR) { console.log(`${dir} -> ${SKILL_SRC_DIR} (already linked)`); return 0; }
    if (existsSync(dir) && !isLink && !force) { console.error(`${dir} exists as a real directory — remove it or pass --force to replace it with a symlink`); return 1; }
    if (isLink || (force && existsSync(dir) && isLink)) unlinkSync(dir);
    if (existsSync(dir)) { console.error(`${dir} still exists — remove it by hand`); return 1; }
    mkdirSync(base, { recursive: true });
    symlinkSync(SKILL_SRC_DIR, dir);
    console.log(`${dir} -> ${SKILL_SRC_DIR}`);
    return 0;
  }
  const file = join(dir, 'SKILL.md');
  const src = readFileSync(SKILL_SRC, 'utf8');
  if (isLink) { console.log(`${dir} is a symlink to ${readlinkSync(dir)} — nothing to copy`); return 0; }
  if (existsSync(file) && !force) {
    console.log(readFileSync(file, 'utf8') === src ? `${file} (up to date)` : `${file} exists and differs — pass --force to overwrite`);
    return 0;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, src);
  console.log(`wrote ${file}`);
  return 0;
}
function isSymlink(p: string): boolean { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

if (import.meta.main) process.exit(run(process.argv.slice(2)));
