// report.ts — `pinpoint report`: CLI twin of the `report_pin` MCP tool, for sessions that
// drive pins via the folder watcher instead of the MCP. Writes per-pin progress into the
// batch file (same shape the server's reportPin() writes), so the overlay's progress card
// (which polls GET /api/pins/:id on the HTTP owner) updates.
//
//   pinpoint report <batch-id> <pin#|0=general note> <working|done|skipped|question> [note] [--by <session id>] [--dir <feedback dir>]
//
//   --dir points at another feedback store. PINPOINT_ROOT overrides where the project-root
//   walk starts (default: cwd); the root is the nearest dir with a .pinpoint.json, else cwd.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { findProject } from './config.js';

export const USAGE = 'usage: pinpoint report <batch-id> <pin#> <working|done|skipped|question> [note] [--by <session id>] [--dir <feedback dir>]';
const STATUSES = ['working', 'done', 'skipped', 'question'];

/** Returns the process exit code. */
export function run(argv: string[]): number {
  const args = argv.slice();
  const byIdx = args.indexOf('--by');
  const by = byIdx >= 0 ? args.splice(byIdx, 2)[1] : process.env.PINPOINT_SESSION_ID || '';
  const dirIdx = args.indexOf('--dir');
  const dirOverride = dirIdx >= 0 ? args.splice(dirIdx, 2)[1] : '';
  const [id, pinArg, status, ...noteParts] = args;
  if (!id || !pinArg || !STATUSES.includes(status || '')) { console.error(USAGE); return 2; }
  const dir = dirOverride ? resolve(dirOverride) : join(findProject(process.env.PINPOINT_ROOT || process.cwd()).root, '.docs', 'pinpoint', 'feedback');
  const file = existsSync(dir) ? readdirSync(dir).find((n) => n === `${id}.json` || (n.startsWith(`${id}.claimed-`) && n.endsWith('.json'))) : undefined;
  if (!file) { console.error(`batch not found: ${id}`); return 1; }
  const path = join(dir, file);
  const b = JSON.parse(readFileSync(path, 'utf8'));
  const pin = Number(pinArg);
  // Key "0" = the batch's general note (only meaningful when it is non-empty).
  if (pin === 0 && !(typeof b.general === 'string' && b.general.trim())) { console.error('pin 0 is the general note, but this batch has none'); return 1; }
  if (pin < 0 || !Number.isInteger(pin) || (pin > 0 && Array.isArray(b.pins) && pin > b.pins.length)) { console.error(`pin ${pin} out of range`); return 1; }
  const note = noteParts.join(' ').trim();
  b.progress = { ...(b.progress || {}), [pin]: { status, note: note ? note.slice(0, 200) : undefined, at: new Date().toISOString(), by: by || undefined } };
  writeFileSync(path, JSON.stringify(b, null, 2));
  const keys = Array.isArray(b.pins) && b.pins.length ? b.pins.map((_: unknown, i: number) => String(i + 1)) : ['0'];
  const resolved = keys.filter((k: string) => b.progress[k] && b.progress[k].status !== 'working').length;
  console.log(`${id} #${pin} ${status} (${resolved}/${keys.length})`);
  return 0;
}

if (import.meta.main) process.exit(run(process.argv.slice(2)));
