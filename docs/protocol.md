# Pinpoint protocol

Everything the overlay, the server, workers and Claude sessions agree on. Paths are relative to the
project root (the directory holding `.pinpoint.json`).

## Files

```
.pinpoint.json                          port, name, dispatch, app origins (committed)
.mcp.json                               { "mcpServers": { "pinpoint": { "command": "bun", "args": ["run", "pinpoint", "serve"] } } }
.claude/skills/pinpoint/SKILL.md        the /pinpoint skill (committed)
.docs/pinpoint/feedback/<id>.json       a batch nobody has claimed
.docs/pinpoint/feedback/<id>.claimed-<who>.json   claimed by a session id (Claude pid) or worker id (w…)
.docs/pinpoint/workers/<id>.json        worker record: state, session uuid, turns, cost
.docs/pinpoint/workers/<id>.chat.jsonl  the worker's transcript (one event per line)
.docs/pinpoint/workers/<id>/img-*.png   screenshots sent from the drawer
.docs/pinpoint/workers/mcp.json         the MCP config workers are started with
```

Batch ids are `<ISO timestamp with : and . replaced by ->-<route slug>`, e.g. `2026-09-06T10-15-15-158Z-home`.

## Batch

Posted by the overlay, persisted verbatim plus `id`, `receivedAt`, `to`, and later `claimedBy` / `progress`.

```jsonc
{
  "id": "2026-09-06T10-15-15-158Z-settings-profile",
  "receivedAt": "2026-09-06T10:15:15.158Z",
  "page": "http://localhost:5173/settings/profile",   // full URL; the path is the route
  "title": "Settings · Acme",
  "viewport": { "w": 1440, "h": 900, "dpr": 2 },
  "state": null,                                       // an artifact's explorer state; null on live pages
  "general": "The whole card feels cramped.",          // optional note for the page (pin 0)
  "to": "12345" | "any" | "" | "w3k9ab",               // session id, any handler, or the worker id
  "claimedBy": "12345",                                // set when claimed
  "images": [".docs/pinpoint/workers/<id>/img-….png"], // screenshots attached at send time
  "pins": [
    {
      "type": "bug" | "layout" | "copy" | "idea" | "question" | "",
      "comment": "Save button overlaps the footer on short viewports",
      "fix": "optional suggested fix",
      "rect": { "x": 812, "y": 640, "w": 96, "h": 36 },   // page coordinates at the pin's scrollY
      "scrollY": 0,
      "element": { "tag": "button", "path": "main > form > div.flex > button.btn-primary", "text": "Save" },
      "near": "…",                                       // drag-box pins: nearest text instead of element
      "at": "2026-09-06T10:14:58.001Z"
    }
  ],
  "progress": {                                         // written by report_pin / `pinpoint report`
    "1": { "status": "done", "note": "moved into the sticky footer", "at": "…", "by": "12345" },
    "0": { "status": "question", "note": "…" }          // key 0 = the general note
  }
}
```

Pin statuses: `working` → `done` | `skipped` | `question`. A batch is *complete* when every pin (or, for a
note-only batch, pin 0) has a terminal status.

## HTTP (127.0.0.1:<port>)

All `/api/*` routes check `Origin`: allowed are the origins in `.pinpoint.json` `apps[]`, `localhost`,
`127.0.0.1`, `[::1]` and `*.localhost`; requests with no `Origin` (curl, CLIs) pass. Others get `403`.

