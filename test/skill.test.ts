import { describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { refreshProjectSkill } from '../src/skill.ts';
import { tmpProject } from './helpers.ts';

// A repo's .claude/skills/pinpoint/SKILL.md is a copy of the one the package ships. It used to be written once and never
// again, so an upgraded repo kept an old skill (OrgSpace's lacked the "Recommended — " rule for months). The refresh
// keeps the copy in step with the package, and is what install, server start and the drawer's update all call.
describe('refreshProjectSkill', () => {
  const packaged = (p: { root: string }, body = '# pinpoint skill v2\n') => { const f = join(p.root, 'pkg-skill.md'); writeFileSync(f, body); return f; };
  const copy = (p: { root: string }) => join(p.root, '.claude', 'skills', 'pinpoint', 'SKILL.md');

  test('missing → written', () => {
    const p = tmpProject();
    try {
      expect(refreshProjectSkill(p.root, packaged(p))).toBe('written');
      expect(readFileSync(copy(p), 'utf8')).toBe('# pinpoint skill v2\n');
    } finally { p.rm(); }
  });

  test('differs → rewritten', () => {
    const p = tmpProject({ '.claude/skills/pinpoint/SKILL.md': '# pinpoint skill v1\n' });
    try {
      expect(refreshProjectSkill(p.root, packaged(p))).toBe('updated');
      expect(readFileSync(copy(p), 'utf8')).toBe('# pinpoint skill v2\n');
    } finally { p.rm(); }
  });

  test('same → untouched (not even re-written)', () => {
    const p = tmpProject({ '.claude/skills/pinpoint/SKILL.md': '# pinpoint skill v2\n' });
    try {
      const old = new Date('2020-01-01T00:00:00Z'); utimesSync(copy(p), old, old);
      expect(refreshProjectSkill(p.root, packaged(p))).toBe('current');
      expect(statSync(copy(p)).mtime.getTime()).toBe(old.getTime());
    } finally { p.rm(); }
  });

  test('dry: reports what it would do and writes nothing', () => {
    const p = tmpProject({ '.claude/skills/pinpoint/SKILL.md': '# pinpoint skill v1\n' });
    try {
      expect(refreshProjectSkill(p.root, packaged(p), { dry: true })).toBe('updated');
      expect(readFileSync(copy(p), 'utf8')).toBe('# pinpoint skill v1\n');
    } finally { p.rm(); }
  });

  test('a symlinked skill dir (pinpoint skill --link) and a missing packaged skill are left alone', () => {
    const p = tmpProject({ 'elsewhere/SKILL.md': 'linked\n' });
    try {
      mkdirSync(join(p.root, '.claude', 'skills'), { recursive: true });
      symlinkSync(join(p.root, 'elsewhere'), join(p.root, '.claude', 'skills', 'pinpoint'));
      expect(refreshProjectSkill(p.root, packaged(p))).toBe('linked');
      expect(readFileSync(join(p.root, 'elsewhere', 'SKILL.md'), 'utf8')).toBe('linked\n');
      expect(lstatSync(join(p.root, '.claude', 'skills', 'pinpoint')).isSymbolicLink()).toBe(true);
      expect(refreshProjectSkill(p.root, join(p.root, 'no-such-skill.md'))).toBe('none');
    } finally { p.rm(); }
  });

  test('never writes the user-level ~/.claude/skills/pinpoint (a legacy copy other repos use)', () => {
    const home = tmpProject({ '.claude/skills/pinpoint/SKILL.md': 'legacy\n' });
    const prev = process.env.HOME; process.env.HOME = home.root;
    try {
      expect(refreshProjectSkill(home.root, packaged(home))).toBe('skipped'); // a project whose root is the home dir
      expect(readFileSync(join(home.root, '.claude', 'skills', 'pinpoint', 'SKILL.md'), 'utf8')).toBe('legacy\n');
      expect(existsSync(join(home.root, 'pkg-skill.md'))).toBe(true);
    } finally { process.env.HOME = prev; home.rm(); }
  });
});
