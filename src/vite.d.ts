import type { Plugin } from 'vite';

export type PinpointPluginOptions = {
  /** Override the pinpoint server origin (else PINPOINT_ORIGIN, else http://127.0.0.1:<port from .pinpoint.json>). */
  origin?: string;
  /** Where to read PINPOINT / PINPOINT_ORIGIN from (default process.env; pass Vite's loadEnv() result). */
  env?: Record<string, string | undefined>;
};

/** Dev-only Vite plugin: injects the pinpoint overlay script into every served page. */
export function pinpoint(options?: PinpointPluginOptions): Plugin;
