// vite.js — `import { pinpoint } from 'pinpoint-live/vite'`.
// Dev-only: injects the pinpoint overlay (pin an element → "Send to Claude") into every
// page the Vite dev server serves. ON by default for every `vite` dev server (opt out
// with PINPOINT=0 in the shell env or the loaded .env passed as `env`) so a restart from
// any terminal keeps the overlay. The tag is served by THIS project's pinpoint server
// (port from the nearest `.pinpoint.json` above the Vite root, else 4991) and posts back
// to it, so if that server is down the only cost is one failed request. Never runs on
// `vite build` (`apply: 'serve'`).
import { projectPort } from './config.js';

/**
 * @param {{ origin?: string, env?: Record<string, string | undefined> }} [options]
 *   origin — override the pinpoint server origin (else PINPOINT_ORIGIN, else 127.0.0.1:<port>)
 *   env    — the object to read PINPOINT / PINPOINT_ORIGIN from (default process.env;
 *            pass Vite's loadEnv() result to honour the app's .env files)
 * @returns {import('vite').Plugin}
 */
export function pinpoint(options = {}) {
  const env = options.env || process.env;
  let root = process.cwd();
  return {
    name: 'pinpoint-overlay',
    apply: 'serve',
    configResolved(config) { root = config.root || root; },
    transformIndexHtml(html) {
      if (env.PINPOINT === '0' || process.env.PINPOINT === '0') return html;
      const origin = options.origin || env.PINPOINT_ORIGIN || process.env.PINPOINT_ORIGIN || `http://127.0.0.1:${projectPort(root)}`;
      return {
        html,
        tags: [{ tag: 'script', attrs: { src: `${origin}/pinpoint.js`, defer: true }, injectTo: 'body' }],
      };
    },
  };
}
