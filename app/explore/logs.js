// =============================================================================
// explore/logs.js — the Logs page: in-memory timings (perflog.js), newest first; a click on a
// column header sorts by it (numbers largest first, text A-Z), a second click reverses
// =============================================================================
// A query written over the model is shown with the SQL it became under it. This session only
// (perflog.js); the one way out is the Copy button. The same file in the panel and in Export
// to Fabric's app: mountLogs(root) builds the page in `root`, and redraws it on new events
// while it is shown (one render per animation frame).
// Ported from analytics-as-code's Logs tab (frontend/logs.js), which now takes it from here.
// =============================================================================

import { perf, BUILD } from './perflog.js';

// The table's columns, in header order: the event field each one sorts on.
const COLS = ['at', 'kind', 'what', 'range', 'status', 'bytes', 'wait', 'ms'];
const HEADS = ['At (s)', 'Kind', 'What', 'Range', 'Status', 'KB', 'Wait (ms)', 'Run (ms)'];
const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// `note`: a line under the buttons, the host's to say (where the events come from).
export function mountLogs(root, { note = 'This session only — kept in memory, nothing is stored.' } = {}) {
  const pageStart = performance.timeOrigin;
  let frame = 0, sort = { col: 'at', desc: true };
  root.innerHTML = `<div class="explore-controls">
      <button class="btn-explore" type="button" data-act="copy">Copy</button>
      <button class="btn-explore" type="button" data-act="clear">Clear</button>
      <span class="explore-info">${esc(note)}</span></div>
    <pre class="logs-summary"></pre>
    <div class="explore-table-wrap"><table class="explore-table logs-table"><thead><tr>${HEADS.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody></tbody></table></div>`;
  const summary = root.querySelector('.logs-summary');
  const table = root.querySelector('.logs-table');

  function render() {
    frame = 0;
    if (!root.isConnected || root.closest('[hidden]')) return;
    const ev = perf.events;
    const of = k => ev.filter(e => e.kind === k);
    const http = of('http'), reads = http.filter(e => e.range);
    const ms = a => a.reduce((s, e) => s + (e.ms || 0), 0);
    const waits = a => a.reduce((s, e) => s + (e.wait || 0), 0);
    const kb = a => a.reduce((s, e) => s + (e.bytes || 0), 0) / 1024;
    const pct = (a, p) => { const v = a.map(e => e.ms).sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : 0; };
    const fetches = of('fetch'), sas = of('sas');
    // The seek and SAS lines only where there are any: a host that reads its files natively
    // traces no worker requests, and only the Fabric app signs.
    summary.textContent = [
      `build         : ${BUILD.startsWith('__') ? 'not stamped (OneLake Studio)' : BUILD}`,
      `files         : ${fetches.length} fetched  (${(ms(fetches) / 1000).toFixed(1)} s)    ATTACH: ${ms(of('attach')).toFixed(0)} ms`,
      `queries       : ${of('query').length}  (run ${(ms(of('query')) / 1000).toFixed(1)} s, waiting ${(waits(of('query')) / 1000).toFixed(1)} s, summed)    skipped: ${of('skip').length}    errors: ${of('error').length}`,
      ...(http.length ? [`worker HTTP   : ${http.length}  (Range reads/seeks: ${reads.length})   ${(kb(http) / 1024).toFixed(1)} MB`] : []),
      ...(reads.length ? [`seek latency  : avg ${(ms(reads) / reads.length).toFixed(0)} ms   p50 ${pct(reads, 0.5).toFixed(0)} ms   p95 ${pct(reads, 0.95).toFixed(0)} ms   max ${pct(reads, 1).toFixed(0)} ms   sum ${(ms(reads) / 1000).toFixed(1)} s`] : []),
      ...(sas.length ? [`SAS calls     : ${sas.length}  (${ms(sas).toFixed(0)} ms)`] : []),
    ].join('\n');
    const { col, desc } = sort;
    // Empty cells last, whichever the direction.
    const rows = ev.filter(e => e[col] != null && e[col] !== '').sort((a, b) => {
      const x = a[col], y = b[col];
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return desc ? -c : c;
    }).concat(ev.filter(e => e[col] == null || e[col] === ''));
    table.querySelectorAll('thead th').forEach((th, i) => {
      th.style.cursor = 'pointer';
      th.textContent = HEADS[i] + (COLS[i] === col ? (desc ? ' ▼' : ' ▲') : '');
    });
    const what = e => e.dax ? `<div>${esc(e.dax)}</div><div class="logs-sql">${esc(e.what)}</div>` : esc(e.what);
    table.tBodies[0].innerHTML = rows.map(e =>
      `<tr><td>${((e.at - pageStart) / 1000).toFixed(2)}</td><td>${e.kind}</td><td>${what(e)}</td>` +
      `<td>${esc(e.range || '')}</td><td>${esc(e.status ?? '')}</td>` +
      `<td>${e.bytes == null ? '' : (e.bytes / 1024).toFixed(0)}</td><td>${e.wait == null ? '' : e.wait.toFixed(0)}</td>` +
      `<td>${e.ms == null ? '' : e.ms.toFixed(0)}</td></tr>`).join('');
  }

  const off = perf.onChange(() => { frame ||= requestAnimationFrame(render); });
  root.querySelector('[data-act="clear"]').onclick = () => perf.clear();
  table.tHead.onclick = e => {
    const c = COLS[e.target.closest('th')?.cellIndex];
    if (!c) return;
    // A new column starts largest first for numbers (time, KB, wait, ms), A-Z for text.
    sort = c === sort.col ? { col: c, desc: !sort.desc } : { col: c, desc: ['at', 'bytes', 'wait', 'ms'].includes(c) };
    render();
  };
  // Copy: summary + table as TSV (pastes cleanly into chat or a spreadsheet). A query and its
  // SQL stay in one cell: "<query>  =>  <SQL>".
  root.querySelector('[data-act="copy"]').onclick = async e => {
    const cell = c => c.children.length ? [...c.children].map(d => d.textContent).join('  =>  ') : c.textContent;
    const rows = [...table.rows].map(tr => [...tr.cells].map(cell).join('\t'));
    const text = summary.textContent + '\n' + rows.join('\n');
    const btn = e.currentTarget;
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
    catch {
      // A Fabric iframe (or a webview) may deny the Clipboard API: a selected textarea instead.
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      btn.textContent = document.execCommand('copy') ? 'Copied' : 'Copy failed';
      ta.remove();
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  };
  render();
  return { render, destroy: () => { off(); cancelAnimationFrame(frame); } };
}

perf.log('info', `build ${BUILD}`);
