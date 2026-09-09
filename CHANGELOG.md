# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- 💄 The recap is drawn as a dashed frame with its label notched into the top edge, the way a
  legend sits in a fieldset. The three edges are painted with repeating gradients rather than a
  dashed border, because `border-style:dashed` leaves the dash length to the browser and at 1px
  picks one too fine to read; dash and gap live in `--rc-d` / `--rc-g` / `--rc-c`. Body drops to
  11.5px mono and loses the italic (overlay)
- 💄 A message that is nothing but a recap no longer draws the ⏺ bullet or reserves its gutter —
  the frame already marks it. Scoped to assistant messages, so a reviewer who types a literal
  `recap:` line keeps their `>` and bubble padding (overlay)
- 💄 The idle-recap nudge, "worker stopping" and "worker exited" no longer take a transcript row.
  Each of those events carries `state`, so the drawer header still names them — a transient state
  belongs there, not in the history (overlay)
- 💄 "turn done · 9s · $0.12" no longer trails a recap: the recap says the work is closed. A
  failed turn still gets its row (overlay)

### Documentation
- 📝 Skill step 7 now tells the worker that `AskUserQuestion` does not exist for it and that the
  `question` fence is the picker, with the fence syntax, `question multi` and the stepper, before
  the `Recommended` marker it used to open with (skill)

## [0.5.0] - 2026-09-09

### Features
- ✨ Model pill in the drawer's composer (and a *Model:* line in the panel): pick which Claude the
  worker runs — Default / Fable / Opus / Opus 1M / Sonnet / Haiku, `worker.models` to replace it and
  `worker.model` to preselect one. The pick rides along with *Send*, and `POST /api/chat/:id/model`
  switches an open conversation: the running process keeps its model, so it is ended once it is
  quiet and the next message resumes the same Claude session on the new one (overlay, server)

### Fixed
- 🐛 Pin the properties a host app's bare `.cb` / `.menu` rules leaked into the overlay — a 16px
  checkbox rule collapsed transcript code blocks to one character wide, and a dropdown's `top`
  stretched the model menu to 10px tall (overlay)

### Infrastructure
- 🔧 Add a GitHub Actions workflow running type-check and tests on every pull request and push to main (ci)
