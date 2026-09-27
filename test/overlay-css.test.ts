import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// The overlay injects its CSS as plain strings into the host page (no shadow DOM), so a host's
// global form-control rule can out-rank it. OrgSpace's
//   body:not(:has(.hal-app)) :is(input:not(...), select, textarea) { min-height:44px; font-size:16px }
// is specificity (0,4,2) and beat `.dr-chat .m .qi` (0,3,0). Every overlay control therefore needs
// a guard rule carrying an id-weight booster that re-asserts the properties hosts override.
const src = readFileSync(join(import.meta.dir, '..', 'overlay', 'pinpoint.js'), 'utf8');
const block = (name: string) => {
  const start = src.indexOf(`const ${name} = \``);
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('`;', start));
};
const cssText = block('css') + '\n' + block('chatCss');

/** Every rule whose selector list names `sel` with an id booster, as { prop: value }. */
function guarded(sel: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of cssText.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim());
    if (!sels.includes(`${sel}:not(#_pp)`)) continue;
    for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim(); }
  }
  return out;
}

// selector → the values the overlay's own rules give that control today
const CONTROLS: Record<string, Record<string, string>> = {
  '.dr-pop textarea': { font: '13px/1.4 system-ui,sans-serif', 'min-height': '64px', padding: '8px 10px' },
  '.dr-pop textarea.fix': { 'min-height': '44px' },
  '.dr-fp-bd textarea': { font: '12px/1.4 system-ui,sans-serif', 'min-height': '56px', padding: '8px 10px' },
  '.dr-dock-fly input[type=range]': { height: '24px', 'min-height': 'auto' },
  '.dr-dock-fly .tints input[type=color]': { height: '26px', 'min-height': 'auto', padding: '0' },
  '.dr-dock-fly .tints .hex': { font: '11px ui-monospace,Menlo,monospace', height: '26px', 'min-height': 'auto', padding: '0 7px' },
  '.dr-chat-sel .rn-in': { font: 'inherit', 'min-height': 'auto', padding: '1px 6px' },
  '.dr-chat .m .qi': { font: '12px/1.4 ui-monospace,Menlo,SFMono-Regular,monospace', 'min-height': 'auto', padding: '7px 10px' },
  '.dr-chat-ta': { font: '13px/1.4 system-ui,sans-serif', 'min-height': '44px', height: '72px', padding: '9px 11px 4px' },
};

describe('overlay form controls vs host CSS', () => {
  for (const [sel, want] of Object.entries(CONTROLS)) {
    test(`${sel} re-asserts its own box and font behind an id booster`, () => {
      expect(guarded(sel)).toMatchObject(want);
    });
  }
  // class the overlay gives a created control → the guarded selector that covers it
  const COVERS: Record<string, string> = { c: '.dr-pop textarea', fix: '.dr-pop textarea.fix', gen: '.dr-fp-bd textarea', hex: '.dr-dock-fly .tints .hex', 'rn-in': '.dr-chat-sel .rn-in', qi: '.dr-chat .m .qi', 'dr-chat-ta': '.dr-chat-ta' };
  test('every control the overlay creates has a guard rule', () => {
    const classes = new Set<string>();
    for (const m of src.matchAll(/el\('(?:input|textarea|select)', '([\w-]+)'/g)) classes.add(m[1]);
    for (const m of src.matchAll(/<(?:input|textarea|select) class="([\w-]+)"/g)) classes.add(m[1]);
    for (const m of src.matchAll(/createElement\('(?:input|textarea|select)'\);[^\n]*?className = '([\w-]+)'/g)) classes.add(m[1]);
    expect([...classes].sort()).toEqual(Object.keys(COVERS).sort()); // a new control must join COVERS (and get a guard)
    for (const c of classes) expect(Object.keys(guarded(COVERS[c])).length).toBeGreaterThan(0);
  });
});
