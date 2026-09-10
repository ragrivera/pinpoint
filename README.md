# Pinpoint

Pin elements on your **running** React app, press *Send to Claude*, and watch the source get fixed in place.

Pinpoint is a live-code review loop for [Claude Code](https://claude.com/claude-code): a small overlay on your
dev server lets you click an element or drag a box, type what is wrong, and send the batch. A headless Claude
worker picks it up, resolves each pin to the component that rendered it, edits the file, reports progress
back to a card in the browser, and answers in a chat drawer beside the page. Vite HMR shows the fix as it lands.

- **Overlay** (`/pinpoint.js`): press `R`, pin, comment, send. Progress cards, a chat drawer per batch,
  screenshots by paste/drop, `/` to run a skill in the worker, a model pill to pick the Claude that runs it.
- **Server** (`pinpoint serve`): one Bun process that is both an MCP server (stdio, for Claude Code) and a
  local HTTP server (overlay + pin/chat API). One per repo, on that repo's own port.
- **Worker**: `claude -p` spawned per batch from the repo root, with only the pinpoint MCP loaded. Its session
  is resumable, so follow-ups in the drawer cost no cold start.
- **Skill**: a `/pinpoint` skill (committed to the repo) that teaches Claude the loop and the install.

Requirements: [Bun](https://bun.sh) ≥ 1.1 (the server uses `Bun.serve`/`Bun.spawn`; your project can still use
npm/pnpm/yarn), Claude Code ≥ 2.1 on `PATH`, macOS or Linux.

## Quick start

```sh
bun add -D pinpoint-live            # or: bun add -D github:ragrivera/pinpoint
bun run pinpoint install
```

`pinpoint install` is idempotent and prints every write. It:

1. writes `.pinpoint.json` — this repo's pinpoint port (derived from your dev ports: `5173` → `5191`,
   `8404` → `8491`) and name;
2. adds `import { pinpoint } from 'pinpoint-live/vite'` + `pinpoint()` to every `vite.config.*` it finds
   (root, `apps/*`, `packages/*`);
3. writes the project-scope MCP server into `.mcp.json` (`bun run pinpoint serve`) so every Claude Code session
   opened in the repo starts it;
4. copies the `/pinpoint` skill to `.claude/skills/pinpoint/SKILL.md`;
5. ignores `.docs/pinpoint/` (batches, worker transcripts, logs).

Then restart your Vite dev server, (re)start Claude Code in the repo (approve the `pinpoint` MCP server when
asked), open the app and look for the **Pinpoint** pill. Press `R`, click something, write a comment, **Send**.

Commit `.pinpoint.json`, `.mcp.json` and `.claude/skills/pinpoint/` — teammates get the same setup on clone.

### Non-Vite React apps (Next.js, Remix, CRA…)

Render the dev-only script tag once in the root layout. It renders nothing when `NODE_ENV` is `production`
or `PINPOINT=0`:

```tsx
import { PinpointScript } from 'pinpoint-live/react';
import pinpoint from '../.pinpoint.json';

<PinpointScript origin={`http://127.0.0.1:${pinpoint.port}`} />
```

Anything else: `<script src="http://127.0.0.1:<port>/pinpoint.js" defer></script>` in the dev HTML, behind a
dev-only condition. The tag must never ship.

### Flutter apps — tap-to-pin, zero app code

A Flutter app gets nothing injected. Instead, `pinpoint flutter` drives the widget inspector
over the Dart VM Service of a running **debug** build:

```sh
flutter run                      # copy the printed "A Dart VM Service … is available at:" URI
bun run pinpoint flutter --vm-uri http://127.0.0.1:PORT/TOKEN=/ --app-root <flutter app dir>
```

Select mode turns on on the device: every widget you tap arrives on `http://127.0.0.1:<port>/flutter`
as a card — widget type, `file:line` (from `--track-widget-creation`), a widget screenshot. Annotate,
**Send**, and the pins ride the normal worker + chat loop, pre-resolved to source (`source: {file,
line, column}` on each pin — no grepping). When the worker finishes every pin, the CLI triggers
flutter_tools' full hot reload so the fix appears on the device. Taps on framework widgets (outside
your `--app-root`s) are skipped with a logged reason; profile/release builds are refused up front.
Flags: `--app-root` (repeatable; default: nearest `pubspec.yaml`), `--port`, `--no-reload`,
`--full-screenshots`.

## How it works

