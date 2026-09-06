// pinpoint.js — the pinpoint overlay: drag/click-to-annotate a running app (or a static page).
// Served by src/server.ts as /pinpoint.js; the Vite plugin (or a <script> tag) adds it to the page.
// The review panel is a FloatingPanel twin (same chrome, drag, resize, collapse-to-
// pill) so it behaves exactly like the artifact's tweaks panel. Press R (or the
// ● annotate toggle in its header) to enter annotate mode; drag a box or click an
// element, write a comment, repeat. "Send to Claude" POSTs the batch to the server.
(function () {
  if (window.__designReview) return;
  // Brand: which server this overlay is serving. Loaded bare it is a generic "Review"
  // overlay posting to /api/feedback (defaults below); pinpoint's server prepends
  // `window.__reviewBrand` so the same code shows as PINPOINT and posts to its own API.
  const BRAND = Object.assign({ name: 'Review', key: 'design-review', api: '/api/feedback', server: 'design-review', port: 4990 }, window.__reviewBrand || {});
  const API = (document.currentScript && document.currentScript.src ? new URL(document.currentScript.src).origin : 'http://127.0.0.1:' + BRAND.port);
  const KEY = BRAND.key + ':' + location.pathname;
  const TYPES = ['bug', 'layout', 'copy', 'idea', 'question'];
  const state = { on: false, pins: [], general: '', drag: null, editing: null, panelPos: null, collapsed: true, size: { w: 296, h: null }, popSize: { w: 320, h: null } };
  // pinpoint chat drawer (module near the end): while open, the floating panel yields to it
  let chatOpen = false, chatW = 420, chatEl = null, chatScale = 1, chatSlashKey = null, chatLb = null, chatMenuClose = null;
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s) { state.pins = s.pins || []; state.general = s.general || ''; state.panelPos = s.panelPos || null; state.collapsed = s.collapsed !== false; state.size = s.size || state.size; state.popSize = s.popSize || state.popSize; }
  } catch (e) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ pins: state.pins, general: state.general, panelPos: state.panelPos, collapsed: state.collapsed, size: state.size, popSize: state.popSize })); } catch (e) {} };

  const css = `
  :root{--dr-g:16,20,26;--dr-w:255,255,255;--dr-fg:#eef3f7;--dr-fg2:#aeb7c2;--dr-fg3:#6f7783;--dr-fg3b:#8a94a0;--dr-on-bg:#dfe6ec;--dr-on-fg:#0c1116}
  .dr-canvas{position:fixed;inset:0;z-index:2147483590;cursor:crosshair;display:none}
  .dr-canvas.on{display:block}
  .dr-hover{position:fixed;pointer-events:none;border:2px dashed #ff5a5f;background:rgba(255,90,95,.08);border-radius:4px;z-index:2147483591;display:none}
  .dr-rect{position:fixed;pointer-events:none;border:2px solid #ff5a5f;background:rgba(255,90,95,.10);border-radius:4px;z-index:2147483591}
  .dr-pin{position:fixed;z-index:2147483592;width:24px;height:24px;border-radius:99px;background:#ff5a5f;color:#fff;font:700 12px/24px system-ui,sans-serif;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,.3);cursor:pointer;transform:translate(-50%,-50%)}
  .dr-pin.done{background:#39d98a}
  .dr-pop{position:fixed;z-index:2147483599;width:320px;box-sizing:border-box;background:rgba(var(--dr-g),.85);-webkit-backdrop-filter:blur(22px) saturate(150%);backdrop-filter:blur(22px) saturate(150%);border:1px solid rgba(var(--dr-w),.1);color:var(--dr-fg);border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.5);padding:14px;font:13px/1.45 system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;gap:10px;max-height:calc(100vh - 24px);overflow:hidden;transition:opacity .15s}
  .dr-pop .h{display:flex;justify-content:space-between;align-items:center;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dr-fg2);user-select:none;flex:none}
  .dr-pop .el{font:11px/1.4 ui-monospace,Menlo,monospace;color:var(--dr-fg2);background:rgba(var(--dr-w),.05);border:1px solid rgba(var(--dr-w),.07);border-radius:6px;padding:6px 8px;max-height:52px;overflow:hidden;word-break:break-all;flex:none}
  .dr-pop textarea{width:100%;box-sizing:border-box;background:rgba(var(--dr-w),.05);border:1px solid rgba(var(--dr-w),.12);border-radius:8px;color:var(--dr-fg);padding:8px 10px;font:13px/1.4 system-ui,sans-serif;resize:vertical;min-height:64px}
  .dr-pop textarea::placeholder{color:var(--dr-fg3b)}
  .dr-pop textarea:focus{outline:none;border-color:rgba(var(--dr-w),.3)}
  .dr-pop textarea.c{flex:1 1 64px;resize:none;min-height:64px}
  .dr-pop textarea.fix{min-height:44px;flex:none}
  .dr-pop textarea::-webkit-scrollbar{width:8px;height:8px}.dr-pop textarea::-webkit-scrollbar-track{background:transparent}.dr-pop textarea::-webkit-scrollbar-thumb{background:rgba(var(--dr-w),.18);border-radius:4px}
  .dr-pop textarea{scrollbar-width:thin;scrollbar-color:rgba(var(--dr-w),.18) transparent}
  .dr-types{display:flex;gap:6px;flex-wrap:wrap;flex:none}
  .dr-types button{border:1px solid rgba(var(--dr-w),.12);background:rgba(var(--dr-w),.05);border-radius:999px;padding:4px 10px;font:600 11px system-ui,sans-serif;cursor:pointer;color:var(--dr-fg2)}
  .dr-types button:hover{border-color:rgba(var(--dr-w),.25);color:var(--dr-fg)}
  .dr-types button.on{background:var(--dr-on-bg);color:var(--dr-on-fg);border-color:var(--dr-on-bg)}
  .dr-pop .row{display:flex;gap:8px;justify-content:flex-end;flex:none;padding-right:8px}
  .dr-pop .row button{border:0;border-radius:8px;padding:8px 14px;font:600 13px system-ui,sans-serif;cursor:pointer}
  .dr-pop .row .ok{background:var(--dr-on-bg);color:var(--dr-on-fg)}.dr-pop .row .del{background:rgba(255,90,95,.16);color:#ff5a5f}.dr-pop .row .x{background:rgba(var(--dr-w),.06);color:var(--dr-fg)}
  .dr-pop .row .ok:hover{filter:brightness(1.08)}.dr-pop .row .x:hover{background:rgba(var(--dr-w),.12)}.dr-pop .row .del:hover{background:rgba(255,90,95,.26)}

  /* ── the review panel: a FloatingPanel twin (same chrome as the tweaks panel) ── */
  .dr-fp{position:fixed;right:16px;bottom:16px;z-index:2147483598;width:296px;background:rgba(var(--dr-g),.85);-webkit-backdrop-filter:blur(22px) saturate(150%);backdrop-filter:blur(22px) saturate(150%);border:1px solid rgba(var(--dr-w),.1);border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.5);color:#e8edf2;font:13px/1.45 system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;max-height:calc(100vh - 40px);overflow:hidden;transition:opacity .15s}
  .dr-fp-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 10px 11px 14px;cursor:grab;user-select:none;border-bottom:1px solid rgba(var(--dr-w),.07)}
  .dr-fp-hd:active{cursor:grabbing}
  .dr-fp-hd b,.dr-fp.pill b{font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--dr-fg);display:flex;align-items:center;gap:8px}
  .dr-fp-hd .r{display:flex;align-items:center;gap:6px}
  .dr-grip{color:#5f6d7a;letter-spacing:-2px}
  .dr-cnt{background:rgba(255,255,255,.14);border-radius:99px;padding:2px 7px;font-size:11px}
  .dr-dot{width:8px;height:8px;border-radius:99px;background:#ff5a5f;box-shadow:0 0 0 3px rgba(255,90,95,.25);flex:none}
  .dr-dot.on{background:#39d98a;box-shadow:0 0 0 3px rgba(57,217,138,.25)}
  .dr-ann{display:flex;align-items:center;gap:7px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#aeb8c2;border-radius:999px;padding:4px 10px 4px 8px;font:600 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;white-space:nowrap}
  .dr-ann.on{border-color:rgba(57,217,138,.45);color:#eef3f7;background:rgba(57,217,138,.1)}
  .dr-fp-min{width:24px;height:24px;border-radius:7px;border:0;background:rgba(var(--dr-w),.06);color:#aeb8c2;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:15px;line-height:1;flex:none;padding:0}
  .dr-fp-min:hover{background:rgba(var(--dr-w),.14);color:#fff}
  .dr-fp-bd{padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;min-height:0;flex:1 1 auto}
  .dr-fp-bd::-webkit-scrollbar,.dr-fp-bd textarea::-webkit-scrollbar{width:8px;height:8px}
  .dr-fp-bd::-webkit-scrollbar-track,.dr-fp-bd textarea::-webkit-scrollbar-track{background:transparent}
  .dr-fp-bd::-webkit-scrollbar-thumb,.dr-fp-bd textarea::-webkit-scrollbar-thumb{background:rgba(var(--dr-w),.18);border-radius:4px}
  .dr-fp-bd,.dr-fp-bd textarea{scrollbar-width:thin;scrollbar-color:rgba(var(--dr-w),.18) transparent}
  .dr-fp-rz{position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:se-resize;touch-action:none}
  .dr-fp-rz::after{content:'';position:absolute;right:3px;bottom:3px;width:7px;height:7px;border-right:2px solid rgba(var(--dr-w),.32);border-bottom:2px solid rgba(var(--dr-w),.32);border-bottom-right-radius:3px}
  .dr-fp.pill{width:auto;max-height:none;flex-direction:row;align-items:center;gap:8px;padding:9px 9px 9px 15px;border-radius:999px;cursor:grab;background:rgba(var(--dr-g),.9);border-color:rgba(var(--dr-w),.12);box-shadow:0 14px 40px rgba(0,0,0,.45)}
  .dr-fp.pill:active{cursor:grabbing}
  .dr-fp-bd .t{font:600 11px ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--dr-fg3b)}
  .dr-fp-bd .it{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:10px;background:rgba(var(--dr-w),.04);border:1px solid rgba(var(--dr-w),.07);cursor:pointer}
  .dr-fp-bd .it:hover{border-color:rgba(var(--dr-w),.22)}
  .dr-fp-bd .it .n{flex:none;width:20px;height:20px;border-radius:99px;background:#ff5a5f;color:#fff;font:700 11px/20px system-ui;text-align:center}
  .dr-fp-bd .it .c{flex:1;min-width:0;font-size:12px;color:var(--dr-fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dr-fp-bd .it .rm{flex:none;width:20px;height:20px;border:0;border-radius:6px;background:transparent;color:var(--dr-fg3b);font:16px/20px system-ui,sans-serif;cursor:pointer;padding:0;opacity:0;align-self:center}
  .dr-fp-bd .it:hover .rm{opacity:1}
  .dr-fp-bd .it .rm:hover{background:rgba(255,90,95,.18);color:#ff5a5f}
  .dr-fp-bd .it .k{font-size:10px;color:var(--dr-fg3b);text-transform:uppercase;letter-spacing:.06em}
  .dr-fp-bd textarea.gen{flex:1 1 56px;resize:none}
  .dr-fp-bd textarea{width:100%;box-sizing:border-box;background:rgba(var(--dr-w),.05);border:1px solid rgba(var(--dr-w),.12);border-radius:8px;color:var(--dr-fg);padding:8px 10px;font:12px/1.4 system-ui,sans-serif;min-height:56px;resize:vertical}
  .dr-fp-bd .send{border:0;border-radius:10px;padding:11px;font:700 13px system-ui,sans-serif;background:#39d98a;color:var(--dr-on-fg);cursor:pointer}
  .dr-fp-bd .send:disabled{opacity:.4;cursor:not-allowed}
  .dr-fp-bd .hint{font-size:11px;color:var(--dr-fg3b);line-height:1.5}
  .dr-fp-bd kbd{font:10px ui-monospace,Menlo,monospace;background:rgba(var(--dr-w),.08);border:1px solid rgba(var(--dr-w),.14);border-radius:4px;padding:1px 5px}

  /* ── overlay dock: one strip, a chip per overlay. click = cycle Open→Pill→Hidden, drag across = opacity ── */
  .dr-dock{transition:opacity .15s;box-sizing:border-box;position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:4px;padding:5px 6px;background:rgba(var(--dr-g),.9);-webkit-backdrop-filter:blur(22px) saturate(150%);backdrop-filter:blur(22px) saturate(150%);border:1px solid rgba(var(--dr-w),.08);border-radius:999px;box-shadow:0 18px 50px rgba(0,0,0,.5);color:var(--dr-fg);font:13px/1.4 system-ui,-apple-system,sans-serif;white-space:nowrap;user-select:none;max-width:60vw}
  .dr-dock.placed{transform:none}
  /* collapse/expand: the shell glides between the two measured sizes (JS sets the
     endpoints) so the strip shrinks into the ◐ instead of snapping to a dot */
  .dr-dock.anim{overflow:hidden;transition:width .26s cubic-bezier(.22,.61,.36,1),height .26s cubic-bezier(.22,.61,.36,1),padding .26s cubic-bezier(.22,.61,.36,1)}
  @media (prefers-reduced-motion:reduce){.dr-dock.anim{transition:none}}
  .dr-dock.vert{flex-direction:column;border-radius:22px;padding:6px 5px;max-width:none;max-height:80vh}
  .dr-dock.side:not(.placed){left:auto;right:18px;top:50%;bottom:auto;transform:translateY(-50%)}
  .dr-dock.side.left:not(.placed){right:auto;left:18px}
  .dr-dock.vert .chip{width:34px;padding:0;justify-content:center}
  .dr-dock.vert .chip .nm,.dr-dock.vert .chip .pct{display:none}
  .dr-dock.vert .chip .fill{top:auto;width:100%!important;height:var(--op)}
  .dr-dock.vert .sep{width:18px;height:1px;margin:4px 0}
  .dr-dock.ghost{opacity:.55;box-shadow:0 0 0 2px #4a90c2,0 18px 50px rgba(0,0,0,.5)}
  .dr-dock.all-hidden{border-color:rgba(255,180,87,.45)}
  .dr-dock .h{position:relative;width:30px;height:30px;flex:none;display:grid;place-items:center;font-size:15px;color:var(--dr-fg3);cursor:grab;border-radius:99px}
  .dr-dock .h:hover{background:rgba(var(--dr-w),.05);color:var(--dr-fg)}
  .dr-dock .h:active{cursor:grabbing}
  .dr-dock .h .n{position:absolute;top:-3px;right:-3px;min-width:15px;height:15px;border-radius:99px;background:#4a90c2;color:#fff;font:700 9.5px/15px ui-monospace,Menlo,monospace;text-align:center;padding:0 4px;display:none}
  .dr-dock.mini{padding:5px}
  .dr-dock.mini > :not(.h){display:none}
  .dr-dock.mini .h{width:32px;height:32px;color:var(--dr-fg)}
  .dr-dock.mini .h .n{display:block}
  .dr-dock .chip{position:relative;height:30px;padding:0 12px 0 10px;border-radius:999px;border:1px solid rgba(var(--dr-w),.08);background:rgba(var(--dr-w),.05);display:flex;align-items:center;gap:7px;font-size:12.5px;overflow:hidden;cursor:pointer;color:var(--dr-fg);flex:none;max-width:150px;touch-action:none;--op:100%}
  .dr-dock .chip:hover{border-color:rgba(var(--dr-w),.15)}
  .dr-dock .chip .fill{position:absolute;left:0;top:0;bottom:0;width:var(--op);background:rgba(var(--dr-w),.08);pointer-events:none}
  .dr-dock .chip.scrub .fill{background:rgba(74,144,194,.35)}
  .dr-dock .chip .dot{width:7px;height:7px;border-radius:99px;background:var(--dr-fg);flex:none;position:relative}
  .dr-dock .chip.pill .dot{background:transparent;box-shadow:inset 0 0 0 1.5px var(--dr-fg2)}
  .dr-dock .chip.hidden{color:var(--dr-fg3);background:transparent}
  .dr-dock .chip.hidden .dot{background:transparent;box-shadow:inset 0 0 0 1.5px var(--dr-fg3)}
  .dr-dock .chip.hidden .fill{display:none}
  .dr-dock .chip .nm{position:relative;overflow:hidden;text-overflow:ellipsis}
  .dr-dock .chip .pct{position:relative;font:10.5px ui-monospace,Menlo,monospace;color:var(--dr-fg3)}
  .dr-dock .chip.focus{box-shadow:0 0 0 2px #4a90c2}
  .dr-dock .chip.new{animation:dr-pop .3s cubic-bezier(.2,.9,.3,1.3)}
  @keyframes dr-pop{from{transform:scale(.6);opacity:0}}
  .dr-dock .sep{width:1px;height:18px;background:rgba(var(--dr-w),.15);margin:0 4px;flex:none}
  .dr-dock .ic{width:30px;height:30px;border:0;border-radius:99px;background:transparent;color:var(--dr-fg2);display:grid;place-items:center;padding:0;cursor:pointer;flex:none}
  .dr-dock .ic:hover{background:rgba(var(--dr-w),.05);color:var(--dr-fg)}
  .dr-dock .ic.on{background:rgba(var(--dr-w),.09);color:var(--dr-fg)}
  .dr-dock .ic.hot{background:#4a90c2;color:#fff}
  .dr-dock .ic.warn{color:#ffb457}
  .dr-dock .ic svg{width:15px;height:15px}
  .dr-dock-tip{position:fixed;z-index:2147483647;font:11px ui-monospace,Menlo,monospace;color:#fff;background:rgba(var(--dr-g),.9);padding:5px 9px;border-radius:7px;border:1px solid rgba(var(--dr-w),.08);white-space:nowrap;pointer-events:none;transform:translate(-50%,-100%);display:none}
  .dr-dock-fly{position:fixed;z-index:2147483647;width:292px;padding:10px 12px;border-radius:12px;background:rgba(var(--dr-g),.9);-webkit-backdrop-filter:blur(22px) saturate(150%);backdrop-filter:blur(22px) saturate(150%);border:1px solid rgba(var(--dr-w),.08);box-shadow:0 18px 50px rgba(0,0,0,.5);display:none;gap:9px;color:var(--dr-fg);font:13px/1.4 system-ui,-apple-system,sans-serif}
  .dr-dock-fly.on{display:grid}
  .dr-dock-fly .t{display:flex;justify-content:space-between;align-items:center;font:600 10px ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--dr-fg3)}
  .dr-dock-fly .t button{border:0;background:none;color:var(--dr-fg3);font:11px system-ui,sans-serif;cursor:pointer;text-decoration:underline dotted;padding:0}
  .dr-dock-fly .t button.hot,.dr-dock-fly .t button:hover{color:var(--dr-fg2)}
  .dr-dock-fly .r{display:grid;grid-template-columns:34px 1fr 34px;align-items:center;gap:8px;font-size:11.5px;color:var(--dr-fg3)}
  .dr-dock-fly .r.dk{grid-template-columns:34px 1fr}
  .dr-dock-fly .v{text-align:right;font:11px ui-monospace,Menlo,monospace;color:var(--dr-fg2)}
  .dr-dock-fly .v.hot{color:#4a90c2}
  .dr-dock-fly input[type=range]{-webkit-appearance:none;appearance:none;width:100%;min-width:0;height:24px;background:transparent;margin:0;cursor:pointer;--p:50%}
  .dr-dock-fly input[type=range]::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:linear-gradient(to right,var(--dr-fg2) var(--p),rgba(var(--dr-w),.09) var(--p))}
  .dr-dock-fly input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;border-radius:99px;background:var(--dr-fg);margin-top:-4px;box-shadow:0 1px 3px rgba(0,0,0,.5)}
  .dr-dock-fly input[type=range]::-moz-range-track{height:3px;border-radius:2px;background:rgba(var(--dr-w),.09)}
  .dr-dock-fly input[type=range]::-moz-range-progress{height:3px;border-radius:2px;background:var(--dr-fg2)}
  .dr-dock-fly input[type=range]::-moz-range-thumb{width:11px;height:11px;border:0;border-radius:99px;background:var(--dr-fg)}
  .dr-dock-fly .seg{display:flex;gap:2px;padding:2px;border-radius:7px;background:rgba(var(--dr-w),.05);height:22px;box-sizing:border-box}
  .dr-dock-fly .seg button{flex:1;border:0;border-radius:5px;font:600 10.5px/18px system-ui,sans-serif;text-align:center;color:var(--dr-fg3);background:transparent;cursor:pointer;padding:0}
  .dr-dock-fly .seg button.on{background:var(--dr-on-bg);color:var(--dr-on-fg)}
  .dr-dock-fly .tints{display:flex;gap:8px;align-items:center;min-width:0}
  .dr-dock-fly .tints input[type=color]{-webkit-appearance:none;appearance:none;width:26px;height:26px;border:1px solid rgba(var(--dr-w),.25);border-radius:8px;padding:0;background:none;cursor:pointer;flex:none}
  .dr-dock-fly .tints input[type=color]::-webkit-color-swatch-wrapper{padding:2px}
  .dr-dock-fly .tints input[type=color]::-webkit-color-swatch{border:0;border-radius:5px}
  .dr-dock-fly .tints .hex{width:68px;height:26px;border:1px solid rgba(var(--dr-w),.15);border-radius:7px;background:rgba(var(--dr-w),.05);color:var(--dr-fg);font:11px ui-monospace,Menlo,monospace;padding:0 7px;box-sizing:border-box}
  .dr-dock-fly .tints .quick{display:flex;gap:5px;margin-left:auto}
  .dr-dock-fly .tints .quick button{width:16px;height:16px;border-radius:99px;border:1px solid rgba(var(--dr-w),.3);cursor:pointer;padding:0;box-shadow:0 0 0 1px rgba(0,0,0,.35)}
  .dr-dock-fly .tints .quick button.on{outline:2px solid #4a90c2;outline-offset:1px}
  .dr-dock-fly .hint{font-size:11px;color:var(--dr-fg3);line-height:1.6}
  .dr-dock-fly kbd{font:10px ui-monospace,Menlo,monospace;background:rgba(var(--dr-w),.08);border:1px solid rgba(var(--dr-w),.14);border-radius:4px;padding:1px 5px}
  /* ── sonner: one container (glass, draggable header, collapses to a pill) holding a tile per sent batch ── */
  .dr-sn{position:fixed;right:16px;bottom:16px;z-index:2147483601;box-sizing:border-box;width:320px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:rgba(var(--dr-g),.85);-webkit-backdrop-filter:blur(22px) saturate(150%);backdrop-filter:blur(22px) saturate(150%);border:1px solid rgba(var(--dr-w),.1);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.5);color:var(--dr-fg);font:13px/1.4 system-ui,-apple-system,sans-serif;overflow:hidden;transition:opacity .15s}
  .dr-sn.empty{display:none}
  .dr-sn .hd{display:flex;align-items:center;gap:8px;padding:9px 8px 9px 12px;cursor:grab;user-select:none;touch-action:none;border-bottom:1px solid rgba(var(--dr-w),.07);flex:none;min-width:0}
  .dr-sn .hd b{font:700 10.5px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--dr-fg2);flex:none}
  .dr-sn .hd .sum{font-size:12px;color:var(--dr-fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-width:0}
  .dr-sn .hd .sum em{font-style:normal;color:var(--dr-fg)}
  .dr-sn .hd .ic{width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dr-fg3b);font:15px/22px system-ui,sans-serif;cursor:pointer;padding:0;flex:none}
  .dr-sn .hd .ic:hover{background:rgba(var(--dr-w),.08);color:var(--dr-fg)}
  .dr-sn .ls{display:flex;flex-direction:column;gap:6px;padding:8px;overflow:auto;min-height:0}
  .dr-sn .ls::-webkit-scrollbar{width:8px}.dr-sn .ls::-webkit-scrollbar-thumb{background:rgba(var(--dr-w),.18);border-radius:4px}.dr-sn .ls{scrollbar-width:thin;scrollbar-color:rgba(var(--dr-w),.18) transparent}
  .dr-sn.pill{width:auto;border-radius:999px}.dr-sn.pill .hd{border-bottom:0;padding:7px 8px 7px 14px}.dr-sn.pill .ls{display:none}
  .dr-sn .t{position:relative;box-sizing:border-box;background:rgba(var(--dr-w),.04);border:1px solid rgba(var(--dr-w),.07);border-radius:10px;padding:9px 32px 9px 11px;display:flex;flex-direction:column;gap:6px;animation:dr-sn-in .22s cubic-bezier(.2,.8,.2,1)}
  .dr-sn .t.out{animation:dr-sn-out .18s ease-in forwards}
  @keyframes dr-sn-in{from{transform:translateY(8px);opacity:0}}
  @keyframes dr-sn-out{to{transform:translateY(6px);opacity:0}}
  @media(prefers-reduced-motion:reduce){.dr-sn .t,.dr-sn .t.out{animation:none}}
  .dr-sn .t .tt{display:flex;align-items:center;gap:8px;font-weight:600;min-width:0;cursor:pointer;user-select:none}
  .dr-sn .t .tt span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dr-sn .t .tt .mini{display:none;margin-left:auto;font:600 11px ui-monospace,Menlo,monospace;color:var(--dr-fg2);flex:none}
  .dr-sn .t.min .st,.dr-sn .t.min .pins{display:none}.dr-sn .t.min .tt .mini{display:block}
  .dr-sn .t .st{font-size:12px;color:var(--dr-fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dr-sn .t .bar{height:4px;border-radius:99px;background:rgba(var(--dr-w),.09);overflow:hidden}
  .dr-sn .t .bar i{display:block;height:100%;width:var(--p,0%);background:#39d98a;border-radius:99px;transition:width .3s}
  .dr-sn .t.wait .bar i{background:rgba(var(--dr-w),.25);width:30%;animation:dr-sn-scan 1.4s ease-in-out infinite}
  @keyframes dr-sn-scan{0%{transform:translateX(-100%)}100%{transform:translateX(340%)}}
  @media(prefers-reduced-motion:reduce){.dr-sn .t.wait .bar i{animation:none;width:100%}}
  .dr-sn .t .pins{display:flex;gap:4px;flex-wrap:wrap}
  .dr-sn .t .pins i{box-sizing:border-box;width:20px;height:20px;padding:0;border-radius:99px;display:inline-flex;align-items:center;justify-content:center;font:700 10px/1 ui-monospace,Menlo,monospace;font-style:normal;background:rgba(var(--dr-w),.08);color:var(--dr-fg3b);border:1px solid rgba(var(--dr-w),.1);cursor:default}
  .dr-sn .t .pins i.working{border-color:#ffb457;color:#ffb457;animation:dr-sn-pulse 1.2s ease-in-out infinite}
  .dr-sn .t .pins i.done{background:#39d98a;border-color:#39d98a;color:#0c1116}
  .dr-sn .t .pins i.skipped{background:rgba(255,180,87,.25);border-color:#ffb457;color:#ffb457}
  .dr-sn .t .pins i.question{background:rgba(74,144,194,.3);border-color:#4a90c2;color:#cfe4f5}
  .dr-sn .t .fb{display:flex;flex-direction:column;gap:5px;max-height:180px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:rgba(var(--dr-w),.18) transparent}
  .dr-sn .t .fb::-webkit-scrollbar{width:6px}.dr-sn .t .fb::-webkit-scrollbar-thumb{background:rgba(var(--dr-w),.18);border-radius:3px}
  .dr-sn .t.min .fb{display:none}
  .dr-sn .t .fb .fh{font:700 9.5px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--dr-fg3);flex:none}
  .dr-sn .t .fb .fi{border-left:2px solid rgba(var(--dr-w),.16);padding-left:8px;font-size:12px;line-height:1.45;color:var(--dr-fg2);white-space:pre-wrap;overflow-wrap:anywhere}
  .dr-sn .t .fb .fi b{display:block;font:700 9.5px/1.4 ui-monospace,Menlo,monospace;color:var(--dr-fg3b)}
  .dr-sn .t .fb .fi.done{border-left-color:#39d98a}
  .dr-sn .t .fb .fi.skipped{border-left-color:#ffb457}
  .dr-sn .t .fb .fi.working{border-left-color:#ffb457;opacity:.8}
  .dr-sn .t .fb .fi.question{border-left-color:#4a90c2;background:rgba(74,144,194,.14);border-radius:0 7px 7px 0;padding:5px 8px;color:#dceaf6}
  .dr-sn .t .fb .fi.question b{color:#4a90c2}
  .dr-sn .t .dm{position:absolute;top:6px;right:30px;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dr-fg3b);font:13px/22px system-ui,sans-serif;cursor:pointer;padding:0;display:none}
  .dr-sn .t .dm:hover{background:rgba(var(--dr-w),.08);color:var(--dr-fg)}
  .dr-sn .t.ok .dm,.dr-sn .t.err .dm{display:block}.dr-sn .t.ok,.dr-sn .t.err{padding-right:54px}
  @keyframes dr-sn-pulse{50%{box-shadow:0 0 0 3px rgba(255,180,87,.25)}}
  @media(prefers-reduced-motion:reduce){.dr-sn .t .pins i.working{animation:none}}
  .dr-sn .t .mn{position:absolute;top:6px;right:6px;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dr-fg3b);font:15px/22px system-ui,sans-serif;cursor:pointer;padding:0}
  .dr-sn .t .mn:hover{background:rgba(var(--dr-w),.08);color:var(--dr-fg)}
  .dr-sn .t.err{border-color:rgba(255,90,95,.45)}.dr-sn .t.ok .bar i{width:100%}
  .dr-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483601;background:#1d2229;color:#fff;padding:10px 16px;border-radius:999px;font:600 13px system-ui,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.35)}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const canvas = el('div', 'dr-canvas');
  const hover = el('div', 'dr-hover');
  const layer = el('div'); // pins + rects live here (fixed-position children)
  const panel = el('div', 'dr-fp');
  document.body.append(canvas, hover, layer, panel);

  // ── helpers ──
  const cssPath = (node) => {
    const parts = [];
    while (node && node.nodeType === 1 && node !== document.body) {
      let s = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(s + '#' + node.id); break; }
      const cls = [...node.classList].filter((c) => !c.startsWith('dr-')).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      const sib = [...node.parentNode.children].filter((c) => c.tagName === node.tagName);
      if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(node) + 1})`;
      parts.unshift(s); node = node.parentNode;
    }
    return parts.join(' > ');
  };
  const OVERLAY_SEL = '.dr-fp,.dr-pop,.dr-pin,.dr-dock,.dr-dock-fly,.dr-chat';
  const under = (x, y) => { canvas.style.pointerEvents = 'none'; const n = document.elementFromPoint(x, y); canvas.style.pointerEvents = ''; return n && !n.closest(OVERLAY_SEL) ? n : null; };
  const appState = () => { try { return typeof window.__designReviewState === 'function' ? window.__designReviewState() : window.__designReviewState || null; } catch (e) { return null; } };
  // ── sonner: ONE container at the bottom-right — a draggable header (PROGRESS · n active · x/y)
  // that folds the whole stack to a pill, holding a tile per sent batch. Each tile polls
  // (terminal states persist — a finished card stays green until dismissed via its own minimise/✕;
  // snDrop only stops it from resurrecting on reload)
  // GET <api>/<id> for claim + per-pin progress and minimises on its own (remembered per batch).
  // × hides the container; the dock's "Progress" chip (or sending new pins) brings it back.
  // Batches persist in localStorage — finished ones too, so the feedback notes stay readable
  // across a reload until dismissed (the 8 most recent are kept).
  const SNKEY = BRAND.key + ':batches', SNUI = BRAND.key + ':sn';
  let snUi = { pos: null, collapsed: false };
  try { Object.assign(snUi, JSON.parse(localStorage.getItem(SNUI) || '{}')); } catch (e) {}
  const snUiSave = () => { try { localStorage.setItem(SNUI, JSON.stringify(snUi)); } catch (e) {} };
  const sn = el('div', 'dr-sn empty'), snHd = el('div', 'hd'), snLs = el('div', 'ls');
  const snSum = el('span', 'sum'), snMn = el('button', 'ic', '–'), snX = el('button', 'ic', '×');
  snX.title = 'Hide progress (bring it back from the dock, or by sending new pins)';
  snHd.append(el('span', 'dr-grip', '⋮⋮'), el('b', '', 'Progress'), snSum, snMn, snX); sn.append(snHd, snLs); document.body.appendChild(sn);
  let snHover = false, snReady = false, snOpacity = 1, snHoverOpacity = 1, snHidden = false; // driven by the dock chip via the overlay registry
  sn.addEventListener('pointerenter', () => { snHover = true; snApply(); });
  sn.addEventListener('pointerleave', () => { snHover = false; snApply(); });
  const snApply = () => { // opacity / hidden from its own dock chip; blur + size from the global Look
    if (!snReady) return;
    sn.style.opacity = snHover ? snHoverOpacity : snOpacity; sn.style.display = snHidden || chatOpen ? 'none' : ''; // yields to the drawer, like the panel
    sn.classList.toggle('empty', !snLs.children.length); sn.classList.toggle('pill', snUi.collapsed);
    snMn.textContent = snUi.collapsed ? '+' : '–'; snMn.title = snUi.collapsed ? 'Expand' : 'Collapse to a pill';
    const lk = (typeof ovSettings === 'object' && ovSettings && ovSettings.look) || { size: 1, blur: 22 };
    sn.style.backdropFilter = sn.style.webkitBackdropFilter = `blur(${lk.blur}px) saturate(150%)`;
    sn.style.transform = lk.size === 1 ? '' : `scale(${lk.size})`;
    snPlace();
  };
  const snPlace = () => {
    sn.style.transformOrigin = snUi.pos ? 'top left' : 'bottom right';
    if (snUi.pos) { // dragged somewhere: keep it there (re-clamped to the viewport)
      const p = clampTo(sn, snUi.pos.x, snUi.pos.y);
      Object.assign(sn.style, { left: p.x + 'px', top: p.y + 'px', right: 'auto', bottom: 'auto' }); return;
    }
    let bottom = 16; // default corner: stay clear of the review panel when it sits there too
    if (panel.style.display !== 'none') { const r = panel.getBoundingClientRect(); if (r.width && r.right > window.innerWidth - 360 && r.bottom > window.innerHeight - 200) bottom = Math.max(16, window.innerHeight - r.top + 8); }
    Object.assign(sn.style, { left: '', top: '', right: (chatOpen ? chatW * chatScale + 16 : 16) + 'px', bottom: bottom + 'px' });
  };
  const ovCfgSafe = (id) => { try { return ovCfg(id); } catch (e) { return null; } };
  const snSetHidden = (v) => { snHidden = v; const c = window.__overlayRegistry && ovCfgSafe('progress'); if (c) c.hidden = v; if (typeof ovSave === 'function') ovSave(); snApply(); if (typeof renderHub === 'function') renderHub(); };
  const snSetCollapsed = (v) => { // whole container ↔ pill (this is the dock chip's "Pill" state)
    snUi.collapsed = v; snUiSave();
    const c = window.__overlayRegistry && ovCfgSafe('progress'); if (c && !c.hidden && (c.mode === 'pill') !== v) { c.mode = v ? 'pill' : 'open'; if (typeof ovSave === 'function') ovSave(); if (typeof renderHub === 'function') renderHub(); }
    snApply();
  };
  snMn.onclick = () => snSetCollapsed(!snUi.collapsed); snX.onclick = () => snSetHidden(true);
  snHd.title = 'Drag to move · click to collapse/expand'; // drag wiring happens at init (dragOrClick is declared later)
  const snRemove = (t) => { if (!t.isConnected) return; t.classList.add('out'); setTimeout(() => { t.remove(); snHeader(); snApply(); }, 200); };
  const snNotice = (m, kind, ttl) => { const t = el('div', 't ' + (kind || '')); t.append(el('div', 'st', m)); const x = el('button', 'mn', '×'); x.onclick = () => snRemove(t); t.append(x); snLs.appendChild(t); snHeader(); snApply(); if (ttl !== 0) setTimeout(() => snRemove(t), ttl || 3200); return t; };
  const toast = (m) => snNotice(m, '', 2600);
  let snBatches = [];
  try { snBatches = JSON.parse(localStorage.getItem(SNKEY) || '[]'); } catch (e) {}
  const snSave = () => { try { localStorage.setItem(SNKEY, JSON.stringify(snBatches)); } catch (e) {} };
  const snDrop = (id) => { snBatches = snBatches.filter((b) => b.id !== id); snSave(); };
  const snHeader = () => { // aggregate line: n active · resolved/total (+ waiting)
    const ts = [...snLs.querySelectorAll('.t[data-id]')];
    let res = 0, tot = 0, waiting = 0, working = 0;
    ts.forEach((t) => { res += Number(t.dataset.res || 0); tot += Number(t.dataset.tot || 0); if (t.dataset.wait === '1') waiting++; working += Number(t.dataset.working || 0); });
    if (!ts.length) { snSum.textContent = ''; return; }
    snSum.innerHTML = `<em>${ts.length}</em> batch${ts.length === 1 ? '' : 'es'} · <em>${res}/${tot}</em> resolved${working ? ` · ${working} in progress` : ''}${waiting ? ` · ${waiting} waiting` : ''}`;
  };
  function snTrack(b) { // b: { id, total, page, at, min? }
    const t = el('div', 't wait' + (b.min ? ' min' : '')); t.dataset.id = b.id; t.dataset.tot = b.total || 1;
    const keys = b.total ? Array.from({ length: b.total }, (_, i) => String(i + 1)) : ['0']; // '0' = the general note (note-only batch)
    const tt = el('div', 'tt'), mini = el('span', 'mini', `0/${keys.length}`); tt.append(el('span', '', b.total ? `${b.total} pin${b.total === 1 ? '' : 's'} sent` : 'General note sent'), mini);
    const setMin = (v) => { b.min = v; snSave(); t.classList.toggle('min', v); mn.textContent = v ? '+' : '–'; mn.title = v ? 'Expand' : 'Minimise'; };
    const mn = el('button', 'mn', b.min ? '+' : '–'); mn.title = b.min ? 'Expand' : 'Minimise'; mn.onclick = () => setMin(!b.min);
    tt.onclick = () => setMin(!b.min); tt.title = 'Click to minimise/expand';
    if (BRAND.chat) { const cb = el('button', '', 'chat'); cb.style.cssText = 'cursor:pointer;border:0;background:rgba(255,255,255,.12);color:inherit;font:600 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase;border-radius:99px;padding:3px 8px;margin-left:6px'; cb.title = 'Open the chat with this batch\'s worker'; cb.onclick = (e) => { e.stopPropagation(); openChat(b.id); }; tt.append(cb); }
    const st = el('div', 'st', 'Waiting for a session to pick it up…');
    const bar = el('div', 'bar'); bar.append(el('i'));
    const pins = el('div', 'pins'); keys.forEach((k) => { const d = el('i', '', k === '0' ? '✎' : k); d.title = `${k === '0' ? 'General note (no pins in this batch)' : 'Pin ' + k} · pending`; pins.append(d); });
    // Notes the working session writes with report-pin render here, so a question asked
    // through a pin is answered on the page instead of only in that session's terminal.
    const fb = el('div', 'fb'); fb.style.display = 'none';
    const dm = el('button', 'dm', '✕'); dm.title = 'Dismiss'; dm.onclick = () => { stop(); snDrop(b.id); snRemove(t); };
    t.append(tt, st, bar, pins, fb, mn, dm); snLs.appendChild(t); snHeader(); snApply();
    let timer = null, misses = 0, doneAt = 0;
    const stop = () => { if (timer) clearTimeout(timer); timer = null; };
    t._stop = stop; // snRetrack ends a card's polling before replacing it with a grown one
    const paint = (s) => {
      const claimed = !!s.claimedBy, who = s.claimedLabel || (claimed ? s.claimedBy.slice(0, 8) : '');
      const n = keys.length;
      // A finished batch is never 'waiting', even when nothing ever claimed it (a CLI-driven
      // session resolves pins without a claim) — otherwise the bar keeps its scanning animation.
      const settled = claimed || s.complete;
      t.classList.toggle('wait', !settled); t.classList.toggle('ok', s.complete);
      bar.firstChild.style.setProperty('--p', Math.round((s.resolved / Math.max(1, n)) * 100) + '%');
      mini.textContent = settled ? `${s.resolved}/${n}` : `0/${n} · waiting`;
      const counts = { done: 0, skipped: 0, question: 0, working: 0 };
      pins.querySelectorAll('i').forEach((d, i) => { const k = keys[i], p = s.progress[k]; d.className = p ? p.status : ''; if (p) counts[p.status]++; d.title = `${k === '0' ? 'General note (no pins in this batch)' : 'Pin ' + k} · ${p ? p.status : 'pending'}${p && p.note ? ' — ' + p.note : ''}`; });
      const notes = keys.map((k) => [k, s.progress[k]]).filter(([, p]) => p && p.note);
      fb.innerHTML = ''; fb.style.display = notes.length ? '' : 'none';
      if (notes.length) {
        fb.append(el('div', 'fh', `Feedback from ${BRAND.name}`));
        notes.forEach(([k, p]) => { const i = el('div', 'fi ' + p.status); i.append(el('b', '', `${k === '0' ? 'General note' : 'Pin ' + k}${p.status === 'question' ? ' · needs you' : ''}`), document.createTextNode(p.note)); fb.append(i); });
      }
      if (s.complete) st.textContent = `Done — ${counts.done} fixed${counts.skipped ? `, ${counts.skipped} skipped` : ''}${counts.question ? `, ${counts.question} answered` : ''}${notes.length ? '' : ` · see the reply in ${who || 'the session'}`}`;
      else if (claimed) st.textContent = `${who} is on it · ${s.resolved}/${n} resolved${counts.working ? ` · working on ${keys[0] === '0' ? 'the note' : 'pin ' + [...pins.querySelectorAll('i.working')].map((d) => d.textContent).join(', ')}` : ''}`;
      else st.textContent = s.to && s.to !== 'any' ? 'Waiting for the addressed session…' : 'Waiting for a session to pick it up…';
      Object.assign(t.dataset, { res: s.resolved, tot: n, wait: settled ? '0' : '1', working: counts.working }); snHeader();
    };
    const tick = async () => {
      timer = null;
      try {
        const r = await fetch(API + BRAND.api + '/' + encodeURIComponent(b.id));
        if (r.status === 404) { misses++; if (misses > 3) { st.textContent = 'Batch no longer on the server'; snDrop(b.id); return; } }
        else if (r.ok) { misses = 0; const s = await r.json(); paint(s); if (s.complete) { if (!doneAt) doneAt = Date.now(); if (!b.done) { b.done = true; snSave(); } return; } }
      } catch (e) { misses++; st.textContent = 'Server unreachable — retrying…'; }
      if (Date.now() - b.at > 6 * 3600 * 1000) { snDrop(b.id); snRemove(t); return; } // stale
      timer = setTimeout(tick, misses ? Math.min(10000, 2000 * (misses + 1)) : 2000);
    };
    tick();
  }
  // Pins sent from the chat drawer into an existing worker conversation grow that batch:
  // restart its progress card with the new total (the old card may already have stopped polling).
  function snRetrack(id, total) {
    const old = snLs.querySelector('.t[data-id="' + CSS.escape(id) + '"]'); if (old) { if (old._stop) old._stop(); old.remove(); snHeader(); }
    let b = snBatches.find((x) => x.id === id);
    if (!b) { b = { id, page: location.pathname }; snBatches.push(b); }
    b.total = total; b.done = false; b.at = Date.now(); snSave(); if (snHidden) snSetHidden(false); snTrack(b);
  }
  snBatches = snBatches.filter((b) => Date.now() - b.at < 6 * 3600 * 1000);
  { const fin = snBatches.filter((b) => b.done); if (fin.length > 8) { const cut = new Set(fin.sort((x, y) => x.at - y.at).slice(0, fin.length - 8).map((b) => b.id)); snBatches = snBatches.filter((b) => !cut.has(b.id)); } } // keep the 8 most recent finished cards
  snSave();
  const clampTo = (node, x, y) => {
    const b = node.getBoundingClientRect(); // rendered size — honours a scale transform
    return {
      x: Math.max(8, Math.min(window.innerWidth - b.width - 8, x)),
      y: Math.max(8, Math.min(window.innerHeight - b.height - 8, y)),
    };
  };
  // drag by `handle`; a press with no travel counts as a click
  const dragOrClick = (handle, node, onMove, onClick) => {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target instanceof Element && e.target !== handle && e.target.closest('button,input,textarea'))) return;
      const sx = e.clientX, sy = e.clientY, r = node.getBoundingClientRect(), ox = sx - r.left, oy = sy - r.top;
      let moved = false;
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        moved = true; const p = clampTo(node, ev.clientX - ox, ev.clientY - oy); onMove(p.x, p.y);
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (!moved && onClick) onClick(); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
  };

  // ── the panel chrome (open ↔ pill), same anatomy as FloatingPanel ──
  // Default corner: pinpoint (live app) docks top-right; the bare review brand keeps
  // bottom-right because a mockup's tweaks panel usually owns top-right.
  const CORNER_TOP = BRAND.key === 'pinpoint';
  const cornerOrigin = CORNER_TOP ? 'top right' : 'bottom right';
  const cornerStyle = CORNER_TOP
    ? { left: '', top: '16px', right: '16px', bottom: 'auto' }
    : { left: '', top: '', right: '16px', bottom: '16px' };
  const placePanel = () => {
    // the Look scale origin must follow the anchor: a corner-anchored panel scales toward its corner,
    // a positioned one scales from its top-left so left/top stay equal to the rendered rect
    panel.style.transformOrigin = state.panelPos ? 'top left' : cornerOrigin;
    if (!state.panelPos) { Object.assign(panel.style, cornerStyle); return; }
    const p = clampTo(panel, state.panelPos.x, state.panelPos.y);
    Object.assign(panel.style, { left: p.x + 'px', top: p.y + 'px', right: 'auto', bottom: 'auto' });
  };
  const setCollapsed = (c) => { state.collapsed = c; save(); buildPanel(); render(); if (typeof snPlace === 'function') snPlace(); };
  let body = null, hdCount = null, annBtn = null, dot = null;
  function buildPanel() {
    panel.innerHTML = ''; panel.classList.toggle('pill', state.collapsed);
    if (state.collapsed) {
      Object.assign(panel.style, { width: '', height: '' });
      dot = el('i', 'dr-dot');
      const b = el('b'); b.append(dot, document.createTextNode(BRAND.name)); hdCount = el('span', 'dr-cnt', '0'); b.append(hdCount);
      const x = el('button', 'dr-fp-min', '⤢'); x.setAttribute('aria-label', 'Expand'); x.onclick = () => setCollapsed(false);
      panel.append(el('span', 'dr-grip', '⋮⋮'), b, ...(BRAND.chat ? [chatBtn()] : []), x);
      body = null; annBtn = null;
      dragOrClick(panel, panel, (x2, y2) => { state.panelPos = { x: x2, y: y2 }; placePanel(); save(); }, () => setCollapsed(false));
    } else {
      Object.assign(panel.style, { width: state.size.w + 'px', height: state.size.h ? state.size.h + 'px' : '' });
      const hd = el('div', 'dr-fp-hd');
      const b = el('b'); b.append(el('span', 'dr-grip', '⋮⋮'), document.createTextNode(BRAND.name)); hdCount = el('span', 'dr-cnt', '0'); b.append(hdCount);
      const r = el('div', 'r');
      dot = el('i', 'dr-dot'); annBtn = el('button', 'dr-ann'); annBtn.append(dot, document.createTextNode('annotate')); annBtn.title = 'Toggle annotate mode (R)'; annBtn.onclick = toggle;
      const m = el('button', 'dr-fp-min', '–'); m.setAttribute('aria-label', 'Collapse'); m.onclick = () => setCollapsed(true);
      r.append(annBtn, ...(BRAND.chat ? [chatBtn()] : []), m); hd.append(b, r);
      body = el('div', 'dr-fp-bd');
      const rz = el('div', 'dr-fp-rz'); rz.setAttribute('aria-label', 'Resize');
      rz.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        // work in the panel's own (unscaled) px: Look size scales the rendered rect, so pointer
        // deltas are divided by the scale and the base size comes from offsetWidth/Height, not the rect
        // pin a corner-anchored panel to its current rect first so it grows toward the cursor, not away from it
        if (!state.panelPos) { const r0 = panel.getBoundingClientRect(); state.panelPos = { x: r0.left, y: r0.top }; placePanel(); }
        const sx = e.clientX, sy = e.clientY, rr = panel.getBoundingClientRect(), sz = rr.width / (panel.offsetWidth || rr.width) || 1, w0 = panel.offsetWidth, h0 = panel.offsetHeight;
        const move = (ev) => {
          state.size = { w: Math.max(248, Math.min((window.innerWidth - rr.left - 8) / sz, w0 + (ev.clientX - sx) / sz)), h: Math.max(200, Math.min((window.innerHeight - rr.top - 8) / sz, h0 + (ev.clientY - sy) / sz)) };
          Object.assign(panel.style, { width: state.size.w + 'px', height: state.size.h + 'px' });
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); save(); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      });
      panel.append(hd, body, rz);
      dragOrClick(hd, panel, (x2, y2) => { state.panelPos = { x: x2, y: y2 }; placePanel(); save(); }, null);
    }
    placePanel();
  }

  // ── render ──
  function render() {
    canvas.classList.toggle('on', state.on);
    if (!state.on) hover.style.display = 'none'; // send() and friends turn annotate off without a pointer event
    if (dot) dot.classList.toggle('on', state.on);
    if (annBtn) annBtn.classList.toggle('on', state.on);
    if (chatEl && chatEl._dot) { chatEl._dot.classList.toggle('on', state.on); chatEl._ann.classList.toggle('on', state.on); }
    if (hdCount) hdCount.textContent = state.pins.length;
    if (chatEl && chatEl._pins) renderChatPins(); // the drawer mirrors this list while it hides the panel
    layer.innerHTML = '';
    state.pins.forEach((p, i) => {
      const r = el('div', 'dr-rect'); Object.assign(r.style, { left: p.rect.x + 'px', top: p.rect.y + 'px', width: p.rect.w + 'px', height: p.rect.h + 'px' });
      const b = el('div', 'dr-pin' + (p.comment ? ' done' : ''), String(i + 1)); Object.assign(b.style, { left: p.rect.x + 'px', top: p.rect.y + 'px' });
      b.onclick = (e) => { e.stopPropagation(); openPop(i); };
      layer.append(r, b);
    });
    if (!body) return;
    body.innerHTML = '';
    if (!state.on) body.append(el('div', 'hint', 'Annotate mode is off — turn it on to pin feedback. Pins you already placed stay listed below.'));
    if (state.on && !state.pins.length) body.append(el('div', 'hint', 'Drag a box over any region, or click an element, then write what is wrong.<br>Rects are viewport-relative — keep the page at the scroll position you annotated.'));
    state.pins.forEach((p, i) => {
      const it = el('div', 'it', `<span class="n">${i + 1}</span><div style="flex:1;min-width:0"><div class="k">${p.type || 'note'}${p.element ? ' · ' + p.element.tag : ''}</div><div class="c">${p.comment || '<i style="color:#8a94a0">no comment yet</i>'}</div></div>`);
      const rm = el('button', 'rm', '×'); rm.title = 'Remove pin';
      rm.onclick = (e) => { e.stopPropagation(); state.pins.splice(i, 1); save(); closePop(); };
      it.append(rm); it.onclick = () => openPop(i); body.append(it);
    });
    body.append(el('div', 't', 'General note'));
    const g = el('textarea', 'gen'); g.placeholder = 'Anything not tied to a pin…'; g.value = state.general; g.oninput = () => { state.general = g.value; save(); sendBtn.disabled = !canSend(); }; body.append(g);

    if (BRAND.sessions) {
      // Multi-session addressing (pinpoint). Collapsed by default to one quiet line
      // ("To: Auto · change"); the picker only appears when the user asks for it.
      const cur = localStorage.getItem(BRAND.key + ':to') || '';
      const line = el('div', 'hint'); line.style.cssText = 'display:flex;gap:6px;align-items:center;margin:2px 0 8px';
      const autoLabel = BRAND.dispatch === 'worker' ? 'Auto (worker)' : 'Auto';
      const who = el('span'); who.textContent = 'To: ' + (cur ? (cur === 'worker' ? 'Headless worker' : cur) : autoLabel);
      const chg = el('button'); chg.type = 'button'; chg.textContent = 'change'; chg.style.cssText = 'background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer;font:inherit';
      line.append(who, chg); body.append(line);
      const sel = el('select'); sel.className = 'dr-to'; sel.style.cssText = 'display:none;width:100%;margin:0 0 8px;padding:6px 8px;border-radius:8px;border:1px solid rgba(0,0,0,.15);font:inherit;background:#fff;color:#111';
      const fill = (list) => {
        // Rebuilding options while the native dropdown is open makes Chromium dismiss
        // it instantly — skip the rebuild when the list hasn't actually changed.
        const sig = JSON.stringify(list.map((s) => [s.id, s.label, s.cwd]));
        if (sel.dataset.sig === sig) return;
        sel.dataset.sig = sig;
        sel.innerHTML = '';
        const any = document.createElement('option'); any.value = ''; any.textContent = BRAND.dispatch === 'worker' ? 'Auto — headless worker (chat in the drawer)' : 'Auto — a session named *' + BRAND.server + '*, else first to pick it up'; sel.append(any);
        if (BRAND.chat) { const wk = document.createElement('option'); wk.value = 'worker'; wk.textContent = 'Headless worker — always spawn one for this batch'; sel.append(wk); }
        list.forEach((s) => { const o = document.createElement('option'); o.value = s.id; o.textContent = s.label + (s.cwd ? ' — ' + s.cwd.split('/').pop() : ''); sel.append(o); });
        sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
        who.textContent = 'To: ' + (sel.value ? sel.options[sel.selectedIndex].textContent.split(' — ')[0] : autoLabel);
      };
      fill([]);
      sel.onchange = () => { localStorage.setItem(BRAND.key + ':to', sel.value); who.textContent = 'To: ' + (sel.value ? sel.options[sel.selectedIndex].textContent.split(' — ')[0] : autoLabel); sel.style.display = 'none'; };
      // Fetch BEFORE revealing the picker so the option list never mutates while the
      // user is opening the native dropdown (the mutation is what closed it).
      chg.onclick = () => {
        if (sel.style.display !== 'none') { sel.style.display = 'none'; return; }
        fetch(API + BRAND.sessions).then((r) => r.json()).then(fill).catch(() => {}).finally(() => { sel.style.display = 'block'; });
      };
      body.append(sel);
      if (cur) fetch(API + BRAND.sessions).then((r) => r.json()).then(fill).catch(() => {});
    }
    const sendBtn = el('button', 'send', 'Send to Claude →'); sendBtn.disabled = !canSend(); sendBtn.onclick = send; body.append(sendBtn);
    body.append(el('div', 'hint', '<kbd>R</kbd> annotate on/off · <kbd>Esc</kbd> close popover · <kbd>⌘↵</kbd> send · <kbd>⌥↵</kbd> save · drag the header to move · pins persist in this browser until sent'));
  }
  const canSend = () => state.pins.some((p) => p.comment) || state.general.trim().length > 0;

  // ── popover ──
  let pop = null, popHover = false;
  // Mirrors pApply for the panel: idle/hover opacity from the review overlay's config, blur + scale from the Look.
  const popApply = () => {
    if (!pop) return;
    pop.style.opacity = popHover ? pHoverOpacity : pOpacity;
    pop.style.display = pHidden ? 'none' : '';
    const lk = (typeof ovSettings === 'object' && ovSettings && ovSettings.look) || { size: 1, blur: 22 };
    pop.style.backdropFilter = pop.style.webkitBackdropFilter = `blur(${lk.blur}px) saturate(150%)`;
    pop.style.transform = lk.size === 1 ? '' : `scale(${lk.size})`; pop.style.transformOrigin = 'top left';
  };
  function closePop() { if (pop) { pop.remove(); pop = null; } state.editing = null; render(); }
  function openPop(i) {
    closePop(); const p = state.pins[i]; state.editing = i;
    pop = el('div', 'dr-pop');
    pop.innerHTML = `<div class="h"><span>Pin ${i + 1}${p.element ? ' · element' : ' · region'}</span><span>${Math.round(p.rect.w)}×${Math.round(p.rect.h)} · ⌘↵ send · ⌥↵ save</span></div>
      ${p.element ? `<div class="el">${p.element.path}${p.element.text ? '<br>“' + p.element.text.slice(0, 80) + '”' : ''}</div>` : ''}
      <div class="dr-types">${TYPES.map((t) => `<button data-t="${t}" class="${p.type === t ? 'on' : ''}">${t}</button>`).join('')}</div>
      <textarea class="c" placeholder="What's wrong / what you notice">${p.comment || ''}</textarea>
      <textarea class="fix" placeholder="What you'd do instead (optional)">${p.fix || ''}</textarea>
      <div class="row"><button class="del">Delete</button><button class="x">Close</button><button class="ok">Save</button></div>`;
    // Place beside the selection: right → left → below → above, using the popover's REAL size
    // (measured after mount, visibility hidden). A fixed guess pinned it into the corner whenever
    // the selection touched the viewport edge — and on top of the very thing being annotated.
    pop.style.visibility = 'hidden'; document.body.appendChild(pop);
    // The popover is part of the review overlay: it takes the panel's opacity / hover-full
    // behaviour and the global Look (size, blur, tint via the --dr-* tokens) — see popApply.
    Object.assign(pop.style, { width: state.popSize.w + 'px', height: state.popSize.h ? state.popSize.h + 'px' : '' });
    pop.addEventListener('pointerenter', () => { popHover = true; popApply(); });
    pop.addEventListener('pointerleave', () => { popHover = false; popApply(); });
    popApply();
    const sz = (typeof ovSettings === 'object' && ovSettings && ovSettings.look.size) || 1; // same Look size as every other overlay
    const W = pop.offsetWidth * sz, H = pop.offsetHeight * sz, vw = window.innerWidth, vh = window.innerHeight, G = 12, r = p.rect;
    const cands = [
      { x: r.x + r.w + G, y: r.y },                 // right
      { x: r.x - W - G, y: r.y },                   // left
      { x: r.x, y: r.y + r.h + G },                 // below
      { x: r.x, y: r.y - H - G },                   // above
    ];
    const fits = (c) => c.x >= G && c.y >= G && c.x + W <= vw - G && c.y + H <= vh - G;
    let c = cands.find(fits);
    if (!c) { // nothing fits (selection spans the screen): overlay near the selection's centre, clamped
      c = { x: r.x + r.w / 2 - W / 2, y: r.y + r.h / 2 - H / 2 };
    }
    c.x = Math.max(G, Math.min(vw - W - G, c.x)); c.y = Math.max(G, Math.min(vh - H - G, c.y));
    Object.assign(pop.style, { left: c.x + 'px', top: c.y + 'px', visibility: '' });
    // Draggable by its header, so the reviewer can always move it off what they're looking at.
    const hd = pop.querySelector('.h'); hd.style.cursor = 'grab';
    hd.onpointerdown = (e) => {
      const sx = e.clientX - pop.offsetLeft, sy = e.clientY - pop.offsetTop;
      const mv = (ev) => Object.assign(pop.style, { left: Math.max(G, Math.min(vw - W - G, ev.clientX - sx)) + 'px', top: Math.max(G, Math.min(vh - H - G, ev.clientY - sy)) + 'px' });
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    };
    // Resize from the corner, same maths as the panel: work in unscaled px, clamp to the viewport.
    const rz = el('div', 'dr-fp-rz'); rz.setAttribute('aria-label', 'Resize'); pop.appendChild(rz);
    rz.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); e.preventDefault();
      const sx = e.clientX, sy = e.clientY, rr = pop.getBoundingClientRect(), s2 = rr.width / (pop.offsetWidth || rr.width) || 1, w0 = pop.offsetWidth, h0 = pop.offsetHeight;
      const move = (ev) => {
        state.popSize = { w: Math.max(280, Math.min((window.innerWidth - rr.left - G) / s2, w0 + (ev.clientX - sx) / s2)), h: Math.max(260, Math.min((window.innerHeight - rr.top - G) / s2, h0 + (ev.clientY - sy) / s2)) };
        Object.assign(pop.style, { width: state.popSize.w + 'px', height: state.popSize.h + 'px' });
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); save(); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    pop.querySelectorAll('.dr-types button').forEach((b) => b.onclick = () => { p.type = b.dataset.t; pop.querySelectorAll('.dr-types button').forEach((o) => o.classList.toggle('on', o === b)); save(); });
    const commitPop = () => { p.comment = pop.querySelector('.c').value.trim(); p.fix = pop.querySelector('.fix').value.trim(); save(); };
    pop.querySelector('.ok').onclick = () => { commitPop(); closePop(); };

    pop.querySelector('.x').onclick = closePop;
    pop.querySelector('.del').onclick = () => { state.pins.splice(i, 1); save(); closePop(); };
    pop.querySelector('.c').focus();
  }

  // ── pointer: drag box or click element ──
  canvas.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; state.drag = { x: e.clientX, y: e.clientY, live: null }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (state.drag) {
      const d = state.drag; const x = Math.min(d.x, e.clientX), y = Math.min(d.y, e.clientY), w = Math.abs(e.clientX - d.x), h = Math.abs(e.clientY - d.y);
      if (!d.live) { d.live = el('div', 'dr-rect'); layer.appendChild(d.live); }
      Object.assign(d.live.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      hover.style.display = 'none'; return;
    }
    const n = under(e.clientX, e.clientY);
    if (n) { const r = n.getBoundingClientRect(); Object.assign(hover.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); } else hover.style.display = 'none';
  });
  canvas.addEventListener('pointerup', (e) => {
    const d = state.drag; if (!d) return; state.drag = null; if (d.live) d.live.remove();
    const w = Math.abs(e.clientX - d.x), h = Math.abs(e.clientY - d.y);
    let pin;
    if (w < 6 && h < 6) {
      const n = under(e.clientX, e.clientY); if (!n) return; const r = n.getBoundingClientRect();
      pin = { rect: { x: r.left, y: r.top, w: r.width, h: r.height }, element: { tag: n.tagName.toLowerCase(), path: cssPath(n), text: (n.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200) } };
    } else {
      pin = { rect: { x: Math.min(d.x, e.clientX), y: Math.min(d.y, e.clientY), w, h }, element: null };
      const n = under(pin.rect.x + pin.rect.w / 2, pin.rect.y + pin.rect.h / 2);
      if (n) pin.near = { path: cssPath(n), text: (n.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120) };
    }
    pin.type = ''; pin.comment = ''; pin.fix = ''; pin.state = appState(); pin.scrollY = window.scrollY; pin.at = new Date().toISOString();
    state.pins.push(pin); save(); render(); openPop(state.pins.length - 1);
  });

  // ── send ──
  async function send() {
    const body = { page: location.href, title: document.title, viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }, state: appState(), general: state.general, pins: state.pins, to: BRAND.sessions ? (localStorage.getItem(BRAND.key + ':to') || '') : undefined };
    try {
      const r = await fetch(API + BRAND.api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { let m = ''; try { const j = await r.json(); m = [j.error, j.hint].filter(Boolean).join(' — '); } catch (_) {} throw new Error(m || String(r.status)); }
      const j = await r.json();
      const b = { id: j.id, total: state.pins.length, page: location.pathname, at: Date.now() };
      snBatches.push(b); snSave(); if (snHidden) snSetHidden(false); snTrack(b);
      state.pins = []; state.general = ''; save(); state.on = false; closePop();
      if (BRAND.chat && j.worker) openChat(j.id);
    } catch (e) {
      // A refusal from the server (e.g. no pinpoint_<project> session is live) carries its
      // own hint; anything else (network, non-JSON) is almost always "server not running".
      const m = e && e.message && !/^\d+$/.test(e.message) && !/fetch/i.test(e.message) ? e.message : '';
      snNotice(m || ('Send failed — is the ' + BRAND.server + ' server running on ' + API + '?'), 'err', m ? 10000 : 5000);
    }
  }

  // ── annotate toggle + keys ──
  function toggle() {
    state.on = !state.on; hover.style.display = 'none';
    if (!state.on) closePop();
    if (state.on && state.collapsed) { setCollapsed(false); return; } // setCollapsed renders
    render();
  }
  // Shortcuts yield only to text entry (typing "r" in a comment must not toggle
  // annotate); sliders, buttons and checkboxes inside the overlays still let R / H
  // / Esc through. Everything runs in the capture phase so it works even when focus
  // is inside an overlay, and keystrokes born inside overlay UI never reach the
  // page's own handlers (artifacts bind single letters on window).
  const isTextTarget = (t) => t instanceof Element && (t.matches('textarea, input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=button])') || t.isContentEditable);
  const inOverlay = (t) => t instanceof Element && !!t.closest('.dr-fp, .dr-pop, .dr-dock, .dr-dock-fly, .dr-chat');
  window.addEventListener('keydown', (e) => {
    // ⌘↵ / ^↵ = save + send the batch, ⌥↵ = save only — from the pin popover's
    // textareas or the panel's general note. Handled HERE because this capture
    // listener stopPropagation()s overlay keystrokes before they can reach any
    // handler on the textareas themselves.
    if (chatMenuClose && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); chatMenuClose(); return; } // the conversation menu closes before anything else reacts to Esc
    if (chatLb) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); chatLb(); } return; } // the image lightbox owns the keyboard while it is up
    if (chatOpen && e.target instanceof Element && e.target.closest('.dr-chat')) {
      if (chatSlashKey && chatSlashKey(e)) return; // the "/" picker owns ↑ ↓ Enter Tab Esc while it is open
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeChat(); return; }
      if (e.key === 'Enter' && !e.shiftKey && e.target.classList.contains('dr-chat-ta')) { e.preventDefault(); e.stopPropagation(); chatSubmit(); return; }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.altKey) && isTextTarget(e.target) && inOverlay(e.target)) {
      const inPop = pop && e.target.closest('.dr-pop');
      const isGen = e.target.classList.contains('gen');
      if (inPop || isGen) {
        e.preventDefault(); e.stopPropagation();
        if (inPop && state.editing != null && state.pins[state.editing]) {
          const p = state.pins[state.editing];
          p.comment = pop.querySelector('.c').value.trim(); p.fix = pop.querySelector('.fix').value.trim(); save();
          closePop();
        }
        if (isGen) { state.general = e.target.value; save(); }
        if (e.altKey && !e.metaKey && !e.ctrlKey) { if (isGen) e.target.blur(); }
        else if (canSend()) send();
        return;
      }
    }
    // Modifier combos belong to the browser/OS — Cmd/Ctrl+R reloads, Cmd+1-9 switches
    // tabs. Every overlay shortcut is a bare key, so anything held with a modifier
    // passes straight through instead of being preventDefault()ed away.
    if (!isTextTarget(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); toggle(); }
      else if ((e.key === 'c' || e.key === 'C') && BRAND.chat) { e.preventDefault(); toggleChat(); }
      else if (e.key === 'h' || e.key === 'H') { e.preventDefault(); ovHideAll(); }
      else if (e.key === 'Escape') { if (chatOpen && !pop) closeChat(); else closePop(); }
      else if (/^[1-9]$/.test(e.key) && overlays[+e.key - 1]) { e.preventDefault(); flashChip(overlays[+e.key - 1]); cycle(overlays[+e.key - 1]); }
    }
    if (inOverlay(e.target)) e.stopPropagation();
  }, true);
  ['keypress', 'keyup'].forEach((t) => window.addEventListener(t, (e) => { if (inOverlay(e.target)) e.stopPropagation(); }, true));

  // ── overlay dock: one draggable strip with a chip per floating panel ──
  // Every overlay registers { id, name, getEl, place, setOpacity(idle, hover),
  // setHidden, setCollapsed?, setLook({ size, blur }) }. Because the review panel
  // is now a FloatingPanel twin, both overlays have the same capabilities, so the
  // hub is one uniform block per overlay — State (open / pill / hidden), Opacity,
  // On hover — plus an "all overlays" block with the global look. Settings persist
  // globally so a reviewer's setup follows them between artifacts.
  const OVKEY = 'design-review:overlays';
  const OV_DEFAULT = { opacity: 1, mode: 'open', hidden: false };
  let ovSettings = { btn: null, hoverFull: true, lookOpen: false, look: { size: 1, blur: 22 }, items: {} };
  try {
    const j = JSON.parse(localStorage.getItem(OVKEY) || '{}');
    ovSettings.btn = j.btn || null; Object.assign(ovSettings.look, j.look || {}); ovSettings.items = j.items || {}; if (j.dock) ovSettings.dock = j.dock;
    if (typeof j.hoverFull === 'boolean') ovSettings.hoverFull = j.hoverFull; if (typeof j.lookOpen === 'boolean') ovSettings.lookOpen = j.lookOpen;
    Object.values(ovSettings.items).forEach((it) => { if (it.mode === 'hidden') { it.mode = 'open'; it.hidden = true; } }); // older schema
  } catch (e) {}
  const ovSave = () => { try { localStorage.setItem(OVKEY, JSON.stringify(ovSettings)); } catch (e) {} };
  // One persistent config object per overlay — created once, defaults filled in place —
  // so a control's handler can safely hold a reference across re-renders and saves.
  const ovCfg = (id, o) => {
    const it = ovSettings.items[id] || (ovSettings.items[id] = {});
    const base = Object.assign({}, OV_DEFAULT, o && o.defaultMode ? { mode: o.defaultMode } : {});
    for (const k in base) if (!(k in it)) it[k] = base[k];
    return it;
  };
  const overlays = [];
  // dock elements are created up front so register()/renderHub() can run before the
  // dock logic below is wired
  const dock = el('div', 'dr-dock'), dockTip = el('div', 'dr-dock-tip'), dockFly = el('div', 'dr-dock-fly');
  document.body.append(dock, dockTip, dockFly);
  if (!ovSettings.dock) ovSettings.dock = { edge: 'bottom', pos: null, mini: false, opacity: 1 };
  if (ovSettings.dock.opacity == null) ovSettings.dock.opacity = 1;
  let flyOpen = false, dockReady = false;

  const ovApply = (o) => {
    const c = ovCfg(o.id, o);
    o.setOpacity(c.opacity, ovSettings.hoverFull ? 1 : c.opacity);
    o.setHidden(c.hidden);
    if (o.setCollapsed && !c.hidden) o.setCollapsed(c.mode === 'pill');
    if (o.setLook) o.setLook(ovSettings.look);
  };
  const ovApplyAll = () => overlays.forEach(ovApply);
  const ovHideAll = () => {
    const allHidden = overlays.length && overlays.every((o) => ovCfg(o.id).hidden);
    overlays.forEach((o) => { ovCfg(o.id).hidden = !allHidden; });
    ovApplyAll(); ovSave(); renderHub();
  };
  const prior = window.__overlayRegistry;
  window.__overlayRegistry = {
    register(o) {
      overlays.push(o); ovApply(o); renderHub();
      o._off = () => { const i = overlays.indexOf(o); if (i >= 0) overlays.splice(i, 1); renderHub(); };
      // Overlays must not load on top of each other. The review panel remembers where
      // it was left, but if that spot now collides with another overlay's home (the
      // tweaks panel opens top-right), it gives way and returns to its own corner.
      if (o.id !== 'review' && o.id !== 'progress') requestAnimationFrame(() => {
        const other = o.getEl && o.getEl(); if (!other || !state.panelPos) return;
        const a = panel.getBoundingClientRect(), b = other.getBoundingClientRect();
        const hit = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        if (hit) { state.panelPos = null; save(); placePanel(); }
      });
      return o._off;
    },
  };
  if (prior && Array.isArray(prior.q)) prior.q.forEach((o) => window.__overlayRegistry.register(o));

  // the review panel registers exactly like the tweaks panel does
  let pHidden = false, pHover = false, pOpacity = 1, pHoverOpacity = 1;
  const pApply = () => { panel.style.opacity = pHover ? pHoverOpacity : pOpacity; panel.style.display = pHidden || chatOpen ? 'none' : ''; popApply(); snApply(); };
  panel.addEventListener('pointerenter', () => { pHover = true; pApply(); });
  panel.addEventListener('pointerleave', () => { pHover = false; pApply(); });
  window.__overlayRegistry.register({
    id: 'review', name: BRAND.name, defaultMode: 'pill',
    getEl: () => panel,
    place: (x, y) => { state.panelPos = { x, y }; placePanel(); save(); },
    setOpacity: (idle, hov) => { pOpacity = idle; pHoverOpacity = hov; pApply(); },
    setHidden: (h) => { pHidden = h; pApply(); },
    setCollapsed: (c) => { if (c !== state.collapsed) setCollapsed(c); },
    setLook: ({ size, blur }) => { panel.style.transform = size === 1 ? '' : `scale(${size})`; panel.style.transformOrigin = state.panelPos ? 'top left' : cornerOrigin; panel.style.backdropFilter = panel.style.webkitBackdropFilter = `blur(${blur}px) saturate(150%)`; placePanel(); popApply(); },
  });
  // the progress stack is an overlay of its own: dock chip cycles Open → Pill (collapsed cards) → Hidden
  window.__overlayRegistry.register({
    id: 'progress', name: 'Progress', defaultMode: 'open',
    getEl: () => sn,
    place: (x, y) => { snUi.pos = { x, y }; snUiSave(); snPlace(); },
    setOpacity: (idle, hov) => { snOpacity = idle; snHoverOpacity = hov; snApply(); },
    setHidden: (h) => { snHidden = h; snApply(); },
    setCollapsed: (c) => { if (c !== snUi.collapsed) snSetCollapsed(c); },
    setLook: () => snApply(),
  });

  // ── the dock ──
  // ◐ handle: drag to move (drop near a side edge → vertical, elsewhere → horizontal),
  // click → collapse to a single button with a count badge. One chip per overlay:
  // click cycles Open → Pill → Hidden (Pill skipped when the overlay can't collapse),
  // drag across scrubs opacity (fill = value), ⌥-click resets to 100. Right cluster:
  // hover-full toggle · Look flyout (size / blur / dock edge / reset) · hide all.
  const EYE_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l18 18M10.6 10.6A3 3 0 0 0 13.4 13.4M6.7 6.7C4 8.5 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1M9.9 5.2A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.6 3.5"/></svg>';
  const IC_EXPAND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  const IC_COLLAPSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>';
  const IC_LOOK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>';
  const LOOK_DEFAULT = { size: 1, blur: 22, tint: '#10141a' };
  // overlay colour: any hex the reviewer picks; text/line colours are derived from its luminance
  const DARK_FG = { fg: '#eef3f7', fg2: '#aeb7c2', fg3: '#6f7783', fg3b: '#8a94a0', onBg: '#dfe6ec', onFg: '#0c1116', w: '255,255,255' };
  const LIGHT_FG = { fg: '#1d2229', fg2: '#3e4a57', fg3: '#7a8593', fg3b: '#6a7582', onBg: '#1d2229', onFg: '#ffffff', w: '0,0,0' };
  const hexRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  const applyTint = () => {
    const rgb = hexRgb(ovSettings.look.tint) || [16, 20, 26];
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    const t = lum > 0.55 ? LIGHT_FG : DARK_FG, r = document.documentElement.style;
    r.setProperty('--dr-g', rgb.join(',')); r.setProperty('--dr-w', t.w); r.setProperty('--dr-fg', t.fg); r.setProperty('--dr-fg2', t.fg2); r.setProperty('--dr-fg3', t.fg3); r.setProperty('--dr-fg3b', t.fg3b); r.setProperty('--dr-on-bg', t.onBg); r.setProperty('--dr-on-fg', t.onFg);
  };
  if (!hexRgb(ovSettings.look.tint)) ovSettings.look.tint = '#10141a';
  applyTint();
  const dk = () => ovSettings.dock;
  const isVert = () => (dk().orient ? dk().orient === 'vertical' : dk().edge !== 'bottom');

  let dockHover = false;
  const applyDockOpacity = () => { dock.style.opacity = dockHover && ovSettings.hoverFull ? 1 : dk().opacity; };
  dock.addEventListener('pointerenter', () => { dockHover = true; applyDockOpacity(); });
  dock.addEventListener('pointerleave', () => { dockHover = false; applyDockOpacity(); });
  const placeDock = () => {
    dock.classList.toggle('vert', isVert()); dock.classList.toggle('side', dk().edge !== 'bottom'); dock.classList.toggle('left', dk().edge === 'left'); dock.classList.toggle('mini', !!dk().mini);
    const p = dk().pos;
    dock.classList.toggle('placed', !!p);
    if (p) { const c = clampTo(dock, p.x, p.y); Object.assign(dock.style, { left: c.x + 'px', top: c.y + 'px', right: 'auto', bottom: 'auto' }); }
    else dock.removeAttribute('style');
    applyDockOpacity(); // after the style reset, or it would be wiped on load
    placeFly();
  };
  const placeFly = () => {
    if (!flyOpen) return;
    const d = dock.getBoundingClientRect(), W = dockFly.offsetWidth, H = dockFly.offsetHeight, G = 10;
    let x, y;
    if (isVert()) { y = d.top + d.height / 2 - H / 2; x = dk().edge === 'left' || d.left + d.width + G + W < window.innerWidth ? d.right + G : d.left - W - G; }
    else { x = d.right - W; y = d.top - H - G; if (y < 8) y = d.bottom + G; }
    x = Math.max(8, Math.min(window.innerWidth - W - 8, x)); y = Math.max(8, Math.min(window.innerHeight - H - 8, y));
    Object.assign(dockFly.style, { left: x + 'px', top: y + 'px' });
  };
  // Edge snapping is decided by where the POINTER is released, not by the dock's box:
  // the user grabs the ◐ at one end of a 400px strip, so box-based zones snap early on
  // one side and late on the other. Pointer-based zones feel the same left and right.
  const snapEdge = (px) => {
    const E = 96;
    return px < E ? 'left' : px > window.innerWidth - E ? 'right' : 'bottom';
  };
  const cycleOrder = (o) => (o.setCollapsed ? ['open', 'pill', 'hidden'] : ['open', 'hidden']);
  const chipState = (c) => (c.hidden ? 'hidden' : c.mode);
  const setChipState = (o, c, s) => { c.hidden = s === 'hidden'; if (s !== 'hidden') c.mode = s; };
  const cycle = (o) => {
    const c = ovCfg(o.id, o), ord = cycleOrder(o), next = ord[(ord.indexOf(chipState(c)) + 1) % ord.length];
    setChipState(o, c, next); ovApply(o); ovSave(); renderHub();
  };
  const flashChip = (o) => { const ch = dock.querySelector(`.chip[data-id="${o.id}"]`); if (ch) { ch.classList.add('focus'); setTimeout(() => ch.classList.remove('focus'), 400); } };

  const chip = (o) => {
    const c = ovCfg(o.id, o), st = chipState(c);
    const ch = el('div', 'chip ' + st, `<span class="fill"></span><span class="dot"></span><span class="nm"></span><span class="pct"></span>`);
    ch.dataset.id = o.id; ch.querySelector('.nm').textContent = o.name;
    ch.title = `${o.name} · ${st}${st === 'hidden' ? '' : ' · ' + Math.round(c.opacity * 100) + '%'} — click cycles, drag scrubs opacity, ⌥click resets`;
    const paint = () => {
      const op = Math.round(c.opacity * 100), s = chipState(c);
      ch.style.setProperty('--op', op + '%'); ch.className = 'chip ' + s + (ch.classList.contains('scrub') ? ' scrub' : '');
      ch.querySelector('.pct').textContent = s === 'pill' ? 'pill' : s === 'open' && op < 100 ? op : '';
    };
    paint();
    let sx = null, sop = 0, moved = false, pid = null;
    ch.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      if (e.altKey) { c.opacity = 1; ovApply(o); ovSave(); paint(); return; }
      sx = isVert() ? e.clientY : e.clientX; sop = c.opacity * 100; moved = false; pid = e.pointerId; ch.setPointerCapture(pid);
    });
    ch.addEventListener('pointermove', (e) => {
      if (sx == null) return;
      const d = (isVert() ? -(e.clientY - sx) : e.clientX - sx);
      if (!moved && Math.abs(d) < 4) return;
      moved = true; ch.classList.add('scrub');
      if (c.hidden) c.hidden = false;
      c.opacity = Math.max(5, Math.min(100, Math.round(sop + d / 1.4))) / 100; ovApply(o); paint();
      const r = ch.getBoundingClientRect();
      dockTip.style.display = 'block'; dockTip.textContent = `${Math.round(c.opacity * 100)}%`;
      dockTip.style.left = (r.left + r.width / 2) + 'px'; dockTip.style.top = (r.top - 8) + 'px';
    });
    const end = () => {
      if (sx == null) return;
      if (!moved) cycle(o); else { ovSave(); renderHub(); }
      sx = null; ch.classList.remove('scrub'); dockTip.style.display = 'none';
    };
    ch.addEventListener('pointerup', end); ch.addEventListener('pointercancel', end);
    return ch;
  };
  const icBtn = (svg, title, cls, onClick) => { const b = el('button', 'ic' + (cls ? ' ' + cls : ''), svg); b.title = title; b.onclick = (e) => { e.stopPropagation(); onClick(); }; b.addEventListener('pointerdown', (e) => e.stopPropagation()); return b; };

  function renderHub() {
    if (!dockReady) return;
    dock.innerHTML = '';
    const allHidden = overlays.length > 0 && overlays.every((o) => ovCfg(o.id, o).hidden);
    dock.classList.toggle('all-hidden', allHidden);
    const h = el('span', 'h', `◐<span class="n">${overlays.length}</span>`); h.title = 'drag to move · click to collapse'; dock.append(h);
    overlays.forEach((o) => dock.append(chip(o)));
    dock.append(el('span', 'sep'));
    const collapsible = overlays.filter((o) => o.setCollapsed);
    const allOpen = collapsible.length > 0 && collapsible.every((o) => { const c = ovCfg(o.id, o); return !c.hidden && c.mode === 'open'; });
    const allPill = collapsible.length > 0 && collapsible.every((o) => { const c = ovCfg(o.id, o); return !c.hidden && c.mode === 'pill'; });
    dock.append(
      // open all / collapse all act on every collapsible overlay (and un-hide it)
      icBtn(IC_EXPAND, 'Open all panels', allOpen ? 'on' : '', () => { collapsible.forEach((o) => { const c = ovCfg(o.id, o); c.hidden = false; c.mode = 'open'; }); ovApplyAll(); ovSave(); renderHub(); }),
      icBtn(IC_COLLAPSE, 'Collapse all to pills', allPill ? 'on' : '', () => { collapsible.forEach((o) => { const c = ovCfg(o.id, o); c.hidden = false; c.mode = 'pill'; }); ovApplyAll(); ovSave(); renderHub(); }),
      el('span', 'sep'),
      // eye = show all (undo any hidden overlay); its twin, the crossed eye, hides all.
      // The hover behaviour lives in the Look flyout — an eye icon reads as show/hide.
      icBtn(EYE_ON, 'Show all', allHidden || overlays.some((o) => ovCfg(o.id, o).hidden) ? '' : 'on', () => { overlays.forEach((o) => { ovCfg(o.id, o).hidden = false; }); ovApplyAll(); ovSave(); renderHub(); }),
      icBtn(IC_LOOK, 'Look — size, blur, dock edge', flyOpen ? 'hot' : '', () => { flyOpen = !flyOpen; renderFly(); }),
      icBtn(EYE_OFF, 'Hide all (H)', allHidden ? 'on warn' : '', ovHideAll),
    );
    placeDock(); renderFly();
  }

  const rng = (value, min, max, unit, onInput) => {
    const w = el('div', 'r'); const i = document.createElement('input'); i.type = 'range'; i.min = min; i.max = max; i.step = 1; const v = el('span', 'v');
    const paint = () => { i.style.setProperty('--p', ((i.value - min) / (max - min) * 100) + '%'); v.textContent = i.value + unit; };
    i.value = Math.round(value); paint();
    i.oninput = () => { paint(); onInput(Number(i.value)); };
    i.addEventListener('pointerdown', (e) => e.stopPropagation());
    w.append(i, v); return { w, i, v };
  };
  function renderFly() {
    dockFly.classList.toggle('on', flyOpen);
    if (!flyOpen) return;
    dockFly.innerHTML = '';
    const look = ovSettings.look;
    const dirty = () => look.size !== 1 || look.blur !== 22 || look.tint !== '#10141a' || dk().opacity !== 1 || overlays.some((o) => ovCfg(o.id, o).opacity !== 1);
    const reLook = () => { ovSave(); overlays.forEach((o) => o.setLook && o.setLook(look)); };
    const t = el('div', 't', 'Look'); const reset = el('button', dirty() ? 'hot' : '', 'reset');
    reset.onclick = () => { Object.assign(look, LOOK_DEFAULT); applyTint(); dk().opacity = 1; applyDockOpacity(); overlays.forEach((o) => { ovCfg(o.id, o).opacity = 1; }); ovApplyAll(); reLook(); renderHub(); };
    t.append(reset);
    const s = rng(look.size * 100, 60, 140, '%', (v) => { look.size = v / 100; reLook(); s.v.classList.toggle('hot', v !== 100); reset.classList.toggle('hot', dirty()); });
    s.w.prepend('Size'); s.v.classList.toggle('hot', look.size !== 1);
    const b = rng(look.blur, 0, 40, 'px', (v) => { look.blur = v; reLook(); b.v.classList.toggle('hot', v !== 22); reset.classList.toggle('hot', dirty()); });
    b.w.prepend('Blur'); b.v.classList.toggle('hot', look.blur !== 22);
    // one slider for everything: every overlay's opacity AND the dock's
    const allOp = () => { const cs = overlays.map((o2) => ovCfg(o2.id, o2).opacity).concat(dk().opacity); return cs.reduce((a, c) => a + c, 0) / cs.length; };
    const o = rng(allOp() * 100, 10, 100, '%', (v) => { dk().opacity = v / 100; overlays.forEach((o2) => { ovCfg(o2.id, o2).opacity = v / 100; }); ovApplyAll(); ovSave(); applyDockOpacity(); dock.querySelectorAll('.chip').forEach((ch) => ch.style.setProperty('--op', v + '%')); o.v.classList.toggle('hot', v !== 100); reset.classList.toggle('hot', dirty()); });
    o.w.prepend('Opacity'); o.v.classList.toggle('hot', allOp() !== 1);
    const hv = el('div', 'r dk', 'Hover'); const hseg = el('div', 'seg');
    [[true, 'Full opacity'], [false, 'Stays dim']].forEach(([v, l]) => {
      const bt = el('button', v === ovSettings.hoverFull ? 'on' : '', l);
      bt.onclick = () => { ovSettings.hoverFull = v; ovApplyAll(); ovSave(); renderHub(); };
      hseg.append(bt);
    });
    hv.append(hseg);
    const lo = el('div', 'r dk', 'Layout'); const lseg = el('div', 'seg');
    const orient = dk().orient || 'auto';
    [['horizontal', 'Horizontal'], ['vertical', 'Vertical'], ['auto', 'Auto']].forEach(([v, l]) => {
      const bt = el('button', v === orient ? 'on' : '', l); bt.title = v === 'auto' ? 'Follows the dock edge: bottom → horizontal, sides → vertical' : '';
      bt.onclick = () => { dk().orient = v === 'auto' ? null : v; ovSave(); renderHub(); };
      lseg.append(bt);
    });
    lo.append(lseg);
    const d = el('div', 'r dk', 'Dock'); const seg = el('div', 'seg');
    [['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right']].forEach(([v, l]) => {
      const bt = el('button', v === dk().edge ? 'on' : '', l);
      bt.onclick = () => { dk().edge = v; dk().pos = null; ovSave(); renderHub(); };
      seg.append(bt);
    });
    d.append(seg);
    const tr = el('div', 'r dk', 'Colour'); const tints = el('div', 'tints');
    const pick = document.createElement('input'); pick.type = 'color'; pick.value = look.tint; pick.title = 'Pick any colour';
    const hex = document.createElement('input'); hex.type = 'text'; hex.value = look.tint; hex.maxLength = 7; hex.spellcheck = false; hex.className = 'hex';
    const setTint = (h) => { if (!hexRgb(h)) return; look.tint = h.toLowerCase(); pick.value = look.tint; hex.value = look.tint; applyTint(); reLook(); reset.classList.toggle('hot', dirty()); };
    pick.oninput = () => setTint(pick.value); hex.onchange = () => setTint(hex.value.startsWith('#') ? hex.value : '#' + hex.value);
    [pick, hex].forEach((i) => i.addEventListener('pointerdown', (e) => e.stopPropagation()));
    const quick = el('div', 'quick');
    ['#10141a', '#0b162c', '#1e1024', '#0c1c16', '#f6f8fa'].forEach((h) => { const bt = el('button', h === look.tint ? 'on' : ''); bt.style.background = h; bt.title = h; bt.onclick = () => { setTint(h); renderFly(); }; quick.append(bt); });
    tints.append(pick, hex, quick); tr.append(tints);
    dockFly.append(t, s.w, b.w, o.w, hv, lo, d, tr, el('div', 'hint', '<kbd>H</kbd> hide all · <kbd>1–9</kbd> cycle chip · ⌥click = 100%'));
    placeFly();
  }

  // Collapse/expand keeps the ◐ handle where it is on screen. The dock is centred
  // by CSS until it has been dragged (transform: translateX(-50%)), so without this
  // the 36px collapsed button re-centres and jumps away from the handle the user
  // just clicked. Measure the handle, apply the width change, then set an explicit
  // pos that puts the handle back on the same pixel.
  const DOCK_ANIM = 260;
  let dockAnimT = 0;
  const noMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  const setMini = (v) => {
    const h = dock.querySelector('.h');
    const before = h && h.getBoundingClientRect();
    const from = dock.getBoundingClientRect();
    dk().mini = v;
    placeDock();
    if (h && before) {
      // Pin the handle's CENTRE, not its corner: the ◐ grows 30→36px on collapse, so
      // corner-pinning would slide the glyph 3px while the user watches it.
      const after = h.getBoundingClientRect(), d = dock.getBoundingClientRect();
      const mid = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      const b0 = mid(before), a0 = mid(after);
      dk().pos = { x: d.left + (b0.x - a0.x), y: d.top + (b0.y - a0.y) };
      placeDock();
    }
    // The handle is pinned, so animating the shell from its old size to its new one
    // reads as the strip folding into the button (and unfurling back out of it).
    if (!noMotion()) {
      const to = dock.getBoundingClientRect();
      dock.style.width = from.width + 'px'; dock.style.height = from.height + 'px';
      void dock.offsetWidth; // flush the start frame so the transition has somewhere to come from
      dock.classList.add('anim');
      dock.style.width = to.width + 'px'; dock.style.height = to.height + 'px';
      clearTimeout(dockAnimT);
      dockAnimT = setTimeout(() => { dock.classList.remove('anim'); dock.style.width = ''; dock.style.height = ''; }, DOCK_ANIM + 40);
    }
    ovSave();
  };

  // handle: drag the whole dock; drop position decides the edge; a plain click collapses
  // One decision per press (a separate `click` listener used to re-collapse the dock
  // right after the press expanded it): collapsed → any press expands; expanded → a
  // press that started on the ◐ handle collapses; presses on chips/buttons do nothing here.
  let dockDownTarget = null;
  dock.addEventListener('pointerdown', (e) => { dockDownTarget = e.target; }, true);
  dragOrClick(dock, dock, (x, y) => {
    // While dragging only the position moves. Snapping the edge live re-orients the
    // dock (Auto: row ↔ column), which changes its size, which changes the snap —
    // a flicker loop near the screen sides. The edge settles on drop instead.
    dock.classList.add('ghost'); dk().pos = { x, y }; placeDock();
  }, () => {
    if (dk().mini) { setMini(false); return; }
    if (dockDownTarget instanceof Element && dockDownTarget.closest('.h')) { flyOpen = false; setMini(true); renderHub(); }
  });
  window.addEventListener('pointerup', (e) => {
    if (!dock.classList.contains('ghost')) return;
    dock.classList.remove('ghost');
    if (dk().pos) {
      dk().edge = snapEdge(e.clientX);
      placeDock();                                   // may re-orient (Auto) …
      const c = clampTo(dock, dk().pos.x, dk().pos.y); // … so re-clamp the new box to the viewport
      dk().pos = c; placeDock();
    }
    ovSave();
  });
  document.addEventListener('pointerdown', (e) => {
    if (flyOpen && e.target instanceof Element && !e.target.closest('.dr-dock,.dr-dock-fly')) { flyOpen = false; renderHub(); }
    if (chatMenuClose && e.target instanceof Element && !e.target.closest('.dr-chat-sel')) chatMenuClose();
  }, true);
  window.addEventListener('resize', () => { placeDock(); placePanel(); snPlace(); });
  dockReady = true; renderHub();

  // ── chat drawer (pinpoint only): talk to the headless worker that owns a batch ──
  // One conversation per worker batch, streamed from GET /api/chat/:id/events (the
  // server replays the transcript, then follows the worker's stdout). The drawer takes
  // precedence over the floating panel: while it is open the panel is hidden (pApply),
  // the progress stack moves left of it (snPlace); R and the pins keep working.
  const CHATKEY = BRAND.key + ':chat';
  let chatUi = { cur: null, w: 420 };
  try { Object.assign(chatUi, JSON.parse(localStorage.getItem(CHATKEY) || '{}')); } catch (e) {}
  chatW = Math.max(340, Math.min(720, Number(chatUi.w) || 420));
  const chatSave = () => { try { localStorage.setItem(CHATKEY, JSON.stringify({ cur: chatUi.cur, w: chatW, taH: chatUi.taH, hintOpen: chatUi.hintOpen, stage: chatUi.stage })); } catch (e) {} };
  // Registered overlay like the panel and the progress stack: the dock's Look (size, blur,
  // tint via the --dr-* tokens), per-overlay opacity, hover-full and the chip's Open/Hidden
  // all apply here. Chip Hidden == drawer closed, so C / × / Esc and the chip stay in sync.
  let chatHover = false, chatOpacity = 1, chatHoverOpacity = 1, chatBlur = 22;
  const chatApply = () => {
    if (!chatEl) return;
    chatEl.style.opacity = chatHover || chatLb ? chatHoverOpacity : chatOpacity; // an open lightbox keeps the hovered look: the pointer is on the lightbox, not the drawer
    chatEl.style.backdropFilter = chatEl.style.webkitBackdropFilter = `blur(${chatBlur}px) saturate(150%)`;
    const sc = chatScale === 1 ? '' : `scale(${chatScale})`;
    chatEl.style.transform = chatOpen ? sc || 'none' : 'translateX(calc(100% + 30px)) ' + sc; // 'none' beats the stylesheet's closed-state translate at size 1
    chatEl.style.height = chatScale === 1 ? '' : (100 / chatScale) + 'vh';
    chatEl.style.width = chatW + 'px';
    snPlace();
  };
  const chatSyncCfg = (hidden) => { const c = ovCfg('chat'); if (c.hidden !== hidden) { c.hidden = hidden; ovSave(); renderHub(); } };
  const chatCss = `
  .dr-chat{position:fixed;top:0;right:0;height:100vh;width:420px;box-sizing:border-box;z-index:2147483597;display:flex;flex-direction:column;background:rgba(var(--dr-g),.85);-webkit-backdrop-filter:blur(22px) saturate(150%);backdrop-filter:blur(22px) saturate(150%);border-left:1px solid rgba(var(--dr-w),.1);box-shadow:-24px 0 70px rgba(0,0,0,.45);color:var(--dr-fg);font:13px/1.45 system-ui,-apple-system,sans-serif;transform:translateX(calc(100% + 30px));transform-origin:top right;transition:transform .22s cubic-bezier(.22,.61,.36,1),opacity .15s;pointer-events:none}
  .dr-chat.on{pointer-events:auto}
  @media (prefers-reduced-motion:reduce){.dr-chat{transition:none}}
  .dr-chat-rz{position:absolute;left:-3px;top:0;bottom:0;width:7px;cursor:ew-resize}
  .dr-chat-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 12px 12px 16px;border-bottom:1px solid rgba(var(--dr-w),.07);user-select:none}
  .dr-chat-hd b{font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--dr-fg);display:flex;align-items:center;gap:8px}
  .dr-chat-hd b .sub{color:var(--dr-fg3b);font-weight:500}
  .dr-chat-hd .r{display:flex;align-items:center;gap:6px}
  .dr-chat-bar{display:flex;gap:6px;align-items:center;padding:8px 12px;border-bottom:1px solid rgba(var(--dr-w),.07)}
  .dr-chat-sel{flex:1;min-width:0;position:relative}
  .dr-chat-sel .tg{width:100%;display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;border:1px solid rgba(var(--dr-w),.12);background:rgba(var(--dr-w),.05);color:var(--dr-fg);font:12px/1.4 ui-monospace,Menlo,monospace;cursor:pointer;text-align:left}
  .dr-chat-sel .tg:hover,.dr-chat-sel.open .tg{background:rgba(var(--dr-w),.09)}
  .dr-chat-sel .lb{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dr-chat-sel .st{flex:none;font:600 9px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--dr-fg3b)}
  .dr-chat-sel .st.working,.dr-chat-sel .st.starting{color:#ffb457}.dr-chat-sel .st.idle{color:#39d98a}.dr-chat-sel .st.error{color:#ff8a8e}
  .dr-chat-sel .chev{flex:none;display:inline-block;width:5px;height:5px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(-2px) rotate(45deg);color:var(--dr-fg3);transition:transform .22s cubic-bezier(.22,.61,.36,1)}
  .dr-chat-sel.open .chev{transform:translateY(1px) rotate(225deg)}
  .dr-chat-sel .menu{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:2;max-height:280px;overflow-y:auto;background:rgba(var(--dr-g),.97);border:1px solid rgba(var(--dr-w),.12);border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,.4);padding:4px;scrollbar-width:thin;scrollbar-color:rgba(var(--dr-w),.18) transparent}
  .dr-chat-sel .it{display:grid;grid-template-columns:12px 1fr auto;gap:8px;align-items:center;padding:6px 8px;border-radius:6px;cursor:pointer;color:var(--dr-fg);font:12px/1.4 ui-monospace,Menlo,monospace}
  .dr-chat-sel .it:hover{background:rgba(var(--dr-w),.08)}.dr-chat-sel .it.new{color:var(--dr-fg3b)}.dr-chat-sel .it.dis{opacity:.6;cursor:default}
  .dr-chat-sel .it .ck{color:#39d98a;font-size:11px;text-align:center}
  @media (prefers-reduced-motion:reduce){.dr-chat-sel .chev{transition:none}}
  .dr-chat-stop{flex:none;width:30px;height:30px;display:grid;place-items:center;border:1px solid rgba(255,90,95,.35);background:rgba(255,90,95,.1);border-radius:999px;padding:0;cursor:pointer}
  .dr-chat-stop::before{content:'';width:9px;height:9px;border-radius:2px;background:#ff8a8e}
  .dr-chat-stop:hover{background:rgba(255,90,95,.22)}
  .dr-chat-ls{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px 14px 10px;display:flex;flex-direction:column;gap:2px;background:rgba(0,0,0,.16);font:12px/1.55 ui-monospace,Menlo,SFMono-Regular,monospace;scrollbar-width:thin;scrollbar-color:rgba(var(--dr-w),.18) transparent}
  .dr-chat-ls::-webkit-scrollbar{width:8px}.dr-chat-ls::-webkit-scrollbar-thumb{background:rgba(var(--dr-w),.18);border-radius:4px}
  .dr-chat .m{flex:none;position:relative;align-self:stretch;max-width:100%;padding:2px 0 2px 18px;word-break:break-word;white-space:normal;font-size:12px}
  .dr-chat .m::before{position:absolute;left:0;top:2px;color:var(--dr-fg3);font:inherit}
  .dr-chat .m[data-at]:hover::after{content:attr(data-at);position:absolute;right:4px;top:2px;padding:1px 5px;border-radius:4px;background:rgba(var(--dr-g),.92);color:var(--dr-fg3);font:10px/1.4 ui-monospace,Menlo,monospace;pointer-events:none}
  .dr-chat .m.user[data-at]:hover::after{right:8px;top:6px}
  .dr-chat .m.user{margin:10px 0 6px;padding:6px 10px 6px 26px;border-radius:4px;background:rgba(var(--dr-w),.07);color:var(--dr-fg)}
  .dr-chat .m.user::before{content:'>';left:10px;top:6px}
  .dr-chat .m.ai{margin:6px 0;color:var(--dr-fg)}
  .dr-chat .m.ai::before{content:'⏺';color:var(--dr-fg2)}
  .dr-chat .m pre{margin:6px 0;padding:8px;border-radius:8px;background:rgba(0,0,0,.35);font:11px/1.45 ui-monospace,Menlo,monospace;overflow:hidden;max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere}
  .dr-chat .m code{font:11px ui-monospace,Menlo,monospace;background:rgba(var(--dr-w),.1);padding:1px 4px;border-radius:4px}
  .dr-chat .m .cb{position:relative}.dr-chat .m .cb pre{padding-right:58px}
  .dr-chat .m .cp{position:absolute;top:6px;right:6px;cursor:pointer;border:1px solid rgba(var(--dr-w),.14);background:rgba(var(--dr-g),.92);color:var(--dr-fg3);font:600 9px/1 ui-monospace,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase;border-radius:6px;padding:4px 6px;opacity:.55;transition:opacity .12s,color .12s}
  .dr-chat .m .cb:hover .cp,.dr-chat .m .cp:focus-visible{opacity:1}.dr-chat .m .cp.on{opacity:1;color:var(--dr-fg)}
  .dr-chat .m table{border-collapse:collapse;margin:6px 0;font-size:11px;max-width:100%}
  .dr-chat .m th,.dr-chat .m td{border:1px solid rgba(var(--dr-w),.12);padding:3px 8px;text-align:left;vertical-align:top;font-weight:400}
  .dr-chat .m th{color:var(--dr-fg2);font-weight:600;background:rgba(var(--dr-w),.05)}
  .dr-chat .m.tool{padding:1px 0 1px 18px;font-size:11px;line-height:1.5;color:var(--dr-fg3b);word-break:break-all}
  .dr-chat .m.tool::before{content:'⏺';top:1px;color:#39d98a}
  .dr-chat .m.tool.failed::before{color:#ff8a8e}
  .dr-chat .m.tool .tn{color:var(--dr-fg);font-weight:600}
  .dr-chat .m.tool.err{padding-left:34px;color:#ff8a8e}
  .dr-chat .m.tool.err::before{content:'⎿';left:18px;color:#ff8a8e}
  .dr-chat .m.status{font-size:11px;color:var(--dr-fg3b)}
  .dr-chat .m.status.err{color:#ff8a8e}
  .dr-chat .m.result{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dr-fg3);margin-bottom:6px}
  .dr-chat .m.result.err{color:#ff8a8e;text-transform:none}
  .dr-chat .m kbd{font:10px ui-monospace,Menlo,monospace;background:rgba(var(--dr-w),.08);border:1px solid rgba(var(--dr-w),.14);border-radius:4px;padding:1px 5px}
  .dr-chat-st{padding:8px 16px 4px;font:10px ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--dr-fg3b);min-height:14px}
  .dr-chat-st.working,.dr-chat-st.starting{color:#ffb457}.dr-chat-st.idle{color:#39d98a}.dr-chat-st.error,.dr-chat-st.disconnected{color:#ff8a8e}
  .dr-chat-in{position:relative;padding:10px 12px 6px;border-top:1px solid rgba(var(--dr-w),.07)}
  .dr-chat-slash{position:absolute;left:12px;right:12px;bottom:calc(100% + 4px);z-index:1;max-height:280px;overflow-y:auto;background:rgba(var(--dr-g),.97);border:1px solid rgba(var(--dr-w),.12);border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,.4);padding:4px;scrollbar-width:thin;scrollbar-color:rgba(var(--dr-w),.18) transparent}
  .dr-chat-slash .it{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:baseline;padding:6px 8px;border-radius:6px;cursor:pointer}
  .dr-chat-slash .it.on{background:rgba(var(--dr-w),.08)}
  .dr-chat-slash .it b{color:var(--dr-fg);font:600 12px/1.4 ui-monospace,Menlo,monospace;white-space:nowrap}
  .dr-chat-slash .it .d{color:var(--dr-fg3b);font:11px/1.4 system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dr-chat-slash .it .k{font:9px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--dr-fg3);font-style:normal}
  .dr-chat-slash .e{padding:6px 8px;color:var(--dr-fg3b);font:11px/1.4 system-ui,sans-serif}
  .dr-chat-grip{position:absolute;left:0;right:0;top:-6px;height:12px;cursor:ns-resize;display:flex;align-items:center;justify-content:center;touch-action:none}
  .dr-chat-grip::before{content:'';width:36px;height:3px;border-radius:2px;background:rgba(var(--dr-w),.16);transition:background .15s}
  .dr-chat-grip:hover::before,.dr-chat-grip.on::before{background:rgba(var(--dr-w),.4)}
  .dr-chat-box{display:flex;flex-direction:column;background:rgba(var(--dr-w),.05);border:1px solid rgba(var(--dr-w),.12);border-radius:12px}
  .dr-chat-box:focus-within{border-color:rgba(var(--dr-w),.3)}
  .dr-chat-tools{display:flex;align-items:center;justify-content:space-between;padding:2px 6px 6px}
  .dr-chat-ta{display:block;width:100%;box-sizing:border-box;resize:none;min-height:44px;max-height:50vh;height:72px;overflow-y:auto;background:transparent;border:0;border-radius:12px 12px 0 0;color:var(--dr-fg);padding:9px 11px 4px;font:13px/1.4 system-ui,sans-serif;scrollbar-width:thin;scrollbar-color:rgba(var(--dr-w),.18) transparent}
  .dr-chat-ta::-webkit-scrollbar{width:8px}.dr-chat-ta::-webkit-scrollbar-track{background:transparent}.dr-chat-ta::-webkit-scrollbar-thumb{background:rgba(var(--dr-w),.18);border-radius:4px}
  .dr-chat-hint{padding:2px 14px 18px;font-size:11px;color:var(--dr-fg3b);line-height:1.6}
  .dr-chat-tg{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;padding:2px 0;margin:0;color:var(--dr-fg3);font:600 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}
  .dr-chat-tg:hover{color:var(--dr-fg2)}
  .dr-chat-tg .chev{display:inline-block;width:5px;height:5px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(-2px) rotate(45deg);transition:transform .22s cubic-bezier(.22,.61,.36,1)}
  .dr-chat .off>.dr-chat-tg .chev{transform:translateY(0) rotate(-45deg)}
  .dr-chat-fold{display:grid;grid-template-rows:1fr;opacity:1;transition:grid-template-rows .22s cubic-bezier(.22,.61,.36,1),opacity .18s ease}
  .dr-chat-fold>div{overflow:hidden;min-height:0}
  .dr-chat .off>.dr-chat-fold{grid-template-rows:0fr;opacity:0}
  @media (prefers-reduced-motion:reduce){.dr-chat-fold,.dr-chat-tg .chev{transition:none}}
  .dr-chat-stage{flex:none;padding:8px 16px 16px}
  .dr-chat-stage .dr-chat-tg{color:var(--dr-fg3b)}
  .dr-chat-hint kbd{font:10px ui-monospace,Menlo,monospace;background:rgba(var(--dr-w),.08);border:1px solid rgba(var(--dr-w),.14);border-radius:4px;padding:1px 5px}
  .dr-chat-ta::placeholder{color:var(--dr-fg3b)}.dr-chat-ta:focus{outline:none}
  .dr-chat-send{flex:none;width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:999px;background:#39d98a;color:#0c1116;cursor:pointer;padding:0}
  .dr-chat-send:hover{filter:brightness(1.08)}
  .dr-chat-send:disabled{opacity:.4;cursor:not-allowed;filter:none}
  .dr-chat-send svg,.dr-chat-clip svg{width:15px;height:15px;display:block}
  .dr-chat-btn{font-size:13px}
  .dr-chat-att{flex:none;display:flex;gap:6px;flex-wrap:wrap;padding:10px 0 0}
  .dr-chat-att .a{position:relative;width:56px;height:56px;border-radius:8px;overflow:hidden;border:1px solid rgba(var(--dr-w),.15);background:rgba(0,0,0,.2)}
  .dr-chat-att img{width:100%;height:100%;object-fit:cover;display:block}
  .dr-chat-att .x{position:absolute;top:2px;right:2px;width:18px;height:18px;border:0;border-radius:99px;background:rgba(0,0,0,.65);color:#fff;font:12px/18px system-ui,sans-serif;cursor:pointer;padding:0}
  .dr-chat-clip{flex:none;width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:var(--dr-fg3b);cursor:pointer;padding:0}
  .dr-chat-clip:hover{background:rgba(var(--dr-w),.08);color:var(--dr-fg)}
  .dr-chat .m .imgs{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
  .dr-chat .m .imgs img{width:64px;height:64px;object-fit:cover;border-radius:8px;cursor:zoom-in;display:block;border:1px solid rgba(0,0,0,.15)}
  .dr-chat.drop::after{content:'Drop screenshots to attach';position:absolute;inset:8px;border:2px dashed #39d98a;border-radius:14px;background:rgba(57,217,138,.08);display:grid;place-items:center;font:600 12px ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:#39d98a;pointer-events:none}
  .dr-chat-pins{flex:none;display:flex;flex-direction:column;gap:6px;padding:10px 0 0;max-height:32vh;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(var(--dr-w),.18) transparent}
  .dr-chat-pins .it{display:flex;gap:10px;align-items:flex-start;padding:6px 10px;border-radius:10px;background:rgba(var(--dr-w),.04);border:1px solid rgba(var(--dr-w),.07);cursor:pointer}
  .dr-chat-pins .it:hover{border-color:rgba(var(--dr-w),.22)}
  .dr-chat-pins .it .n{flex:none;width:20px;height:20px;border-radius:99px;background:#ff5a5f;color:#fff;font:700 11px/20px system-ui;text-align:center}
  .dr-chat-pins .it .k{font-size:10px;color:var(--dr-fg3b);text-transform:uppercase;letter-spacing:.06em}
  .dr-chat-pins .it .c{font-size:12px;color:var(--dr-fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dr-chat-pins .it .rm{flex:none;width:20px;height:20px;border:0;border-radius:6px;background:transparent;color:var(--dr-fg3b);font:16px/20px system-ui,sans-serif;cursor:pointer;padding:0;opacity:0;align-self:center}
  .dr-chat-pins .it:hover .rm{opacity:1}.dr-chat-pins .it .rm:hover{background:rgba(255,90,95,.18);color:#ff5a5f}
  .dr-chat .m .pins{margin-top:6px;font:600 10px ui-monospace,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase;opacity:.75}
  .dr-lb{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px;box-sizing:border-box;background:rgba(0,0,0,.78);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);cursor:zoom-out;opacity:0;transition:opacity .18s ease}.dr-lb.on{opacity:1}
  .dr-lb img{max-width:100%;max-height:calc(100% - 34px);width:auto;height:auto;object-fit:contain;border-radius:10px;box-shadow:0 30px 80px rgba(0,0,0,.6);transition:transform .28s cubic-bezier(.22,.61,.36,1)}.dr-lb:not(.on) img{transform:scale(.96)}
  .dr-lb .cap{display:flex;gap:14px;align-items:center;font:11px ui-monospace,Menlo,monospace;color:rgba(255,255,255,.7);cursor:default}
  .dr-lb .cap a{color:#fff;text-decoration:none;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.12)}.dr-lb .cap a:hover{background:rgba(255,255,255,.22)}
  @media (prefers-reduced-motion:reduce){.dr-lb,.dr-lb img{transition:none}}`;
  let chatLs = null, chatTa = null, chatSel = null, chatSt = null, chatSendBtn = null, chatStopBtn = null, chatEs = null, chatConvos = [], chatPoll = null, chatAtBottom = true;
  let chatAtt = null, chatFiles = []; // pending screenshots: { name, type, data (base64), preview (data URL), w, h }
  const IMG_MAX_EDGE = 1600, IMG_MAX = 6;
  const imgsHtml = (imgs) => Array.isArray(imgs) && imgs.length ? `<div class="imgs">${imgs.map((i) => `<img src="${esc(API + i.url)}" alt="${esc(i.name || '')}" title="${esc(i.name || '')}">`).join('')}</div>` : '';
  const pinsHtml = (p) => p && p.count ? `<div class="pins">📌 ${p.count} pin${p.count === 1 ? '' : 's'} · #${p.first}${p.count > 1 ? '–#' + (p.first + p.count - 1) : ''}</div>` : '';
  function addImageFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    if (chatFiles.length >= IMG_MAX) { chatAppend({ t: 'error', text: `Up to ${IMG_MAX} screenshots per message.`, at: new Date().toISOString() }); return; }
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      // Downscale to what the model can use (long edge ≤ 1600px); PNG keeps UI text crisp, JPEG only when PNG gets heavy.
      const sc = Math.min(1, IMG_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * sc)); c.height = Math.max(1, Math.round(img.naturalHeight * sc));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      let type = 'image/png', durl = c.toDataURL(type);
      if (durl.length > 3500000) { type = 'image/jpeg'; durl = c.toDataURL(type, 0.85); }
      chatFiles.push({ name: file.name || 'screenshot.png', type, data: durl.slice(durl.indexOf(',') + 1), preview: durl, w: c.width, h: c.height });
      renderAtt();
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }
  function renderAtt() {
    if (!chatAtt) return;
    chatAtt.innerHTML = ''; chatAtt.style.display = chatFiles.length ? '' : 'none'; renderStage();
    chatFiles.forEach((f, i) => {
      const a = el('div', 'a'); const im = document.createElement('img'); im.src = f.preview; im.title = `${f.name} · ${f.w}×${f.h}`;
      const x = el('button', 'x', '×'); x.title = 'Remove'; x.onclick = () => { chatFiles.splice(i, 1); renderAtt(); };
      a.append(im, x); chatAtt.append(a);
    });
  }
  // Mirror of the panel's pin list: the panel hides while the drawer is open, so pending pins
  // show here and leave with the next message (a new worker's batch, or appended to the open one).
  function renderChatPins() {
    const box = chatEl && chatEl._pins; if (!box) return;
    box.innerHTML = ''; box.style.display = state.pins.length ? '' : 'none'; renderStage();
    if (!state.pins.length) return;
    state.pins.forEach((p, i) => {
      const it = el('div', 'it', `<span class="n">${i + 1}</span><div style="flex:1;min-width:0"><div class="k">${esc(p.type || 'note')}${p.element ? ' · ' + esc(p.element.tag) : ''}</div><div class="c">${p.comment ? esc(p.comment) : '<i style="opacity:.6">no comment yet</i>'}</div></div>`);
      const rm = el('button', 'rm', '×'); rm.title = 'Remove pin';
      rm.onclick = (e) => { e.stopPropagation(); state.pins.splice(i, 1); save(); closePop(); };
      it.append(rm); it.onclick = () => openPop(i); box.append(it);
    });
  }
  // Staging block header ("1 pin · 2 screenshots · go out with your message") and visibility.
  function renderStage() {
    const st = chatEl && chatEl._stage; if (!st) return;
    const np = state.pins.length, nf = chatFiles.length; st.style.display = np || nf ? '' : 'none';
    const parts = []; if (np) parts.push(np + ' pin' + (np === 1 ? '' : 's')); if (nf) parts.push(nf + ' screenshot' + (nf === 1 ? '' : 's'));
    st._tg.innerHTML = '<i class="chev"></i>' + parts.join(' · ') + ' · go out with your message';
  }
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function copyText(text, btn) {
    const done = () => { btn.textContent = 'copied'; btn.classList.add('on'); setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('on'); }, 1200); };
    const fallback = () => { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); try { if (document.execCommand('copy')) done(); } catch (err) {} ta.remove(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }
  // A worker may open with the project's mandated *[YYYY-MM-DD HH:MM:SS]* line; the drawer stamps every message itself, so drop it.
  const noStamp = (t) => String(t == null ? '' : t).replace(/^\s*[*_]{0,2}\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\][*_]{0,2}[ \t]*\r?\n?/, '');
  // markdown-lite: fenced code, inline code, bold, line breaks — enough for a worker's numbered reply
  // markdown-lite: fenced code, inline code, bold, pipe tables, line breaks — enough for a worker's numbered reply
  const inline = (t) => esc(t).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l || ''), cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));
  const md = (v) => String(v == null ? '' : v).split(/```/).map((part, i) => {
    if (i % 2) return `<div class="cb"><pre>${esc(part.replace(/^[a-z]*\n/, ''))}</pre><button class="cp" type="button" title="Copy to clipboard">copy</button></div>`;
    const ls = part.split('\n'), out = [];
    for (let j = 0; j < ls.length; j++) {
      if (isRow(ls[j]) && /^\s*\|?(\s*:?-+:?\s*\|)+\s*(:?-+:?\s*)?\|?\s*$/.test(ls[j + 1] || '')) { // header | separator | rows
        let h = '<table><tr>' + cells(ls[j]).map((c) => '<th>' + c + '</th>').join('') + '</tr>';
        for (j += 2; j < ls.length && isRow(ls[j]); j++) h += '<tr>' + cells(ls[j]).map((c) => '<td>' + c + '</td>').join('') + '</tr>';
        out.push(h + '</table>'); j--; continue;
      }
      out.push(inline(ls[j]));
    }
    return out.reduce((acc, x, k) => acc + (k && !x.startsWith('<table') && !out[k - 1].startsWith('<table') ? '<br>' : '') + x, '');
  }).join('');
  function chatBtn() { const b = el('button', 'dr-fp-min dr-chat-btn', '💬'); b.title = 'Chat with the worker (C)'; b.setAttribute('aria-label', 'Chat'); b.onclick = (e) => { e.stopPropagation(); toggleChat(); }; b.addEventListener('pointerdown', (e) => e.stopPropagation()); return b; }
  function buildChat() {
    if (chatEl || !BRAND.chat) return;
    const st2 = document.createElement('style'); st2.textContent = chatCss; document.head.appendChild(st2);
    chatEl = el('div', 'dr-chat'); chatEl.style.width = chatW + 'px';
    chatEl.addEventListener('pointerenter', () => { chatHover = true; chatApply(); });
    chatEl.addEventListener('pointerleave', () => { chatHover = false; chatApply(); });
    const hd = el('div', 'dr-chat-hd');
    const ttl = el('b'); ttl.append(document.createTextNode(BRAND.name), el('span', 'sub', 'chat'));
    const r = el('div', 'r');
    const ann = el('button', 'dr-ann'); const d2 = el('i', 'dr-dot'); ann.append(d2, document.createTextNode('annotate')); ann.title = 'Toggle annotate mode (R)'; ann.onclick = toggle; chatEl._dot = d2; chatEl._ann = ann;
    const nw = el('button', 'dr-fp-min', '+'); nw.title = 'New conversation — your message starts a fresh worker for this page'; nw.onclick = () => selectConvo(null);
    const x = el('button', 'dr-fp-min', '×'); x.title = 'Close chat (Esc) — the panel comes back'; x.onclick = closeChat;
    r.append(ann, nw, x); hd.append(ttl, r);
    const bar = el('div', 'dr-chat-bar');
    chatSel = el('div', 'dr-chat-sel');
    const selTg = el('button', 'tg'); selTg.type = 'button'; selTg.title = 'Switch conversation'; selTg.setAttribute('aria-haspopup', 'listbox'); selTg.setAttribute('aria-expanded', 'false');
    const selMenu = el('div', 'menu'); selMenu.setAttribute('role', 'listbox'); selMenu.style.display = 'none';
    const menuClose = () => { selMenu.style.display = 'none'; chatSel.classList.remove('open'); selTg.setAttribute('aria-expanded', 'false'); chatMenuClose = null; };
    selTg.onclick = () => { if (chatMenuClose) { chatMenuClose(); return; } selMenu.style.display = ''; chatSel.classList.add('open'); selTg.setAttribute('aria-expanded', 'true'); chatMenuClose = menuClose; };
    selMenu.addEventListener('click', (e) => { const it = e.target.closest('.it'); if (!it || it.classList.contains('dis')) return; menuClose(); selectConvo(it.dataset.id || null); });
    chatSel.append(selTg, selMenu); chatSel._tg = selTg; chatSel._menu = selMenu; selSync(); // placeholder label until the list loads
    chatStopBtn = el('button', 'dr-chat-stop'); chatStopBtn.type = 'button'; chatStopBtn.setAttribute('aria-label', 'Stop the worker'); chatStopBtn.title = 'Stop — end this worker process now (your next message resumes the same session)';
    chatStopBtn.onclick = () => { if (chatUi.cur) fetch(API + BRAND.chat + '/' + encodeURIComponent(chatUi.cur) + '/stop', { method: 'POST' }).catch(() => {}); };
    bar.append(chatSel, chatStopBtn);
    chatLs = el('div', 'dr-chat-ls'); chatLs.addEventListener('scroll', () => { chatAtBottom = chatLs.scrollHeight - chatLs.scrollTop - chatLs.clientHeight < 40; });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (chatAtBottom) chatLs.scrollTop = chatLs.scrollHeight; }).observe(chatLs); // stay pinned when the hint / textarea change the pane's height
    chatSt = el('div', 'dr-chat-st', '');
    const inp = el('div', 'dr-chat-in');
    chatTa = el('textarea', 'dr-chat-ta'); chatTa.placeholder = 'Message the worker…';
    // Fixed height, resized by dragging the divider above the box (no native grip, no auto-grow); the choice is remembered.
    if (chatUi.taH) chatTa.style.height = Math.max(44, Math.min(window.innerHeight / 2, Number(chatUi.taH))) + 'px';
    chatTa.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items; if (!items) return;
      let got = false; for (const it of items) if (it.kind === 'file' && /^image\//.test(it.type)) { addImageFile(it.getAsFile()); got = true; }
      if (got) e.preventDefault();
    });
    const fi = document.createElement('input'); fi.type = 'file'; fi.accept = 'image/*'; fi.multiple = true; fi.style.display = 'none';
    fi.onchange = () => { [...fi.files].forEach(addImageFile); fi.value = ''; };
    const ICO = { clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>', up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>' };
    const clip = el('button', 'dr-chat-clip', ICO.clip); clip.type = 'button'; clip.setAttribute('aria-label', 'Attach screenshots'); clip.title = 'Attach screenshots (or paste / drop them)'; clip.onclick = () => fi.click();
    chatSendBtn = el('button', 'dr-chat-send', ICO.up); chatSendBtn.type = 'button'; chatSendBtn.setAttribute('aria-label', 'Send'); chatSendBtn.title = 'Send (Enter)'; chatSendBtn.onclick = chatSubmit;
    const box = el('div', 'dr-chat-box'), tools = el('div', 'dr-chat-tools'); tools.append(clip, chatSendBtn); box.append(chatTa, tools);
    // "/" picker: a slash as the first character lists the skills / commands the worker can run (GET /api/skills).
    let slashItems = null, slashIdx = 0, slashRows = [];
    const slash = el('div', 'dr-chat-slash'); slash.style.display = 'none'; slash.setAttribute('role', 'listbox');
    const caret = () => chatTa.selectionStart == null ? chatTa.value.length : chatTa.selectionStart;
    const slashQuery = () => { const m = /^\/([\w-]*)$/.exec(chatTa.value.slice(0, caret())); return m ? m[1] : null; };
    const slashClose = () => { slash.style.display = 'none'; slashRows = []; };
    const slashPick = (name) => { const rest = chatTa.value.slice(caret()).replace(/^\s+/, ''); chatTa.value = '/' + name + ' ' + rest; chatTa.setSelectionRange(name.length + 2, name.length + 2); slashClose(); chatTa.focus(); };
    const slashRender = () => {
      const q = slashQuery(); if (q == null) return slashClose();
      if (!slashItems) {
        slashItems = { loading: true }; slash.innerHTML = '<div class="e">loading…</div>'; slash.style.display = '';
        fetch(API + '/api/skills').then((r) => r.ok ? r.json() : Promise.reject(r.status)).then((j) => { slashItems = j; slashRender(); }).catch((e) => { slashItems = { err: e === 404 ? 'Restart the pinpoint server to list skills.' : 'Skills unavailable.' }; slashRender(); });
        return;
      }
      if (!Array.isArray(slashItems)) { slash.innerHTML = '<div class="e">' + esc(slashItems.err || 'loading…') + '</div>'; slash.style.display = ''; slashRows = []; return; }
      const ql = q.toLowerCase(), pre = slashItems.filter((it) => it.name.toLowerCase().startsWith(ql));
      slashRows = pre.concat(slashItems.filter((it) => !pre.includes(it) && (it.name.toLowerCase().includes(ql) || (ql.length > 1 && it.description.toLowerCase().includes(ql))))).slice(0, 8);
      if (!slashRows.length) return slashClose();
      slashIdx = Math.min(slashIdx, slashRows.length - 1);
      slash.innerHTML = slashRows.map((it, i) => '<div class="it' + (i === slashIdx ? ' on' : '') + '" role="option" data-i="' + i + '"><b>/' + esc(it.name) + '</b><span class="d">' + esc(it.description) + '</span><i class="k">' + (it.kind === 'builtin' ? 'built-in' : it.scope === 'project' ? 'project' : '') + '</i></div>').join('');
      slash.style.display = ''; const on = slash.querySelector('.it.on'); if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    };
    chatTa.addEventListener('input', () => { slashIdx = 0; slashRender(); });
    chatTa.addEventListener('keyup', slashRender); chatTa.addEventListener('click', slashRender);
    chatTa.addEventListener('blur', () => setTimeout(slashClose, 150));
    slash.addEventListener('pointerdown', (e) => { e.preventDefault(); const it = e.target.closest('.it'); if (it && slashRows[+it.dataset.i]) slashPick(slashRows[+it.dataset.i].name); });
    slash.addEventListener('pointermove', (e) => { const it = e.target.closest('.it'); if (it && +it.dataset.i !== slashIdx) { slashIdx = +it.dataset.i; slashRender(); } });
    chatSlashKey = (e) => {
      if (slash.style.display === 'none' || e.target !== chatTa) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { if (!slashRows.length) return false; slashIdx = (slashIdx + (e.key === 'ArrowDown' ? 1 : slashRows.length - 1)) % slashRows.length; slashRender(); }
      else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { if (!slashRows.length) return false; slashPick(slashRows[slashIdx].name); }
      else if (e.key === 'Escape') slashClose();
      else return false;
      e.preventDefault(); e.stopPropagation(); return true;
    };
    const grip = el('div', 'dr-chat-grip'); grip.title = 'Drag to resize the message box';
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault(); grip.classList.add('on'); const y0 = e.clientY, h0 = chatTa.offsetHeight;
      const mv = (ev) => { chatTa.style.height = Math.max(44, Math.min(window.innerHeight / 2, h0 + (y0 - ev.clientY) / chatScale)) + 'px'; };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); grip.classList.remove('on'); chatUi.taH = chatTa.offsetHeight; chatSave(); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
    inp.append(grip, slash, box, fi);
    // Collapsible block: a chevron toggle + an animated fold; `key` is the chatUi field that remembers it, `open` the state before the user ever toggles it.
    const fold = (cls, key, title, open) => {
      const isOpen = chatUi[key] == null ? open : chatUi[key] !== false;
      const box = el('div', cls + (isOpen ? '' : ' off'));
      const tg = el('button', 'dr-chat-tg'); tg.type = 'button'; tg.title = title; tg.setAttribute('aria-expanded', String(isOpen));
      tg.onclick = () => { const off = box.classList.toggle('off'); tg.setAttribute('aria-expanded', String(!off)); chatUi[key] = !off; chatSave(); };
      const inner = el('div'); const fd = el('div', 'dr-chat-fold'); fd.append(inner); box.append(tg, fd); box._tg = tg; box._in = inner; return box;
    };
    const hint = fold('dr-chat-hint', 'hintOpen', 'Show / hide the shortcuts', false); hint._tg.innerHTML = '<i class="chev"></i>shortcuts';
    hint._in.innerHTML = '<kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline · paste or drop screenshots · <kbd>Esc</kbd> closes · <kbd>/</kbd> lists skills · drag the bar above the box to resize it';
    chatAtt = el('div', 'dr-chat-att'); chatAtt.style.display = 'none';
    const pinsBox = el('div', 'dr-chat-pins'); pinsBox.style.display = 'none'; chatEl._pins = pinsBox; // pending panel pins, sent with the next message
    // Staging block: the pending pins + screenshots that go out with the next message (hidden while both are empty).
    const stage = fold('dr-chat-stage', 'stage', 'Show / hide the pending pins and screenshots', true); stage.style.display = 'none'; stage._in.append(pinsBox, chatAtt); chatEl._stage = stage;
    let dragDepth = 0;
    chatEl.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dragDepth++; chatEl.classList.add('drop'); } });
    chatEl.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    chatEl.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; chatEl.classList.remove('drop'); } });
    chatEl.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; chatEl.classList.remove('drop'); if (e.dataTransfer) [...e.dataTransfer.files].forEach(addImageFile); });
    chatLs.addEventListener('click', (e) => {
      const t = e.target; if (t instanceof HTMLImageElement && t.closest('.imgs')) return openLightbox(t.src, t.alt, t.getBoundingClientRect());
      const cp = t instanceof Element ? t.closest('.cp') : null; if (cp) { const pre = cp.parentElement && cp.parentElement.querySelector('pre'); copyText(pre ? pre.textContent : '', cp); }
    });
    const rz = el('div', 'dr-chat-rz'); rz.title = 'Resize';
    rz.addEventListener('pointerdown', (e) => {
      e.preventDefault(); const sx = e.clientX, w0 = chatW;
      const mv = (ev) => { chatW = Math.max(340, Math.min(Math.min(720, window.innerWidth - 80) / chatScale, w0 + (sx - ev.clientX) / chatScale)); chatApply(); };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); chatSave(); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
    chatEl.append(rz, hd, bar, chatLs, chatSt, stage, inp, hint); document.body.appendChild(chatEl); renderChatPins(); chatApply();
  }
  // Full-screen preview of a transcript screenshot. Lives on document.body (outside the scaled drawer);
  // click anywhere or Esc closes it, the caption keeps an "open" link for the raw file.
  function openLightbox(src, name, from) {
    if (chatLb) chatLb();
    const lb = el('div', 'dr-lb');
    const img = el('img'); img.src = src; img.alt = name || '';
    lb.append(img, el('div', 'cap', `<span>${esc(name || '')}</span><a href="${esc(src)}" target="_blank" rel="noopener">open &#8599;</a>`));
    let lx = from ? from.left + from.width / 2 : -1, ly = from ? from.top + from.height / 2 : -1; // last pointer position: the thumbnail centre until the pointer moves
    lb.addEventListener('pointermove', (e) => { lx = e.clientX; ly = e.clientY; });
    const close = () => {
      if (chatLb === close) chatLb = null;
      lb.classList.remove('on'); setTimeout(() => lb.remove(), 200);
      // The drawer never saw the pointer come back (the lightbox was on top), so settle its hover state from where the pointer is now instead of idle-then-hover flicker.
      if (chatEl) { const r = chatEl.getBoundingClientRect(); chatHover = chatOpen && lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom; }
      chatApply(); if (chatOpen && chatTa) chatTa.focus({ preventScroll: true });
    };
    lb.addEventListener('click', (e) => { if (!(e.target instanceof HTMLAnchorElement)) close(); });
    chatLb = close; chatApply(); document.body.appendChild(lb);
    // FLIP: start the image at the clicked thumbnail (uniform scale about its centre), then let it glide into place.
    const grow = () => {
      const to = img.getBoundingClientRect(), ok = from && to.width && to.height;
      img.style.transition = 'none';
      img.style.transform = ok ? `translate(${from.left + from.width / 2 - (to.left + to.width / 2)}px,${from.top + from.height / 2 - (to.top + to.height / 2)}px) scale(${Math.max(from.width / to.width, from.height / to.height)})` : 'scale(.94)';
      void img.offsetWidth; // flush the start frame
      img.style.transition = ''; img.style.transform = ''; lb.classList.add('on');
    };
    if (img.complete && img.naturalWidth) grow(); else img.addEventListener('load', grow, { once: true });
  }
  const chatLine = (ev) => {
    const at = ev.at ? new Date(ev.at) : null, hh = at && !isNaN(at) ? at.toTimeString().slice(0, 8) : '';
    const n = (cls, html) => { const d = el('div', 'm ' + cls); d.innerHTML = html; if (hh) d.dataset.at = hh; return d; };
    switch (ev.t) {
      case 'batch': return n('user', md(ev.general || '') + pinsHtml(ev.pins ? { count: ev.pins, first: 1 } : null) + imgsHtml(ev.images)); // the note that started the worker reads like any later message
      case 'user': return n('user', md(ev.text) + pinsHtml(ev.pins) + imgsHtml(ev.images));
      case 'assistant': { const t = noStamp(ev.text); return t.trim() ? n('ai', md(t)) : null; }
      case 'tool': return n('tool', `<span class="tn">${esc(String(ev.name || '').replace(/^mcp__pinpoint__/, 'pinpoint:'))}</span>${ev.summary ? '(<span class="ts">' + esc(ev.summary) + '</span>)' : ''}`);
      case 'tool_error': return n('tool err', esc(ev.text));
      case 'result': return n('result' + (ev.ok ? '' : ' err'), ev.ok ? `turn done · ${Math.round((ev.ms || 0) / 1000)}s${ev.cost ? ' · $' + Number(ev.cost).toFixed(2) : ''}` : 'turn failed · ' + esc(ev.text || ev.subtype || ''));
      case 'status':
        if (ev.reset) return n('status', 'conversation cleared — the worker starts from a blank context');
        if (ev.compacted) return n('status', 'context compacted' + (ev.pre ? ' · ' + (ev.pre / 1000).toFixed(1) + 'k → ' + (ev.post / 1000).toFixed(1) + 'k tokens' : ''));
        if (ev.stopping) return n('status', 'worker stopping — ' + esc(ev.stopping));
        if (ev.state === 'starting') return n('status', ev.resume ? 'resuming the worker session…' : 'starting a worker…');
        if (ev.ready) return n('status', 'worker ready' + (ev.model ? ' · ' + esc(ev.model) : ''));
        if (ev.state === 'exited') return n('status', 'worker exited — your next message resumes it');
        if (ev.state === 'error') return n('status err', 'worker error' + (ev.text ? ' — ' + esc(ev.text) : ev.code != null ? ' (exit ' + ev.code + ')' : ''));
        return null;
      case 'stderr': return /error|fail|denied/i.test(String(ev.text)) ? n('tool err', esc(ev.text)) : null;
      case 'error': return n('status err', esc(ev.text));
      default: return null;
    }
  };
  function chatAppend(ev) {
    if (!chatLs) return; const node = chatLine(ev); if (!node) return;
    if (ev.t === 'status' && ev.reset) { chatLs.innerHTML = ''; chatAtBottom = true; } // /clear wipes the drawer transcript as well: live, and on replay so a reload stays cleared
    if (ev.t === 'tool_error') { const last = [...chatLs.querySelectorAll('.m.tool:not(.err)')].pop(); if (last) last.classList.add('failed'); } // the failed call's dot turns red
    chatLs.appendChild(node); if (chatAtBottom) chatLs.scrollTop = chatLs.scrollHeight;
  }
  function chatStatus(state, ev) {
    if (!chatSt) return;
    const map = { connecting: 'connecting…', starting: ev && ev.resume ? 'resuming worker…' : 'starting worker…', working: 'working…', idle: 'idle — your turn', exited: 'worker exited · a message resumes it', error: 'worker error', disconnected: 'stream lost — retrying' };
    chatSt.textContent = state ? map[state] || state : '';
    chatSt.className = 'dr-chat-st ' + (state || '');
    if (chatStopBtn) chatStopBtn.style.display = state === 'working' || state === 'idle' || state === 'starting' ? '' : 'none';
  }
  const convoParts = (c) => { let path = c.page; try { path = new URL(c.page).pathname; } catch (e) {} const t = new Date(c.startedAt || c.lastAt); const hh = isNaN(t) ? '' : t.toTimeString().slice(0, 5); return { lb: `${hh} ${path}`, pins: c.pins ? c.pins + ' pin' + (c.pins === 1 ? '' : 's') : 'note', st: String(c.state || '') }; };
  const convoHtml = (c) => { const p = convoParts(c); return `<span class="lb">${esc(p.lb)} &middot; ${esc(p.pins)}</span><span class="st ${esc(p.st)}">${esc(p.st)}</span>`; };
  const newConvoHtml = () => `<span class="lb">${chatConvos.length ? 'New conversation&#8230;' : 'No worker yet &#8212; type below to start one'}</span>`;
  function fillConvos() {
    if (!chatSel) return;
    const sig = JSON.stringify(chatConvos.map((c) => [c.id, c.state]));
    if (chatSel.dataset.sig !== sig) {
      chatSel.dataset.sig = sig; chatSel._menu.innerHTML = '';
      const it0 = el('div', 'it new' + (chatConvos.length ? '' : ' dis'), '<span class="ck"></span>' + newConvoHtml()); it0.dataset.id = ''; it0.setAttribute('role', 'option'); chatSel._menu.append(it0);
      chatConvos.forEach((c) => { const it = el('div', 'it', '<span class="ck"></span>' + convoHtml(c)); it.dataset.id = c.id; it.setAttribute('role', 'option'); chatSel._menu.append(it); });
    }
    selSync();
  }
  // Mirror the current conversation onto the trigger and the menu's check mark.
  function selSync() {
    if (!chatSel) return;
    const cur = chatUi.cur ? chatConvos.find((c) => c.id === chatUi.cur) : null;
    chatSel._tg.innerHTML = (cur ? convoHtml(cur) : newConvoHtml()) + '<i class="chev"></i>';
    chatSel._menu.querySelectorAll('.it').forEach((it) => { const on = (it.dataset.id || '') === (cur ? cur.id : ''); it.setAttribute('aria-selected', String(on)); it.querySelector('.ck').innerHTML = on ? '&#10003;' : ''; });
  }
  async function loadConvos() { try { const r = await fetch(API + BRAND.chat); chatConvos = r.ok ? await r.json() : []; } catch (e) { chatConvos = []; } fillConvos(); }
  function selectConvo(id) {
    if (chatEs) { chatEs.close(); chatEs = null; }
    chatUi.cur = id || null; chatSave();
    if (!chatLs) return;
    chatLs.innerHTML = ''; chatAtBottom = true; selSync();
    if (!id) { chatStatus(null); chatAppend({ t: 'error', text: '' }); chatLs.innerHTML = ''; const d = el('div', 'm status'); d.innerHTML = 'A message here starts a new worker for this page (sent as a general note). Pins you place while the drawer is open are listed above the box and go out with it.'; chatLs.append(d); return; }
    chatStatus('connecting');
    chatEs = new EventSource(API + BRAND.chat + '/' + encodeURIComponent(id) + '/events');
    chatEs.onmessage = (e) => {
      let ev; try { ev = JSON.parse(e.data); } catch (err) { return; }
      if (ev.t === 'status' || ev.t === 'sync') { chatStatus(ev.state, ev); if (ev.t === 'status') loadConvos(); }
      chatAppend(ev);
    };
    chatEs.onerror = () => chatStatus('disconnected');
  }
  async function chatSubmit() {
    if (!chatTa) return;
    const text = (chatTa.value || '').trim(), pins = state.pins.slice(); if (!text && !chatFiles.length && !pins.length) return;
    const images = chatFiles.map(({ name, type, data }) => ({ name, type, data })), keep = chatFiles; chatFiles = []; renderAtt();
    chatTa.value = ''; chatSendBtn.disabled = true;
    // Pending panel pins ride along: appended to the open conversation's batch (numbered on from its
    // originals) or, with no conversation, as the pins of the new batch. Cleared only once the server has them.
    const consumePins = () => { if (pins.length) { state.pins = []; save(); closePop(); } };
    try {
      if (chatUi.cur) {
        const r = await fetch(API + BRAND.chat + '/' + encodeURIComponent(chatUi.cur), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, images, pins }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error([j.error, j.hint].filter(Boolean).join(' — ') || String(r.status));
        if (pins.length) {
          if (Number(j.total) > 0) { consumePins(); snRetrack(chatUi.cur, Number(j.total)); }
          else chatAppend({ t: 'error', text: 'Message sent, but this pinpoint server ignored the pins — restart it (they are still listed above).', at: new Date().toISOString() });
        }
      } else {
        const body = { page: location.href, title: document.title, viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }, state: appState(), general: text || (pins.length ? '' : 'See the attached screenshot.'), pins, images, to: 'worker' };
        const r = await fetch(API + BRAND.api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error([j.error, j.hint].filter(Boolean).join(' — ') || String(r.status));
        consumePins();
        const b = { id: j.id, total: pins.length, page: location.pathname, at: Date.now() }; snBatches.push(b); snSave(); if (pins.length && snHidden) snSetHidden(false); snTrack(b);
        await loadConvos(); selectConvo(j.id);
      }
    } catch (e) { chatAppend({ t: 'error', text: 'Send failed — ' + (e && e.message ? e.message : e), at: new Date().toISOString() }); chatTa.value = text; chatFiles = keep; renderAtt(); }
    finally { chatSendBtn.disabled = false; chatTa.focus(); }
  }
  function openChat(id) {
    if (!BRAND.chat) return;
    buildChat();
    if (chatOpen) { if (id && id !== chatUi.cur) selectConvo(id); chatApply(); return; }
    void chatEl.offsetWidth; // flush the closed frame so a first open still slides in
    chatOpen = true; chatSyncCfg(false);
    chatEl.classList.add('on'); chatApply(); pApply();
    if (chatEl._dot) { chatEl._dot.classList.toggle('on', state.on); chatEl._ann.classList.toggle('on', state.on); }
    loadConvos().then(() => {
      const has = (x) => Boolean(x) && chatConvos.some((c) => c.id === x);
      const want = has(id) ? id : has(chatUi.cur) ? chatUi.cur : chatConvos[0] ? chatConvos[0].id : null; // a session-handled batch has no worker: fall back to the newest chat
      selectConvo(want);
    });
    if (chatPoll) clearInterval(chatPoll); chatPoll = setInterval(loadConvos, 15000);
    setTimeout(() => chatTa && chatTa.focus(), 60);
  }
  function closeChat() {
    if (!chatOpen) { chatSyncCfg(true); return; }
    chatOpen = false; chatSyncCfg(true);
    if (chatEl) { chatEl.classList.remove('on'); chatApply(); }
    if (chatEs) { chatEs.close(); chatEs = null; }
    if (chatPoll) { clearInterval(chatPoll); chatPoll = null; }
    pApply();
  }
  function toggleChat() { if (chatOpen) closeChat(); else openChat(); }

  buildPanel();
  render();
  if (BRAND.chat) {
    if (!ovSettings.items.chat) ovSettings.items.chat = { opacity: 1, mode: 'open', hidden: true }; // closed until first opened; remembered after that
    window.__overlayRegistry.register({
      id: 'chat', name: 'Chat', defaultMode: 'open',
      getEl: () => chatEl,
      place: () => {}, // edge-anchored, not draggable
      setOpacity: (idle, hov) => { chatOpacity = idle; chatHoverOpacity = hov; chatApply(); },
      setHidden: (h) => { if (h) closeChat(); else openChat(); },
      setLook: ({ size, blur }) => { chatScale = size || 1; chatBlur = blur; chatApply(); },
    });
  }
  dragOrClick(snHd, sn, (x2, y2) => { snUi.pos = { x: x2, y: y2 }; snUiSave(); snPlace(); }, () => snSetCollapsed(!snUi.collapsed));
  snReady = true; snApply(); snBatches.slice().forEach(snTrack); // resume progress cards for batches still in flight
  window.__designReview = { state, render };
})();
