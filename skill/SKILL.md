---
name: pinpoint
description: Live-code review loop — the user pins elements on the RUNNING app (localhost dev server) with the PINPOINT overlay, Claude receives the batch via the `pinpoint` MCP, resolves each pin to its source component, fixes it in place, and replies by pin number. Use when the user says "check my pins", "pinpoint", "I pinned something on the app", or wants to annotate a live page. ALSO use for `/pinpoint --install` and any phrasing like "wire pinpoint into this repo", "set up pinpoint for this project", "make this project use pinpoint", or "the Pinpoint pill isn't showing on my app" — that runs `pinpoint install`, which gives the repo its own pinpoint server port and handler-session name (.pinpoint.json → a session-dispatch handler must be named pinpoint_<project>) and wires the overlay into every Vite app. Mockups under `.docs/open-design` served by the pinpoint server ride the same loop (the worker edits the artifact, never app source); other static mockups are not this skill's job. FLUTTER apps ride it too, with zero app code — `pinpoint flutter --vm-uri <the URI flutter run prints>` turns on the widget inspector's tap-to-select, taps arrive pre-resolved to source on the GET /flutter panel, and pins carry `source: {file, line, column}` instead of a DOM element (use for "pin the mobile app", "pinpoint on flutter", "tap-to-pin").
---

# pinpoint — pin the live app, fix the source

Pins land on real routes and real DOM, so the fix goes into the app's source. The pieces:

| | |
|---|---|
| overlay | `/pinpoint.js`, served by this repo's pinpoint server (port from `.pinpoint.json`, default 4991), injected by the Vite plugin (`pinpoint-live/vite`) or `<PinpointScript/>` (`pinpoint-live/react`) |
| server | `bun run pinpoint serve` — one process, MCP over stdio + HTTP; the repo's `.mcp.json` starts it with every Claude session |
| batches | `.docs/pinpoint/feedback/<id>.json` (gitignored) |
| MCP tools | `wait_for_pins` / `get_pins` / `list_pins` / `report_pin` / `list_sessions` |

Every installed repo has its **own** server port: the first session opened in a repo owns that
port, later sessions in the same repo start in MCP-only follower mode and pick batches up from
the shared directory, so `wait_for_pins` works in every session — and repos never see each
other's pins.

## Headless workers + chat (the default for installed projects)

Nothing has to be waiting. With `"dispatch": "worker"` in `.pinpoint.json` (the default
`pinpoint install` writes, and what the server assumes when the key is absent), **Send**
in the overlay:

1. writes the batch to `.docs/pinpoint/feedback/<id>.claimed-<workerId>.json` (pre-claimed —
   no session can take it, the progress card never says "waiting"), and
2. spawns a **worker**: `claude -p --input-format stream-json --output-format stream-json
   --dangerously-skip-permissions --session-id <uuid>` from the repo root, with only the
   pinpoint MCP loaded (`worker.mcp: "all"` loads every user MCP). The worker gets a brief
   with the page, viewport, general note and pins, resolves them to source, fixes in place,
   reports each pin through `report_pin`, and replies as a numbered list.

The overlay opens a **chat drawer** (right edge by default, a header button parks it on the
left instead; `C` toggles it, `Esc` closes it, the 💬 button on the panel and the *chat*
button on a progress card open it). The drawer takes
precedence over the floating panel: while it is open the panel is hidden and the progress
stack shifts left; `R` and the pins keep working. It streams the worker's transcript
(`GET /api/chat/:id/events`, SSE: replay then live — assistant text, tool lines, pin
progress, turn results) and follow-ups typed there go to the same worker (`POST
/api/chat/:id`). The worker's stdin stays open, so a follow-up costs no cold start; after
`worker.idleMinutes` (30) it exits and the next message resumes the same Claude session
(`--resume <uuid>`). *stop* in the drawer ends the process early. A message in the drawer
with no conversation selected starts a new worker for the page (sent as a note-only batch).
Pins placed while the drawer is open ride along with the next message. Screenshots can be
pasted or dropped into the drawer. `/` as the first character lists the skills and commands
the worker can run. One conversation per batch; the picker lists them newest first, each row with a *rename*
(a local label, per browser) and a *close* (`POST /api/chat/:id/close`: ends the worker if
running and parks its record as `<id>.json.closed` so a restart does not revive it; a running
worker asks for a second click).
Transcripts (`<id>.chat.jsonl`) and worker records (`<id>.json`) live in
`.docs/pinpoint/workers/`; the batch itself stays in `feedback/`.

