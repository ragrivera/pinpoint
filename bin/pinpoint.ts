#!/usr/bin/env bun
// pinpoint — CLI entry (`bun run pinpoint …` in an installed project, `bunx pinpoint-live …`
// once published, or `bun bin/pinpoint.ts …` from a clone).
import { join } from 'path';
import { findProject, projectPort } from '../src/config.js';
import pkg from '../package.json';

const HELP = `pinpoint ${pkg.version} — pin the running app, fix the source

usage: pinpoint <command> [args]

  install [flags]      wire this repo: dev dependency, .pinpoint.json, Vite plugin import,
                       .mcp.json (project-scope MCP), .claude/skills/pinpoint, .gitignore
                       flags: --root <dir> --port <n> --name <project> --app <dir>… --spec <pkg>
                              --dry-run --no-add --no-mcp --no-skill --no-phoenix --no-gitignore
  serve                MCP (stdio) + HTTP server for the project above cwd — what .mcp.json runs.
                       PINPOINT_ROLE=http PINPOINT_DETACHED=1 for a standalone HTTP owner.
  report <batch> <pin> <working|done|skipped|question> [note] [--by <id>] [--dir <dir>]
                       write per-pin progress from a shell (the report_pin MCP tool's twin)
  flutter --vm-uri <uri> [--app-root <dir>]... [--port <n>] [--no-reload] [--full-screenshots]
                       tap-to-pin capture for a running Flutter debug app: taps on the device
                       resolve to source (widget inspector) and land on the /flutter panel
  skill [--user] [--link] [--force]
                       copy (or link) the /pinpoint Claude Code skill into the repo or ~/.claude
  health               GET /api/health on this project's pinpoint port

docs: ${pkg.repository?.replace(/^github:/, 'https://github.com/') ?? ''}`;

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'serve':
  case 'mcp': {
    // Launched from a project's node_modules with no .pinpoint.json above cwd (an MCP host with
    // an unexpected cwd): fall back to the project that installed the package.
    if (!process.env.PINPOINT_ROOT && !findProject(process.cwd()).file) {
      const host = findProject(join(import.meta.dir, '..', '..', '..'));
      if (host.file) process.env.PINPOINT_ROOT = host.root;
    }
    await import('../src/server.ts');
    break;
  }
  case 'install': {
    const { run } = await import('../src/install.ts');
    process.exit(await run(rest));
  }
  case 'report': {
    const { run } = await import('../src/report.ts');
    process.exit(run(rest));
  }
  case 'flutter': {
    const { run } = await import('../src/flutter.ts');
    process.exit(await run(rest));
  }
  case 'skill': {
    const { run } = await import('../src/skill.ts');
    process.exit(run(rest));
  }
  case 'health': {
    const port = Number(process.env.PINPOINT_PORT) || projectPort(process.env.PINPOINT_ROOT || process.cwd());
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      console.log(JSON.stringify(await r.json(), null, 2));
    } catch {
      console.error(`no pinpoint server on 127.0.0.1:${port}\nstart one: a Claude Code session in this repo (.mcp.json), or detached:\n  PINPOINT_DETACHED=1 PINPOINT_ROLE=http nohup bun run pinpoint serve > .docs/pinpoint/server.log 2>&1 & disown`);
      process.exit(1);
    }
    break;
  }
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    console.log(HELP);
    break;
  case '--version':
  case '-v':
    console.log(pkg.version);
    break;
  default:
    console.error(`unknown command: ${cmd}\n\n${HELP}`);
    process.exit(2);
}
