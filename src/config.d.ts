export const CONFIG_FILE: '.pinpoint.json';
export const DEFAULT_PORT: 4991;

export type PinpointApp = { dir: string; origin: string };
export type PinpointConfig = {
  port?: number;
  name?: string;
  session?: string;
  dispatch?: 'worker' | 'session';
  apps?: PinpointApp[];
  claudeBin?: string;
  worker?: { idleMinutes?: number; mcp?: 'pinpoint' | 'all'; args?: string[] };
  updateCheck?: boolean;
  installedAt?: string;
  [key: string]: unknown;
};
export type Project = { root: string; file: string | null; config: PinpointConfig | null };

export function findProject(from?: string): Project;
export function projectPort(from?: string): number;