| route | purpose |
|---|---|
| `GET /pinpoint.js` | the overlay, prefixed with `window.__reviewBrand = {…}` (name, key, api paths, dispatch, port, requiredSession) |
| `GET /.docs/open-design/**` | the project's open-design mockups (rooted at `<root>/.docs/open-design`); `.html` is served with the overlay `<script>` injected; the only static tree |
| `GET /api/health` | `{ ok, root, port, project, name, dispatch, claudeBin, requiredSession, feedbackDir, sessions, handlers, workers, update }` — `update` is `null` until the 4-hourly tag check has run, then `{ current, latest, available, checkedAt, repo, command }` (also on the overlay prelude) |
| `POST /api/pins` | receive a batch → `{ ok, id, worker }`; `409` with `hint` when session dispatch has no handler; `503` when a follower is asked to spawn a worker |
| `GET /api/pins/:id` | progress: `{ id, page, to, claimedBy, claimedLabel, worker, total, noteOnly, resolved, complete, progress }` |
| `GET /api/sessions` | live sessions for the To: picker (handlers only on installed projects) |
| `POST /api/sessions` | heartbeat from follower MCP processes `{ id, label, cwd }` |
| `GET /api/skills` | skills + commands a worker can run (`~/.claude` and `<root>/.claude`, plus `/clear`, `/compact`) |
| `GET /api/chat` | worker conversations, newest first (each with its Claude `session` id) |
| `GET /api/chat/:id/events` | SSE: transcript replay, then live events |
| `POST /api/chat/:id` | `{ text?, images?, pins? }` → to the worker (pins are appended to the batch, numbered on; a `/clear` text empties the batch's pins so the next ones start at #1 again) |
| `POST /api/chat/:id/stop` | end the worker process (a later message resumes the session) |
| `POST /api/chat/:id/handoff` | continue in a terminal: end the worker (if running) and note it in the transcript as a `status` with `handoff: true` + the command; returns `{ ok, command, cwd, session }` (the overlay builds the same `cd <root> && claude --resume <session>` from `/api/health` + the row's `session` and puts it on the clipboard rather than showing it) |
| `POST /api/chat/:id/close` | end the worker (if running) and drop the conversation from `/api/chat`; its record parks as `<id>.json.closed`, transcript + images stay |
| `GET /api/chat/:id/img/:file` | a screenshot from the transcript |

Chat events (`t`): `batch`, `user`, `assistant`, `tool`, `tool_error`, `result`, `status`, `stderr`, `error`,
`sync`. Status states: `starting`, `working`, `idle`, `exited`, `error`; a `status` with `closed: true` is a closed conversation's last event.

## MCP tools (stdio, JSON-RPC 2.0 newline-delimited)

| tool | input | returns |
|---|---|---|
| `wait_for_pins` | `{ timeout_seconds? }` (default 240) | the next batch for this session, or `{ timedOut }`, or `{ notHandler, requiredSession }` |
| `get_pins` | `{ id? }` | unread batches now, or one saved batch by id (workers fetch theirs this way) |
| `list_pins` | `{ limit? }` | saved batches, newest first: id, page, pins, to, claimedBy, worker |
| `report_pin` | `{ id, pin, status, note? }` | the batch's progress summary |
| `list_sessions` | `{}` | `{ self, requiredSession, dispatch, selfIsHandler, sessions[] }` |

Session identity: id = the parent Claude pid (or `PINPOINT_SESSION_ID`), label = the Claude session name
from `~/.claude/sessions/<pid>.json` (or `PINPOINT_SESSION`), re-read live so `/rename` takes effect.

## Worker

`claude -p --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions
-n pin-<id> --session-id <uuid> [--strict-mcp-config --mcp-config .docs/pinpoint/workers/mcp.json]`, cwd =
root, env `PINPOINT_ROOT`, `PINPOINT_SESSION_ID=<workerId>`, `PINPOINT_SESSION=worker:<id>`. The first
message is the batch brief (page, viewport, note, pins, the workflow: resolve → `report_pin` → fix →
verify → numbered reply); when the page is a mockup this server serves (`/.docs/open-design/**`) the brief
switches to artifact rules: edit the authoring source inside that folder, rebuild, never touch app code. Follow-ups are `{"type":"user","message":{"role":"user","content":…}}` lines on
stdin; image blocks travel inline. After `worker.idleMinutes` stdin is closed; the next message restarts
with `--resume <uuid>`. Verified against Claude Code 2.1.263.