Cost/latency: a worker pays the normal session cold start (~15–30 s) once per batch, then
runs like any Claude Code session. It has no human to ask: a `question` pin gets its answer
in the pin note and the reply; the reviewer continues in the chat.

Security: every `/api/*` route rejects browser requests whose `Origin` is not one of the
project's app origins (from `.pinpoint.json` `apps[].origin`) or localhost / 127.0.0.1 /
`*.localhost`. Workers run with permission prompts skipped, so that guard is what keeps a
foreign page from posting into one. Do not widen it.

`"dispatch": "session"` (or `PINPOINT_DISPATCH=session`) restores the loop below — a live
`pinpoint_<name>` session claims batches. Either way the **To:** picker can address a live
session explicitly, and *Headless worker* forces a worker for one batch. Other keys:
`claudeBin` (path to the `claude` binary; default `which claude` → `~/.local/bin/claude`),
`worker.args` (extra `claude` flags).

## Flutter apps — tap-to-pin with zero app code

A Flutter app has no DOM and no Vite, so nothing is injected into it. Instead, `pinpoint
flutter --vm-uri <uri>` (the URI `flutter run` prints: "A Dart VM Service … is available
at: http://127.0.0.1:PORT/TOKEN=/") connects to the app's VM service, turns on the widget
inspector's on-device **select mode**, and resolves every tap to the widget's creation
location (`--track-widget-creation`, the debug default — profile/release builds are refused).
Each tap lands as a card on **`GET /flutter`** (the pinpoint server's own panel page, which
carries the overlay for the progress card + chat drawer): widget type, `file:line`, a widget
screenshot. The reviewer annotates and Sends — a normal batch whose pins carry
`source: {file, line, column}` + `widget` instead of `element`, so the worker opens the file
at the line instead of grepping. When every pin reaches a terminal status, the CLI triggers
flutter_tools' full **hot reload** (recompile + reassemble) so the fix appears on the device;
without a reload service (bare `dart`, `--no-dds`) it says to press `r` instead.

Flags: `--app-root <dir>` (repeatable; default: nearest `pubspec.yaml` above cwd) scopes
which taps are "ours" (framework-widget taps are skipped with a logged reason) and registers
pub roots; `--port` overrides the pinpoint port; `--no-reload`; `--full-screenshots`.
Taps not included in a Send stay on the panel for the next batch; the panel's select-mode
toggle flips the device mode remotely. The worker must NOT run the app or hot reload —
verification for flutter pins is `dart analyze` on the changed files.

## Many sessions — who gets the batch? (session dispatch)

Every pinpoint MCP process is a **session** (id = the Claude pid, label = the Claude session
name from `~/.claude/sessions/<pid>.json`; override with `PINPOINT_SESSION` /
`PINPOINT_SESSION_ID`). Sessions heartbeat to the HTTP owner, and the overlay's **To:**
picker lists them.

- **Addressed** batch (`to: <session id>`): only that session's `wait_for_pins` fires;
  everyone else leaves the file alone.
- **Auto** (the picker default): with worker dispatch, a headless worker (see above). With
  session dispatch it is routed to the live **handler** session. For an installed project
  (it has a `.pinpoint.json`) a handler is a session named `pinpoint_<name>` — the name is
  the file's `name`, and `list_sessions` returns it as `requiredSession` with `selfIsHandler`.
  Only handlers are listed in the picker, only handlers claim unaddressed batches, and
  **Send is refused with a hint while no handler is live** — so the first thing to do in
  the session that should take pins is `/rename pinpoint_<name>` (the label is re-read live;
  no restart). With several handlers it becomes *any*: first `wait_for_pins` wins. Repos
  never installed keep the legacy rule: any session whose name contains "pinpoint".
- **Claim-on-read**: delivery renames the file to `<id>.claimed-<session>.json` atomically,
  so a batch is handled exactly once. `list_pins` shows `to` and `claimedBy`; an unclaimed
  batch addressed to a gone session can be picked up with `get_pins { id }`.
- `list_sessions` shows this session's id/label and the live sessions.
- A detached HTTP owner started from a shell (`PINPOINT_ROLE=http`) serves the overlay for
  everyone but is not a session and never claims.

## Installing into a project — `/pinpoint --install`

Run this whenever a repo has no Pinpoint pill yet (new project, a freshly cloned one, or
"why is pinpoint not running here?"). It is a script, not a checklist — run it, show its
summary, then do the *Next* steps it prints:

```
bun add -D pinpoint-live          # once per repo (or: bun add -D github:ragrivera/pinpoint)
bun run pinpoint install [--root <repo>] [--port <n>] [--app <dir>]... [--dry-run]
```

(`bunx pinpoint-live install` works without the first line once the package is published;
from a clone: `bun <clone>/bin/pinpoint.ts install`.) What it does, idempotently
(re-running only fills gaps):

- Adds the dev dependency with the repo's own package manager (skipped with `--no-add`).
- Gives the repo its **own pinpoint server** and handler name: writes `<root>/.pinpoint.json`
  with a `name` (the apps' npm scope, `@orgspace/*` → `orgspace`; `--name` overrides) that
  fixes the handler session name to `pinpoint_<name>`, `"dispatch": "worker"`, and a port
  derived from the repo's own port block (`8404` → `8491`, `4903` → `4991`, `5173` → `5191`;
  bumped past anything taken; `--port` overrides).
- Finds every `vite.config.*` (root, `apps/*`, `packages/*`; or `--app`) and inserts
  `import { pinpoint } from 'pinpoint-live/vite'` plus `pinpoint()` first in the `plugins`
  array. Skips configs already wired; refuses (and prints the manual snippet) when a config
  has zero or several `plugins: [` arrays rather than guess.
- Writes the project-scope MCP server into `<root>/.mcp.json` (`bun run pinpoint serve`),
  copies this skill to `<root>/.claude/skills/pinpoint/SKILL.md`, adds `.docs/pinpoint/` to
  `.gitignore`, and creates the feedback dir. Commit those three files: the team gets the
  same setup on clone.
- Merges a phoenix `extra_services` override when that skill is installed, so `/phoenix`
  starts this repo's owner with the stack.

Reading its summary: each app shows the dev origin it detected (host + port, resolved
through the app's `.env` when the config says `Number(env.PORT) || …`) — glance at it; a
wrong guess only affects the printed URL, never the overlay. Use `--dry-run` first only when
the layout looks unusual; otherwise run it directly — every write is listed and the config
edit is two lines.

After it runs, finish the job rather than handing the list back:

1. Restart the Vite dev servers it patched (plugins load on startup; HMR won't do).
2. Make sure the repo's owner is up: `bun run pinpoint health`. A Claude session started in
   the repo after the install owns it through `.mcp.json`; otherwise launch it detached from
   the repo root:
   `PINPOINT_DETACHED=1 PINPOINT_ROLE=http nohup bun run pinpoint serve > .docs/pinpoint/server.log 2>&1 & disown`
3. Tell the user to restart Claude Code (or `/mcp` → reconnect `pinpoint`) in every session
   open in that repo — an MCP process started before the install is on the old port or absent.
4. Only for `"dispatch": "session"`: rename the handling session `/rename pinpoint_<name>`
   (the `session` field in `.pinpoint.json`). In that mode Send is refused until such a
   session is live and `wait_for_pins` elsewhere returns `notHandler`. With worker dispatch
   (the default) nothing needs naming — Send spawns a worker.
5. Verify: `curl -s <origin>/ | grep -c pinpoint.js` is 1, then hand the user the one-liner
   from *The loop*.

Non-Vite dev servers (Next, Remix, CRA, static HTML) are reported, not wired: render
`<PinpointScript origin="http://127.0.0.1:<port>" />` from `pinpoint-live/react` once in
the root layout (it renders nothing in production), or add
`<script src="http://127.0.0.1:<port>/pinpoint.js" defer></script>` to the dev HTML by
hand, gated on a dev-only condition — the tag must never ship.

## Wiring the app

The plugin is ON for every `vite` dev server by default (opt out with `PINPOINT=0`), so a
plain `bun run dev` from any terminal keeps the overlay; `vite build` never sees it. If the
repo's pinpoint server is down the only cost is one failed request. `PINPOINT_ORIGIN`
overrides the script origin for the rare non-loopback setup.

## Delegate, don't bottleneck — one agent per batch, always (session dispatch)

Every pin batch gets its **own** fork subagent the moment it lands — even when an earlier
agent is still working on the same file. Never queue a new batch onto a running agent:
serial feeding turns ten small pins into a 25-minute wait (each re-verified in turn).
Parallel agents finish in minutes and the user sees each result as it lands.

Progress reporting: the overlay shows a per-batch progress card that polls the server.
Agents report each pin as they go — `report_pin` via the MCP when connected, otherwise the
CLI twin from the repo root:
`bun run pinpoint report <batch-id> <pin#> working|done|skipped|question [note] --by <session id>`
(status `working` when starting, `done`/`skipped`/`question` when finished).
Put the exact command, batch id and session id in every spawn prompt.

Same-file safety rules for the agents (put them in every spawn prompt):
- Re-read the file immediately before each edit and use exact-match `Edit` calls (never
  `Write` a whole file another agent may be touching).
- Keep the change surgical to the pin's element; don't reformat or run prettier on the
  whole file.
- If the exact-match edit fails because the file moved underneath, re-read and retry — do
  not revert other agents' changes.
- Verify only the pin's own state (one lint + type-check run, one screenshot).

The main thread only (a) acknowledges the batch in one line, (b) keeps answering the user,
and (c) relays each agent's report by pin number. Batching is never the answer;
parallelism is.

## The loop (session dispatch, or a session picked in To:)

With worker dispatch a Claude session has nothing to do: the reviewer sends, a worker
answers in the drawer. Run this loop only when the project uses `"dispatch": "session"` or
the reviewer addresses this session explicitly.

1. Confirm the app is up with the flag (`curl -s localhost:<port>/ | grep pinpoint.js`) and
   `pinpoint` is connected. If the MCP is down, batches are still on disk — read the newest
   file in `.docs/pinpoint/feedback/`. In an installed project also check `list_sessions` →
   `selfIsHandler` is true; if not, `/rename` this session to the `requiredSession` it
   reports, or pins will never reach it. Start such a session in one go with
   `claude -n pinpoint_<name> "/pinpoint"`.
2. One line to the user: "Press **R** (or the Pinpoint pill) → drag a box or click an
   element → comment → **Send to Claude**."
3. Wait without polling: arm one persistent file watch on `.docs/pinpoint/feedback/` (poll
   1 s for `*.json` not matching `*.claimed-*` or `_*`) and on each event call `get_pins`
   (non-blocking; it claims by rename). Avoid re-issuing `wait_for_pins` every 240 s — each
   timeout is a noisy turn. Never invent pins. Batches carry `page` (the route), `viewport`,
   `general`, and `pins[]` with `rect`, `element.path` + `element.text` (click) or `near`
   (drag-box), `type`, `comment`, `fix`. `state` is null on live pages.
4. **Resolve each pin to source.** Grep the rendered `text` (not the DOM path — utility-class
   paths are brittle) across the app's `src/`; the route from `page` narrows it to a route
   file + its feature components. For utility-class-only hits, grep a distinctive class
   combo from `element.path`. To *see* a pin, screenshot at the batch's `viewport` and clip
   to `rect` — use a **fresh** browser session, not one with stale init scripts.
5. (In the subagent) fix in place; keep the change surgical. Vite HMR shows it immediately —
   no restart. Run the file's lint + the workspace's type-check before replying.
   **Report progress per pin** with `report_pin` (`id` = batch id, `pin` = on-screen number):
   `working` when you start it, then `done` / `skipped` / `question` when you finish
   (optional `note` ≤200 chars shows on hover). The overlay's progress toast polls this —
   without it the reviewer sees "waiting" forever. Every pin must reach a terminal status;
   that is what marks the batch complete in the browser.
6. Reply as a numbered list matching the on-screen pin numbers: *understood → did (or why
   not)*. Ambiguous pin: ask by number. `type: question` → answer, don't build (still
   `report_pin … question`). `idea` is optional (`skipped` if you don't build it).

## Don'ts

- Don't run the loop against a production URL; the overlay is dev-only.
- Don't name two sessions `pinpoint_<name>` for one repo unless first-come claiming is what
  you want.
- Don't point two repos at one pinpoint server: install each (`pinpoint install`) so batches
  land in the right `.docs/pinpoint/feedback/`.
- Don't commit/PR from a pin reply unless explicitly asked.
- Don't loosen the Origin check or point the overlay at a non-localhost app: a worker acts
  on whatever is posted to it.
