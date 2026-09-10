# Changelog

All notable changes to this project will be documented in this file.

## [0.6.1] - 2026-09-10

### Changed
- 🚸 The update check runs whenever a worker spawns or resumes, plus every 4 hours for a server left
  running with no workers — it used to run at most once every 4 hours. Still on start, still in the
  background with an 8s cap, and never two at once. The open drawer re-reads `/api/health` with its
  15s conversation poll, so a `vX.Y.Z available` chip shows up within one poll of the spawn that
  found it, not on the next page load (server, overlay)

### Tests
- ✅ A tag pushed after the server started is reported after the next worker spawn, and a later one after the next resume (server)

## [0.6.0] - 2026-09-10

### Features
- ✨ Effort pill beside the model pill in the drawer's composer: pick `--effort
  low|medium|high|xhigh|max` per project, adopted from a conversation when you open it, and applied
  the way a model switch is — the idle process is ended and the next message resumes the same
  session with the new flag. The CLI never reports the effort it settled on, so an unset pill reads
  "effort" rather than naming a default (overlay, server)
- ✨ Attach any file, not just screenshots — picker, paste and drop. An image is still downscaled
  and sent inline; anything else is written to `workers/<id>/file-*.ext` and named in the prompt, so
  the worker Reads it instead of carrying base64 into the context. Only a `[A-Za-z0-9]{1,8}`
  extension from the reviewer's filename reaches the path, and a non-image is served back as an
  octet-stream download so an attached `.html` cannot run on the overlay's origin (overlay, server)
- ✨ Idle conversations count down to their close in the conversation picker — `30m`, then `45s`,
  then `now` — from the row's `lastAt` and the `idleMinutes` / `recapOnIdle` the server now
  advertises in `BRAND`. Ticked in place every 10s, and not at all while the drawer is closed
  (overlay, server)
- ✨ Workers publish artifacts themselves. `claude -p` leaves the `Artifact` tool off unless
  `CLAUDE_CODE_ARTIFACT` is on (Claude Code's `sdk_default_off` gate), so a worker asked for an artifact could
  only build a file and hand the reviewer a step. Every worker now starts with `CLAUDE_CODE_ARTIFACT=1`; brief
  step 8 says to publish and reply with the link. `worker.artifacts: false` turns it off, and wins over a value the
  server inherited (server)

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
- 💄 State chips line up down the conversation picker: the countdown takes its own column, and state
  and countdown get fixed widths (50px fits STARTING), both right-aligned, so the row icons stay put
  whether or not a countdown is showing (overlay)

### Fixed
- 🐛 A question's last answer wins: tapping a choice and then typing sent both, joined by a newline.
  Typing now releases the tap (every pick, in a multi-select step) and tapping clears what was typed;
  the placeholder reads "Type your own instead…" (overlay)
- 🐛 A headless worker no longer tells the reviewer it "can't" do what an interactive session can. It
  usually lacks `Artifact`, `AskUserQuestion`, plan mode and the claude.ai connectors, and once spent five
  turns arguing it could not make an artifact. Brief step 8 now says to use such a tool when it is listed, and otherwise that a missing tool is
  not a missing capability: build what needs no missing tool, then name the finishing step in one line — *Continue
  in a terminal* or `cd <root> && claude --resume <session>`, which `batchPrompt` now receives, with the root shell-quoted the same way *Continue in a terminal* quotes it (server)

### Tests
- ✅ Workers start with `CLAUDE_CODE_ARTIFACT=1`, `worker.artifacts: false` forces `0` over an inherited `1`, and the brief says to reply with the link (server)
- ✅ Evals re-run against real `claude -p` workers: artifacts are published and the reply carries the link; a fifth eval covers `worker.artifacts: false` (skill)
- ✅ The spawned worker's stdin carries the step-8 rule and its own `claude --resume <session>` (server)
- ✅ `skill/evals/evals.json`: four behavioural evals — artifact on first ask, pushback after a markdown
  file, "another session did it", plan-mode request — with a synthetic meeting-notes fixture (skill)

### Documentation
- 📝 Skill, README and protocol: workers publish artifacts; `worker.artifacts` (skill, docs)
- 📝 Skill: *A missing tool is not a missing capability* under Headless workers, cross-referenced from
  step 7 and the Don'ts (skill)
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
