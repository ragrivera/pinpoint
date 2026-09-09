# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - 2026-09-09

### Features
- ✨ Model pill in the drawer's composer (and a *Model:* line in the panel): pick which Claude the
  worker runs — Default / Fable / Opus / Opus 1M / Sonnet / Haiku, `worker.models` to replace it and
  `worker.model` to preselect one. The pick rides along with *Send*, and `POST /api/chat/:id/model`
  switches an open conversation: the running process keeps its model, so it is ended once it is
  quiet and the next message resumes the same Claude session on the new one (overlay, server)

### Infrastructure
- 🔧 Add a GitHub Actions workflow running type-check and tests on every pull request and push to main (ci)
