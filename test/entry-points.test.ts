import { describe, expect, test } from 'bun:test';
import { pinpoint } from '../src/vite.js';
import { PinpointScript } from '../src/react.js';
import { findProject, projectPort } from '../src/config.js';
import { tmpProject } from './helpers.ts';
import { join } from 'path';

describe('config', () => {
  test('finds the nearest .pinpoint.json above a nested dir, else falls back', () => {
    const p = tmpProject({ '.pinpoint.json': JSON.stringify({ port: 5191, name: 'acme' }), 'apps/web/index.html': '' });
    try {
      const nested = join(p.root, 'apps', 'web');
      expect(findProject(nested)).toEqual({ root: p.root, file: join(p.root, '.pinpoint.json'), config: { port: 5191, name: 'acme' } });
      expect(projectPort(nested)).toBe(5191);
      const bare = tmpProject();
      try { expect(findProject(bare.root).file).toBeNull(); expect(projectPort(bare.root)).toBe(4991); } finally { bare.rm(); }
    } finally { p.rm(); }
  });
});

describe('vite plugin', () => {
  const tag = (res: any) => (typeof res === 'string' ? null : res.tags[0]);
  test('injects the script tag for the project port, dev server only', () => {
    const p = tmpProject({ '.pinpoint.json': JSON.stringify({ port: 5191 }) });
    try {
      const plugin: any = pinpoint({ env: {} });
      expect(plugin.apply).toBe('serve');
      plugin.configResolved({ root: join(p.root, 'apps', 'web') });
      const t = tag(plugin.transformIndexHtml('<html></html>'));
      expect(t).toEqual({ tag: 'script', attrs: { src: 'http://127.0.0.1:5191/pinpoint.js', defer: true }, injectTo: 'body' });
    } finally { p.rm(); }
  });
  test('PINPOINT=0 in the given env disables it; origin option wins', () => {
    const off: any = pinpoint({ env: { PINPOINT: '0' } });
    expect(off.transformIndexHtml('<html></html>')).toBe('<html></html>');
    const custom: any = pinpoint({ origin: 'http://pins.local:9999', env: {} });
    expect(tag(custom.transformIndexHtml('<html></html>')).attrs.src).toBe('http://pins.local:9999/pinpoint.js');
    const viaEnv: any = pinpoint({ env: { PINPOINT_ORIGIN: 'http://127.0.0.1:7000' } });
    expect(tag(viaEnv.transformIndexHtml('<html></html>')).attrs.src).toBe('http://127.0.0.1:7000/pinpoint.js');
  });
});

describe('<PinpointScript/>', () => {
  test('renders a deferred script tag in development and nothing when disabled', () => {
    const el: any = PinpointScript({ origin: 'http://127.0.0.1:5191', enabled: true });
    expect(el.type).toBe('script');
    expect(el.props).toEqual({ src: 'http://127.0.0.1:5191/pinpoint.js', defer: true });
    expect(PinpointScript({ enabled: false })).toBeNull();
    const dflt: any = PinpointScript({ enabled: true });
    expect(dflt.props.src).toBe('http://127.0.0.1:4991/pinpoint.js');
  });
});
