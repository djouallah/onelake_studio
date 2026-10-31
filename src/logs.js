'use strict';
// =============================================================================
// logs.js — the Logs tab: what the engine ran, from every tab and window
// =============================================================================
// A node in the tree opens it, one per window, and a click in the tree never lands in it. All it shows
// comes from the server (enginelog.js). It asks every few seconds while it is on screen, not at all
// otherwise, and the question goes over the control pipe, so reading the log adds nothing to it.
// =============================================================================

const vscode = require('vscode');
const crypto = require('node:crypto');

const EVERY_MS = 3_000;
const SHOWN = 1_000;

let current = null;

/**
 * @param {object} o
 * @param {() => any} o.engine  the engine, started if it isn't (ensureEngine); null when it can't be
 * @param {(sql: string) => void} o.open  a new tab with this SQL in its box, not run
 * @param {(sql: string) => void} o.copy
 * @param {() => Promise<void>} o.clear  asks first
 */
function openLogs({ engine, open, copy, clear }) {
  if (current) { current.reveal(current.viewColumn); return; }
  const panel = vscode.window.createWebviewPanel('onelakeStudioLogs', 'OneLake Studio: Logs',
    vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  current = panel;
  panel.webview.html = page(crypto.randomBytes(16).toString('base64'));
  const post = msg => { try { panel.webview.postMessage(msg); } catch (_) {} };

  let asking = false, said = '';
  async function tick() {
    if (asking || !panel.visible) return;
    asking = true;
    try {
      const e = engine();
      if (!e) { post({ down: 'The engine is not available here.' }); return; }
      const rows = await e.logs(SHOWN);
      // Redrawn only when something changed, so a scrolled or expanded table stays as it is.
      const now = `${rows.length}|${rows[0] ? `${rows[0].at}|${rows[0].ms}` : ''}`;
      if (now !== said) { said = now; post({ rows, shown: SHOWN }); }
      else post({ down: null });
    } catch (err) {
      said = '';
      post({ down: `The engine did not answer: ${(err && err.message) || err}` });
    } finally { asking = false; }
  }

  const timer = setInterval(tick, EVERY_MS);
  const subs = [
    panel.onDidChangeViewState(() => { if (panel.visible) tick(); }),
    panel.webview.onDidReceiveMessage(async m => {
      if (!m) return;
      if (m.ready) { said = ''; tick(); }
      else if (m.open != null) open(String(m.open));
      else if (m.copy != null) copy(String(m.copy));
      else if (m.clear) { await clear(); said = ''; tick(); }
    }),
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
  body { font: 13px var(--vscode-font-family); color: var(--vscode-foreground); padding: .75rem 1.25rem 2rem; }
  .bar { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; margin-bottom: .75rem; }
  .summary b { font-weight: 600; }
  input[type=text] { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: .2rem .5rem; width: 18rem; }
  label { color: var(--vscode-descriptionForeground); user-select: none; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .25rem .9rem .25rem 0; border-bottom: 1px solid var(--vscode-panel-border, #8884); vertical-align: top; white-space: nowrap; }
  th { font-weight: 600; color: var(--vscode-descriptionForeground); cursor: pointer; user-select: none; position: sticky; top: 0; background: var(--vscode-editor-background); }
  th:hover { color: var(--vscode-foreground); }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  td.sql { font-family: var(--vscode-editor-font-family); width: 100%; white-space: normal; word-break: break-word; cursor: pointer; }
  td.sql .one { display: block; max-height: 1.4em; overflow: hidden; }
  tr.open td.sql .one { max-height: none; white-space: pre-wrap; }
  .error { color: var(--vscode-errorForeground); font-family: var(--vscode-editor-font-family); white-space: pre-wrap; margin-top: .25rem; }
  .s-error { color: var(--vscode-errorForeground); }
  .s-stopped { color: var(--vscode-descriptionForeground); }
  button { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 0; padding: .1rem .55rem; cursor: pointer; border-radius: 2px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .hint { color: var(--vscode-descriptionForeground); }
  #clear { margin-left: auto; }
</style></head><body>
<div id="down" class="s-error" hidden></div>
<div class="bar">
  <span id="summary" class="summary"></span>
  <input id="filter" type="text" placeholder="Filter statements" aria-label="Filter statements">
  <label><input id="errors" type="checkbox"> Errors only</label>
  <label><input id="setup" type="checkbox"> Show setup</label>
  <button id="clear">Clear</button>
</div>
<div id="list"></div>
<script nonce="${nonce}">
const vs = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); e.append(...kids); return e; };
const COLS = [['at', 'When'], ['status', 'Status'], ['ms', 'ms', 'n'], ['here', 'From'], ['sql', 'Statement']];
let rows = [], shown = 0, sort = { col: 'at', desc: true };
const open = new Set();
const when = at => {
  const d = new Date(at), today = new Date().toDateString() === d.toDateString();
  return (today ? '' : d.toLocaleDateString() + ' ') + d.toLocaleTimeString();
};
function visible() {
  const text = $('filter').value.trim().toLowerCase();
  return rows.filter(r => ($('setup').checked || !r.setup)
    && (!$('errors').checked || r.status === 'error')
    && (!text || r.sql.toLowerCase().includes(text) || (r.error || '').toLowerCase().includes(text)));
}
function draw() {
  const list = visible();
  const sign = sort.desc ? -1 : 1;
  list.sort((a, b) => { const x = a[sort.col], y = b[sort.col]; return (x < y ? -1 : x > y ? 1 : 0) * sign || b.at - a.at; });
  const asked = rows.filter(r => !r.setup);
  const failed = asked.filter(r => r.status === 'error').length;
  const slowest = asked.reduce((n, r) => Math.max(n, r.ms), 0);
  $('summary').replaceChildren(
    el('b', { textContent: String(asked.length) }), rows.length === shown ? ' of the latest · ' : ' statements · ',
    el('b', { textContent: String(failed) }), ' failed · slowest ', el('b', { textContent: slowest >= 1000 ? (slowest / 1000).toFixed(1) + ' s' : slowest + ' ms' }));
  if (!list.length) {
    $('list').replaceChildren(el('div', { className: 'hint', textContent: rows.length ? 'Nothing matches.' : 'Nothing has run yet.' }));
    return;
  }
  $('list').replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, ...COLS.map(([col, label, cls]) => el('th', {
      className: cls || '', textContent: label + (sort.col === col ? (sort.desc ? ' ▾' : ' ▴') : ''),
      onclick: () => { sort = { col, desc: sort.col === col ? !sort.desc : col === 'at' || col === 'ms' }; draw(); } })), el('th'))),
    el('tbody', {}, ...list.map(r => {
      const key = r.at + r.sql;
      const sql = el('td', { className: 'sql', title: 'Click to see all of it' }, el('span', { className: 'one', textContent: r.sql }));
      if (r.error) sql.append(el('div', { className: 'error', hidden: !open.has(key), textContent: r.error }));
      const tr = el('tr', { className: open.has(key) ? 'open' : '' },
        el('td', { textContent: when(r.at) }),
        el('td', { className: 's-' + r.status, textContent: r.status }),
        el('td', { className: 'n', textContent: r.ms.toLocaleString() }),
        el('td', { textContent: r.here ? 'this window' : 'another window' }),
        sql,
        el('td', {},
          el('button', { textContent: 'Open', title: 'A new tab with this SQL in its box, not run', onclick: () => vs.postMessage({ open: r.sql }) }), ' ',
          el('button', { textContent: 'Copy', onclick: () => vs.postMessage({ copy: r.sql }) })));
      sql.onclick = () => { if (open.has(key)) open.delete(key); else open.add(key); draw(); };
      return tr;
    }))));
}
$('filter').oninput = draw;
$('errors').onchange = draw;
$('setup').onchange = draw;
$('clear').onclick = () => vs.postMessage({ clear: true });
addEventListener('message', e => {
  const m = e.data;
  $('down').hidden = !m.down;
  $('down').textContent = m.down || '';
  if (m.rows) { rows = m.rows; shown = m.shown; draw(); }
});
vs.postMessage({ ready: true });
</script></body></html>`;
}

module.exports = { openLogs };
