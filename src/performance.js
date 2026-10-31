'use strict';
// =============================================================================
// performance.js — the Performance tab: four live charts of the engine
// =============================================================================
// Memory, cores in use, queries per second and the disk cache. A node in the tree opens it, one per
// window. It asks every two seconds while it is on screen. Nothing is stored: the charts are this tab's
// memory of the time it has been open, and they go with it.
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
 * @param {() => Promise<{bytes: number, limit: number}>} o.disk  the disk cache's size and budget
 */
function openPerformance({ engine, disk }) {
  if (current) { current.reveal(current.viewColumn); return; }
  const panel = vscode.window.createWebviewPanel('onelakeStudioPerformance', 'OneLake Studio: Performance',
    vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  current = panel;
  panel.webview.html = page(crypto.randomBytes(16).toString('base64'));
  const post = msg => { try { panel.webview.postMessage(msg); } catch (_) {} };

  let last = null, diskAt = 0, diskNow = null, asking = false;
  async function tick() {
    if (asking || !panel.visible) return;
    asking = true;
    try {
      const e = engine();
      if (!e) { post({ down: 'The engine is not available here.' }); return; }
      const s = await e.stats();
      const at = Date.now();
      // Since the last look, from what the process has counted: a new process starts again.
      const since = last && last.pid === s.pid && at > last.at ? at - last.at : 0;
      const cores = since ? Math.max(0, (s.cpuUs - last.cpuUs) / (since * 1000)) : null;
      const qps = since ? Math.max(0, (s.statements - last.statements) * 1000 / since) : null;
      last = { at, pid: s.pid, cpuUs: s.cpuUs, statements: s.statements };
      if (at - diskAt > DISK_EVERY_MS) {
        diskAt = at;
        diskNow = await disk().catch(() => diskNow);
      }
      post({ stats: {
        memory: s.memoryBytes, memoryText: fmtBytes(s.memoryBytes), memoryOf: s.memoryLimit,
        cores, threads: Number(s.threads), qps,
        disk: diskNow ? diskNow.bytes : null, diskText: diskNow ? fmtBytes(diskNow.bytes) : null,
        diskOf: diskNow ? (diskNow.limit ? fmtBytes(diskNow.limit) : 'off') : null,
      } });
    } catch (err) {
      post({ down: `The engine did not answer: ${(err && err.message) || err}` });
    } finally { asking = false; }
  }

  const timer = setInterval(tick, EVERY_MS);
  const subs = [
    panel.onDidChangeViewState(() => { if (panel.visible) tick(); }),
    panel.webview.onDidReceiveMessage(m => { if (m && m.ready) tick(); }),
  ];
  panel.onDidDispose(() => {
    clearInterval(timer);
    for (const s of subs) s.dispose();
    current = null;
  });
}

function page(nonce) {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font: 13px var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem 1.25rem 2rem; }
  #charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr)); gap: 1.5rem 2.5rem; max-width: 90rem; }
  .now { font-size: 26px; font-weight: 500; margin-right: .5rem; }
  .what { color: var(--vscode-descriptionForeground); }
  svg { display: block; width: 100%; height: 9rem; margin-top: .4rem; color: var(--vscode-charts-blue, #3794ff); }
  svg line { stroke: var(--vscode-panel-border, #8884); stroke-width: 1; vector-effect: non-scaling-stroke; }
  svg polyline { fill: none; stroke: currentColor; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  svg polygon { fill: currentColor; opacity: .12; stroke: none; }
  .scale { display: flex; justify-content: space-between; color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: .15rem; }
  .err { color: var(--vscode-errorForeground); margin-bottom: 1rem; }
</style></head><body>
<div id="down" class="err" hidden></div>
<div id="charts"></div>
<script nonce="${nonce}">
const vs = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const POINTS = 150;   // five minutes, at one every two seconds
const W = 300, H = 100;
function chart(what) {
  const box = document.createElement('div');
  const now = box.appendChild(document.createElement('span')); now.className = 'now'; now.textContent = '…';
  const label = box.appendChild(document.createElement('span')); label.className = 'what'; label.textContent = what;
  const svg = box.appendChild(document.createElementNS(SVG, 'svg'));
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('preserveAspectRatio', 'none');
  for (const y of [0, H / 2, H]) {
    const l = svg.appendChild(document.createElementNS(SVG, 'line'));
    l.setAttribute('x1', 0); l.setAttribute('x2', W); l.setAttribute('y1', y); l.setAttribute('y2', y);
  }
  const area = svg.appendChild(document.createElementNS(SVG, 'polygon'));
  const line = svg.appendChild(document.createElementNS(SVG, 'polyline'));
  const scale = box.appendChild(document.createElement('div')); scale.className = 'scale';
  const age = scale.appendChild(document.createElement('span')); age.textContent = '5 min ago';
  const top = scale.appendChild(document.createElement('span'));
  $('charts').append(box);
  const seen = [];
  return {
    push(value, text, of, max, topText) {
      if (text != null) now.textContent = text;
      label.textContent = what + (of ? ' of ' + of : '');
      if (value != null) { seen.push(value); if (seen.length > POINTS) seen.shift(); }
      const most = Math.max(max || 0, ...seen, 1e-9);
      top.textContent = 'top of chart: ' + (topText ? topText(most) : most);
      const x = i => (W - (seen.length - 1 - i) * W / (POINTS - 1)).toFixed(1);
      const y = v => (H - (v / most) * (H - 2)).toFixed(1);
      const pts = seen.map((v, i) => x(i) + ',' + y(v)).join(' ');
      line.setAttribute('points', pts);
      area.setAttribute('points', seen.length ? x(0) + ',' + H + ' ' + pts + ' ' + W + ',' + H : '');
    },
  };
}
const bytes = n => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + ' ' + u[i]; };
const memory = chart('memory');
const cores = chart('cores in use');
const queries = chart('queries per second');
const disk = chart('disk cache');
addEventListener('message', e => {
  const m = e.data;
  $('down').hidden = !m.down;
  $('down').textContent = m.down || '';
  if (!m.stats) return;
  const s = m.stats;
  memory.push(s.memory, s.memoryText, s.memoryOf, 0, bytes);
  cores.push(s.cores, s.cores == null ? null : s.cores.toFixed(1), String(s.threads), s.threads, n => n.toFixed(0));
  queries.push(s.qps, s.qps == null ? null : s.qps.toFixed(s.qps < 10 ? 1 : 0), '', 1, n => n.toFixed(1));
  disk.push(s.disk, s.diskText, s.diskOf, 0, bytes);
});
vs.postMessage({ ready: true });
</script></body></html>`;
}

module.exports = { openPerformance };
