import type { ReactElement } from 'react';

export type PinpointScriptProps = {
  /** Pinpoint server origin (default http://127.0.0.1:4991 — pass the port from your .pinpoint.json). */
  origin?: string;
  /** Force on/off (default: on unless NODE_ENV is production or PINPOINT is "0"). */
  enabled?: boolean;
};

/** Dev-only <script> tag that loads the pinpoint overlay; renders nothing in production. */
export function PinpointScript(props?: PinpointScriptProps): ReactElement | null;
