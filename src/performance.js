'use strict';
// =============================================================================
// performance.js — the Performance tab: how the engine is doing, right now
// =============================================================================
// A tab of its own, opened from the tree's "..." menu, and not one a click in the tree lands in.
// It asks the engine every two seconds while it is on screen. Nothing is stored: the small charts
// are this tab's memory of the time it has been open, and they go with it.
// =============================================================================

const vscode = require('vscode');
const crypto = require('node:crypto');
const { fmtBytes } = require('./names');

const EVERY_MS = 2_000;
const DISK_EVERY_MS = 30_000;   // a stat per file, and a disk cache holds thousands

let current = null;

/**
 * @param {object} o
 * @param {() => any} o.engine  the engine, started if it isn't (ensureEngine); null when it can't be
 * @param {() => Promise<{cacheBytes: number, cacheLimit: number}>} o.disk  the disk cache's size and budget
 * @param {() => Promise<void>} o.restart  asks first, then restarts the engine
 */
function openPerformance({ engine, disk, restart }) {
  if (current) { current.reveal(current.viewColumn); return; }
  const panel = vscode.window.createWebviewPanel('onelakeStudioPerformance', 'OneLake Studio: Performance',
    vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  current = panel;
  const nonce = crypto.randomBytes(16).toString('base64');
  panel.webview.html = page(panel.webview, nonce);

  let last = null, diskAt = 0, diskNow = null, asking = false;
  async function tick() {
    if (asking || !panel.visible) return;
    asking = true;
    try {
      const e = engine();
      if (!e) { post({ down: 'The engine is not available here.' }); return; }
      const s = await e.stats();
      const at = Date.now();
      // Cores in use since the last look, from the CPU time the process has used.
      const cores = last && last.pid === s.process.pid && at > last.at
        ? Math.max(0, (s.process.cpuUs - last.cpuUs) / ((at - last.at) * 1000)) : null;
      last = { at, cpuUs: s.process.cpuUs, pid: s.process.pid };
      if (at - diskAt > DISK_EVERY_MS) {
        diskAt = at;
        diskNow = await disk().catch(() => diskNow);
      }
      post({ stats: view(s, cores, diskNow) });
    } catch (err) {
      post({ down: `The engine did not answer: ${(err && err.message) || err}` });
    } finally { asking = false; }
  }
  const post = msg => { try { panel.webview.postMessage(msg); } catch (_) {} };

  const timer = setInterval(tick, EVERY_MS);
  const subs = [
    panel.onDidChangeViewState(() => { if (panel.visible) tick(); }),
    panel.webview.onDidReceiveMessage(async m => {
      if (m && m.stop) {
        const e = engine();
        if (e) await e.stopStatement(String(m.stop)).catch(() => {});
        tick();
      } else if (m && m.restart) {
        await restart();
        last = null;
        tick();
      } else if (m && m.ready) tick();
    }),
  ];
  panel.onDidDispose(() => {
    clearInterval(timer);
    for (const s of subs) s.dispose();
    current = null;
  });
}

// What the page draws: numbers already said, so it holds no rules of its own.
function view(s, cores, diskNow) {
  const total = list => list.reduce((n, x) => n + Number(x), 0);
  const memoryBytes = total(s.memory.map(m => m.bytes));
  const blocks = s.files.reduce((n, f) => ({ blocks: n.blocks + f.blocks, bytes: n.bytes + Number(f.bytes),
    spilled: n.spilled + f.spilled }), { blocks: 0, bytes: 0, spilled: 0 });
  return {
    shared: s.shared,
    version: s.settings.version,
    memoryBytes, memoryText: fmtBytes(memoryBytes), limitText: s.settings.memory_limit,
    memory: s.memory.map(m => ({ tag: m.tag, text: fmtBytes(Number(m.bytes)), bytes: Number(m.bytes), spilled: Number(m.spilled) ? fmtBytes(Number(m.spilled)) : '' })),
    cores, coresText: cores == null ? '…' : cores.toFixed(1), threads: s.settings.threads,
    process: { pid: s.process.pid, uptime: uptimeText(s.process.uptimeMs), rss: fmtBytes(s.process.rss), windows: s.process.windows ?? null },
    running: s.running && s.running.map(r => ({ id: r.id, sql: r.sql, here: r.here, seconds: (r.ms / 1000).toFixed(1) })),
    blocks: { count: blocks.blocks, text: fmtBytes(blocks.bytes), spilled: blocks.spilled,
      files: s.files.slice(0, 8).map(f => ({ path: String(f.path).replace(/^.*\/(?=[^/]+\/[^/]+$)/, '…/'), blocks: f.blocks, text: fmtBytes(Number(f.bytes)) })),
      more: Math.max(0, s.files.length - 8) },
    disk: diskNow && { cache: fmtBytes(diskNow.cacheBytes), limit: diskNow.cacheLimit ? fmtBytes(diskNow.cacheLimit) : 'off' },
    spill: { files: s.temp.files, text: fmtBytes(Number(s.temp.bytes)) },
  };
}

function uptimeText(ms) {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function page(webview, nonce) {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font: 13px var(--vscode-font-family); color: var(--vscode-foreground); padding: 0.5rem 1.25rem 2rem; }
  h2 { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin: 1.4rem 0 .5rem; font-weight: 600; }
  .tiles { display: flex; gap: 2.5rem; flex-wrap: wrap; align-items: flex-end; }
  .tile b { display: block; font-size: 24px; font-weight: 500; }
  .tile span { color: var(--vscode-descriptionForeground); }
  svg { display: block; margin-top: .3rem; color: var(--vscode-charts-blue, #3794ff); }
  table { border-collapse: collapse; width: 100%; max-width: 70rem; }
  th, td { text-align: left; padding: .25rem .9rem .25rem 0; border-bottom: 1px solid var(--vscode-panel-border, #8884); vertical-align: top; }
  th { font-weight: 600; color: var(--vscode-descriptionForeground); }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  td.sql { font-family: var(--vscode-editor-font-family); white-space: pre-wrap; word-break: break-word; max-width: 48rem; }
  .bar { height: 6px; background: var(--vscode-charts-blue, #3794ff); min-width: 1px; }
  .hint { color: var(--vscode-descriptionForeground); }
  .err { color: var(--vscode-errorForeground); }
  button { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 0; padding: .15rem .6rem; cursor: pointer; border-radius: 2px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  footer { margin-top: 1.5rem; display: flex; gap: 1.5rem; align-items: center; color: var(--vscode-descriptionForeground); }
</style></head><body>
<div id="down" class="err" hidden></div>
<div id="main" hidden>
  <div class="tiles">
    <div class="tile"><b id="mem"></b><span id="memOf"></span><svg id="memChart" width="240" height="36"></svg></div>
    <div class="tile"><b id="cpu"></b><span id="cpuOf"></span><svg id="cpuChart" width="240" height="36"></svg></div>
    <div class="tile"><b id="blocks"></b><span id="blocksOf"></span></div>
    <div class="tile"><b id="disk"></b><span id="diskOf"></span></div>
  </div>
  <h2>Running now</h2><div id="running"></div>
  <h2>Memory by use</h2><table id="memory"></table>
  <h2>Files with blocks in memory</h2><div id="files"></div>
  <footer><span id="server"></span><button id="restart">Restart Engine</button></footer>
</div>
<script nonce="${nonce}">
const vs = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); e.append(...kids); return e; };
const memSeen = [], cpuSeen = [];
function spark(svg, values, max) {
  const w = +svg.getAttribute('width'), h = +svg.getAttribute('height');
  const step = w / 119;
  const pts = values.map((v, i) => (w - (values.length - 1 - i) * step).toFixed(1) + ',' + (h - 1 - Math.min(1, v / (max || 1)) * (h - 2)).toFixed(1)).join(' ');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', pts); line.setAttribute('fill', 'none'); line.setAttribute('stroke', 'currentColor'); line.setAttribute('stroke-width', '1.5');
  svg.replaceChildren(line);
}
const keep = (list, v) => { list.push(v); if (list.length > 120) list.shift(); };
function draw(s) {
  $('mem').textContent = s.memoryText;
  $('memOf').textContent = 'memory, of ' + s.limitText;
  keep(memSeen, s.memoryBytes);
  spark($('memChart'), memSeen, Math.max(...memSeen) * 1.1);
  $('cpu').textContent = s.coresText;
  $('cpuOf').textContent = 'cores in use, of ' + s.threads + (s.shared ? '' : ' (the whole extension host)');
  if (s.cores != null) { keep(cpuSeen, s.cores); spark($('cpuChart'), cpuSeen, Math.max(+s.threads, ...cpuSeen)); }
  $('blocks').textContent = s.blocks.text;
  $('blocksOf').textContent = s.blocks.count + ' blocks in memory' + (s.blocks.spilled ? ', ' + s.blocks.spilled + ' spilled' : '');
  $('disk').textContent = s.disk ? s.disk.cache : '…';
  $('diskOf').textContent = s.disk ? 'disk cache, of ' + s.disk.limit + (s.spill.files ? ' · spilling ' + s.spill.text : '') : 'disk cache';
  if (!s.running) $('running').replaceChildren(el('div', { className: 'hint', textContent: 'Only the shared engine can list these (onelakeStudio.sharedEngine).' }));
  else if (!s.running.length) $('running').replaceChildren(el('div', { className: 'hint', textContent: 'Nothing is running.' }));
  else $('running').replaceChildren(el('table', {},
    el('tr', {}, el('th', { textContent: 'Statement' }), el('th', { textContent: 'From' }), el('th', { className: 'n', textContent: 'Seconds' }), el('th')),
    ...s.running.map(r => el('tr', {},
      el('td', { className: 'sql', textContent: r.sql }),
      el('td', { textContent: r.here ? 'this window' : 'another window' }),
      el('td', { className: 'n', textContent: r.seconds }),
      el('td', {}, el('button', { textContent: 'Stop', onclick: () => vs.postMessage({ stop: r.id }) }))))));
  const top = Math.max(1, ...s.memory.map(m => m.bytes));
  $('memory').replaceChildren(...s.memory.map(m => el('tr', {},
    el('td', { textContent: m.tag }), el('td', { className: 'n', textContent: m.text }),
    el('td', { style: 'width:50%' }, el('div', { className: 'bar', style: 'width:' + (100 * m.bytes / top).toFixed(1) + '%' })),
    el('td', { className: 'hint', textContent: m.spilled ? m.spilled + ' spilled' : '' }))));
  if (!s.blocks.files.length) $('files').replaceChildren(el('div', { className: 'hint', textContent: 'No file is held in memory yet.' }));
  else $('files').replaceChildren(el('table', {},
    ...s.blocks.files.map(f => el('tr', {}, el('td', { textContent: f.path }), el('td', { className: 'n', textContent: f.blocks + ' blocks' }), el('td', { className: 'n', textContent: f.text }))),
    ...(s.blocks.more ? [el('tr', {}, el('td', { className: 'hint', textContent: 'and ' + s.blocks.more + ' more' }))] : [])));
  $('server').textContent = [s.shared ? 'Shared engine' : 'Engine in this window', s.version, 'process ' + s.process.pid, s.process.rss + ' resident',
    'up ' + s.process.uptime, ...(s.process.windows != null ? [s.process.windows + ' window' + (s.process.windows === 1 ? '' : 's')] : [])].join(' · ');
}
$('restart').onclick = () => vs.postMessage({ restart: true });
addEventListener('message', e => {
  const m = e.data;
  $('down').hidden = !m.down;
  $('down').textContent = m.down || '';
  $('main').hidden = !m.stats;
  if (m.stats) draw(m.stats);
});
vs.postMessage({ ready: true });
</script></body></html>`;
}

module.exports = { openPerformance };
