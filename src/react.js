// react.js — `import { PinpointScript } from 'pinpoint-live/react'`.
// For React apps that are not served by Vite (Next.js, Remix, CRA, …): render it once
// in the root layout. It emits the same dev-only <script> tag the Vite plugin injects,
// and renders nothing in production (NODE_ENV === 'production') or with PINPOINT=0.
// Files cannot be read from a client component, so the port is passed in:
//   <PinpointScript origin={`http://127.0.0.1:${config.port}`} />  (config = your .pinpoint.json)
import { createElement } from 'react';

/**
 * @param {{ origin?: string, enabled?: boolean }} [props]
 *   origin  — pinpoint server origin (default http://127.0.0.1:4991)
 *   enabled — force on/off (default: on unless NODE_ENV is production or PINPOINT is "0")
 */
export function PinpointScript(props = {}) {
  const on = props.enabled ?? (process.env.NODE_ENV !== 'production' && process.env.PINPOINT !== '0');
  if (!on) return null;
  const origin = props.origin || 'http://127.0.0.1:4991';
  return createElement('script', { src: `${origin}/pinpoint.js`, defer: true });
}