```
 browser (your app + overlay)         pinpoint serve (per repo)              Claude
 ───────────────────────────          ─────────────────────────              ──────
 R → pin → comment → Send  ──POST /api/pins──▶  .docs/pinpoint/feedback/<id>.json
                                                 ├─ dispatch=worker: spawn `claude -p` ──▶ worker fixes pins,
                                                 │    chat drawer ◀── SSE /api/chat/:id ──  report_pin, replies
                                                 └─ dispatch=session: a live session's
 progress card ◀──GET /api/pins/:id──            wait_for_pins claims it (rename)  ──▶ your open session
```

**Dispatch.** `"dispatch": "worker"` (the default the installer writes): *Send* pre-claims the batch and spawns
a headless worker; nothing has to be waiting. `"dispatch": "session"`: a live Claude Code session named
`pinpoint_<name>` claims the batch through the `wait_for_pins` MCP tool and works it interactively. The
overlay's **To:** picker can always address a specific live session or force a worker for one batch.

**One server per repo.** The nearest `.pinpoint.json` above the working directory fixes the root and the
port. The first process to bind the port is the HTTP owner; later sessions in the same repo run MCP-only and
pick batches up from the shared directory. Two repos never share a port or a feedback dir.

**Exactly once.** Delivery renames the batch file to `<id>.claimed-<who>.json` atomically, so a batch is
handled by one worker or session. Per-pin progress is written back into the same file and polled by the
overlay's progress card.

**Model.** The pill in the drawer's bar (and the panel's *Model:* line) picks which Claude the worker runs:
`claude --model <id>`, or the binary's own default. It is one preference per project, kept in the browser — the
model the next *Send* uses, for a new conversation or one being continued — and selecting a conversation in the
drawer adopts its model, so the pill always names what you are working with. Switching an open conversation
posts `/api/chat/:id/model`: the running process keeps the model it started with, so pinpoint ends it (right
away when the worker is quiet, after the current turn otherwise) and the next message resumes the same Claude
session on the new model, losing no context. The offered list is aliases (`fable`, `opus`, `opus[1m]`,
`sonnet`, `haiku`) so it does not rot; `worker.models` replaces it and `worker.model` preselects one. The server refuses
anything outside the list — a typo would otherwise surface only as a worker that dies on spawn.

**Mockups too.** `GET /.docs/open-design/**` serves the project's open-design artifacts (rooted at
`<root>/.docs/open-design`) with the overlay injected, so pins on a mockup ride the same worker + chat loop;
the worker brief then edits the artifact's authoring source, never app code. Nothing else is served statically.

**Updates.** Every 4 hours at most — on server start and whenever a worker spawns — the server runs `git ls-remote --tags`
on this package's repo (your own git credentials, so a private repo works) and compares the highest `vX.Y.Z` tag
with the installed version. A newer one shows as a `vX.Y.Z available` chip in the chat drawer's header (click
copies the `bun add` command) and as `update` on `/api/health`. It never delays a spawn; `"updateCheck": false`
or `PINPOINT_NO_UPDATE_CHECK=1` turns it off. Releases are tags: bump `version`, tag `vX.Y.Z`, push the tag.

**Security.** Every `/api/*` route rejects browser requests whose `Origin` is not one of the repo's app origins
(from `.pinpoint.json` `apps[].origin`) or `localhost` / `127.0.0.1` / `*.localhost`. The server binds
`127.0.0.1` only. Workers run with permission prompts skipped, so that guard is what keeps a foreign page from
posting into one. Do not widen it, and never load the overlay from a non-local app.

The full batch/API/MCP contract is in [docs/protocol.md](docs/protocol.md).

## CLI

```
pinpoint install [--root <dir>] [--port <n>] [--name <project>] [--app <dir>]... [--spec <pkg>]
                 [--dry-run] [--no-add] [--no-mcp] [--no-skill] [--no-phoenix] [--no-gitignore]
pinpoint serve                                  MCP (stdio) + HTTP for the repo above cwd
pinpoint report <batch> <pin> <status> [note]   write per-pin progress from a shell
pinpoint flutter --vm-uri <uri> [--app-root <dir>]... [--port <n>] [--no-reload] [--full-screenshots]
                                                tap-to-pin capture for a running Flutter debug app
pinpoint skill [--user] [--link] [--force]      copy/link the /pinpoint skill (repo, or ~/.claude with --user)
pinpoint health                                 GET /api/health on this repo's port
```

Run it as `bun run pinpoint …` inside an installed project, `bunx pinpoint-live …` once published, or
`bun <clone>/bin/pinpoint.ts …` from a checkout.

A standalone HTTP owner with no Claude session (e.g. started by a process manager):

```sh
PINPOINT_DETACHED=1 PINPOINT_ROLE=http nohup bun run pinpoint serve > .docs/pinpoint/server.log 2>&1 & disown
```

## `.pinpoint.json`

```jsonc
{
  "port": 5191,                 // this repo's pinpoint server port
  "name": "acme",               // → a session-dispatch handler must be named pinpoint_acme
  "session": "pinpoint_acme",
  "dispatch": "worker",         // "worker" (headless claude per batch) | "session" (a live session claims it)
  "apps": [{ "dir": "apps/web", "origin": "http://localhost:5173" }],  // Origin allowlist + docs
  "claudeBin": "/usr/local/bin/claude",           // optional; default `which claude`, else ~/.local/bin/claude
  "worker": {                   // optional
    "idleMinutes": 30,
    "recapOnIdle": true,        // ask the worker for a one-line recap before the idle timeout closes it
    "mcp": "pinpoint",          // "all" loads every user MCP
    "args": [],                 // extra claude flags
    "model": "",                // preselects the model pill ("" = whatever claude is set to)
    "effort": "",               // preselects the effort pill: low | medium | high | xhigh | max ("" = whatever claude does)
    "models": []                // replaces the offered list: ["opus", { "id": "fable", "label": "Fable", "note": "most capable" }]
  },
  "updateCheck": true           // optional; false stops the 4-hourly look at the package repo's tags for a newer pinpoint
}
```

## Environment

| variable | effect |
|---|---|
| `PINPOINT=0` | Vite plugin / `<PinpointScript/>`: do not inject the overlay |
| `PINPOINT_ORIGIN` | override the overlay script origin (non-loopback setups) |
| `PINPOINT_ROOT` | start the `.pinpoint.json` walk here instead of cwd |
| `PINPOINT_PORT` | override the server port |
| `PINPOINT_ROLE=http` | HTTP owner only: no session identity, never claims batches |
| `PINPOINT_DETACHED=1` | keep serving with no MCP client on stdin |
| `PINPOINT_DISPATCH` | `worker` \| `session`, overrides `.pinpoint.json` |
| `PINPOINT_SESSION`, `PINPOINT_SESSION_ID` | override the session label / id |
| `PINPOINT_CLAUDE` | path to the `claude` binary for workers |
| `PINPOINT_OVERLAY` | serve a different overlay file (default `overlay/pinpoint.js`) |
| `PINPOINT_NO_UPDATE_CHECK=1` | never look for a newer pinpoint (see `updateCheck`) |
| `PINPOINT_UPDATE_REPO` | check another git remote (or local path) for version tags instead of this package's repo |

## Troubleshooting

- **No Pinpoint pill.** `curl -s <app origin>/ | grep -c pinpoint.js` must print `1` (else the plugin is not
  loaded — restart Vite). `bun run pinpoint health` must answer (else no server: start a Claude session in the
  repo, or the detached command above). The browser console shows a failed `/pinpoint.js` request when the
  port is wrong: compare `.pinpoint.json` with the tag's `src`.
- **Send refused: "No pinpoint_<name> session is active".** The repo uses session dispatch and no Claude
  session is named `pinpoint_<name>`. `/rename pinpoint_<name>` in the session that should take pins, or
  switch to `"dispatch": "worker"`.
- **Send refused: "forbidden origin".** The app's origin is not in `.pinpoint.json` `apps[].origin` and is not
  localhost. Add it (and only it).
- **Worker error: claude binary not found.** Set `claudeBin` in `.pinpoint.json` or `PINPOINT_CLAUDE`.
- **Two repos, one port.** Each repo needs its own `.pinpoint.json`; run `pinpoint install` in both.

## Development

```sh
git clone https://github.com/ragrivera/pinpoint && cd pinpoint
bun install
bun test              # server + MCP round trip, installer, Vite/React entry points
bun run type-check
```

`overlay/pinpoint.js` is dependency-free vanilla JS; `src/server.ts` is a single-file Bun program with no
MCP SDK (the JSON-RPC surface it needs is ~60 lines). Edits to the overlay are served live — no restart.

CI (`.github/workflows/ci.yml`) runs the same two checks on every pull request and on pushes to `main`.

## License

MIT
