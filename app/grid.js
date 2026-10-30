// =============================================================================
// grid.js — a query's rows in the panel: every row scrolls, cells select and copy
// =============================================================================
// Only the rows in view are in the DOM (a spacer above and below stands in for the rest), so a
// result of 200,000 rows scrolls as one of 20. On top of that:
//   - a click selects a cell, Shift+click (or Shift+arrows) a range, a row number its row,
//     the corner every cell; Ctrl+A everything, Ctrl+C copies the selection as TSV
//   - the webview's context menu (package.json webview/context) copies it with its headers,
//     or as CSV, Markdown or JSON: the host asks (copy), the grid answers with the text
//   - a double click opens the cell in the inspector: long text whole, JSON indented
//   - a header click sorts by that column: ascending, descending, then the query's order
//   - the filter box keeps the rows holding its text, in any column
// =============================================================================

import { escapeHtml, toCsv } from './paths.js';

const NUMERIC_TYPE = /^(U?(TINY|SMALL|BIG|HUGE)INT|U?INTEGER|DOUBLE|FLOAT|DECIMAL)/;
const OVERSCAN = 20;   // rows drawn above and below what is in view

// A cell as text: what the grid shows, and what every copy writes.
export function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// `rows` (objects) and `fields` as text in one of the copy formats.
export function formatRows(fields, rows, as) {
  const text = r => fields.map(f => cellText(r[f]));
  const tsvCell = t => t.replace(/[\t\r\n]+/g, ' ');
  if (as === 'tsv') return rows.map(r => text(r).map(tsvCell).join('\t')).join('\r\n');
  if (as === 'tsv-headers') return [fields.map(tsvCell).join('\t'), ...rows.map(r => text(r).map(tsvCell).join('\t'))].join('\r\n');
  if (as === 'csv') return toCsv(fields, rows, { text: cellText });
  if (as === 'json') return JSON.stringify(rows.map(r => Object.fromEntries(fields.map(f => [f, r[f] === undefined ? null : r[f]]))), null, 2);
  if (as === 'markdown') {
    const md = t => t.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
    return [`| ${fields.map(md).join(' | ')} |`, `|${fields.map(() => ' --- |').join('')}`,
            ...rows.map(r => `| ${text(r).map(md).join(' | ')} |`)].join('\n');
  }
  throw new Error(`no copy format ${as}`);
}

// A result's rows sorted by one column: numbers as numbers (a big integer arrives as text),
// everything else as text with its digits compared as numbers. Empty cells are last either way.
const textOrder = new Intl.Collator(undefined, { numeric: true });
export function sortedRows(rows, res, { col, desc }) {
  const f = res.fields[col];
  const numeric = NUMERIC_TYPE.test((res.types || [])[col] || '');
  const key = v => (typeof v === 'number' ? v : numeric && !Number.isNaN(Number(v)) ? Number(v) : cellText(v));
  // Each row's key once, not once per comparison: 200k rows are millions of comparisons.
  const filled = [], empty = [];
  for (const r of rows) {
    if (r[f] == null || r[f] === '') empty.push(r);
    else filled.push({ r, k: key(r[f]) });
  }
  filled.sort((a, b) => {
    const x = a.k, y = b.k;
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : textOrder.compare(String(x), String(y));
    return desc ? -c : c;
  });
  return filled.map(e => e.r).concat(empty);
}

// The inspector's text for a value: JSON indented (a struct, a list, or text that is JSON),
// anything else as it is.
export function inspectText(v) {
  if (v != null && typeof v === 'object') return JSON.stringify(v, null, 2);
  const t = cellText(v);
  if (/^\s*[[{]/.test(t)) { try { return JSON.stringify(JSON.parse(t), null, 2); } catch (_) { /* not JSON */ } }
  return t;
}

/**
 * Draws `res` ({ fields, types, rows }) in `table`, scrolled by `wrap`. `res.rows` is sorted in
 * place, so whatever saves the result (the CSV) saves it in the order on screen.
 * `ui`: { filter (input), count (element), inspector: { root, title, body, copy, close } },
 * `copyText(text)` puts text on the clipboard, `say(text)` a line in the status bar.
 * Returns { copy(as), text(as), destroy() }.
 */
export function mountGrid(table, wrap, res, { ui, copyText, say = () => {} }) {
  const fields = res.fields, types = res.types || [];
  const original = res.rows.slice();
  let sort = null;                    // { col, desc }
  let view = res.rows;                // the rows on screen: res.rows, filtered
  let filterText = '';
  let anchor = null, focus = null;    // { r, c } in `view`; c -1 is the row number column
  let rowH = 0, start = -1, end = -1;
  // Where the first row starts, in the scrolled content: below whatever sits above the table
  // (the tabs, the filter) and its header.
  const rowsTop = () => table.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop +
                        (table.tHead ? table.tHead.offsetHeight : 0);

  const head = () => '<thead><tr><th class="rn" title="Select every cell">#</th>' + fields.map((f, i) => {
    const t = types[i] || '';
    const by = sort && sort.col === i;
    return `<th class="${NUMERIC_TYPE.test(t) ? 'num' : ''}" title="${escapeHtml(f + ' ' + t)} — click to sort"` +
      (by ? ` aria-sort="${sort.desc ? 'descending' : 'ascending'}"` : '') + '>' +
      `<span class="cname">${escapeHtml(f)}${by ? (sort.desc ? ' ▼' : ' ▲') : ''}</span>` +
      `<span class="ctype">${escapeHtml(t)}</span></th>`;
  }).join('') + '</tr></thead>';

  const range = () => {
    if (!anchor || !focus) return null;
    const c0 = Math.min(anchor.c, focus.c), c1 = Math.max(anchor.c, focus.c);
    // A row number in the selection stands for every column of its rows.
    const whole = c0 < 0;
    return { r0: Math.min(anchor.r, focus.r), r1: Math.max(anchor.r, focus.r),
             c0: whole ? 0 : c0, c1: whole ? fields.length - 1 : c1 };
  };
  const selected = (r, c) => { const g = range(); return !!g && r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1; };

  // The rows in view, and the spacers that stand for the rest.
  function paint(force = false) {
    const body = table.tBodies[0];
    const h = rowH || 24;
    const top = Math.max(0, wrap.scrollTop - rowsTop());
    const s = Math.max(0, Math.floor(top / h) - OVERSCAN);
    const e = Math.min(view.length, Math.ceil((top + wrap.clientHeight) / h) + OVERSCAN);
    if (!force && s === start && e === end) return;
    start = s; end = e;
    const g = range();
    let html = `<tr class="spacer" style="height:${s * h}px"><td colspan="${fields.length + 1}"></td></tr>`;
    for (let r = s; r < e; r++) {
      const row = view[r];
      // A row's number is marked while any of its cells is selected.
      const inRows = !!g && r >= g.r0 && r <= g.r1;
      html += `<tr data-r="${r}" class="${r % 2 ? 'odd' : ''}"><td class="rn${inRows ? ' sel' : ''}">${r + 1}</td>`;
      for (let c = 0; c < fields.length; c++) {
        const v = row[fields[c]];
        const cls = (typeof v === 'number' ? 'num' : '') + (selected(r, c) ? ' sel' : '');
        html += `<td data-c="${c}" class="${cls}">${escapeHtml(cellText(v))}</td>`;
      }
      html += '</tr>';
    }
    html += `<tr class="spacer" style="height:${(view.length - e) * h}px"><td colspan="${fields.length + 1}"></td></tr>`;
    body.innerHTML = html;
    if (!rowH) {
      const tr = body.querySelector('tr[data-r]');
      if (tr && tr.offsetHeight) { rowH = tr.offsetHeight; paint(true); }
    }
  }

  function draw() {
    table.innerHTML = head() + '<tbody></tbody>';
    start = end = -1;
    paint(true);
    ui.count.textContent = view.length === res.rows.length
      ? `${res.rows.length.toLocaleString('en')} row(s)`
      : `${view.length.toLocaleString('en')} of ${res.rows.length.toLocaleString('en')} row(s)`;
  }

  function refilter() {
    const q = filterText.trim().toLowerCase();
    view = !q ? res.rows : res.rows.filter(r => fields.some(f => cellText(r[f]).toLowerCase().includes(q)));
    anchor = focus = null;
    wrap.scrollTop = 0;
    draw();
  }

  // The selection's rows and columns (everything, with no selection).
  function selection() {
    const g = range();
    if (!g) return { cols: fields, rows: view };
    return { cols: fields.slice(g.c0, g.c1 + 1), rows: view.slice(g.r0, g.r1 + 1) };
  }
  function copy(as = 'tsv') {
    const { cols, rows } = selection();
    if (!rows.length) return;
    copyText(formatRows(cols, rows, as));
    say(`Copied ${rows.length.toLocaleString('en')} row(s) × ${cols.length} column(s)${as.startsWith('tsv') ? '' : ` as ${as.toUpperCase()}`}.`);
  }
  // The selection (everything, with none) as text, for a document of its own.
  const text = as => { const { cols, rows } = selection(); return formatRows(cols, rows, as); };

  function inspect(r, c) {
    const v = view[r] && view[r][fields[c]];
    const { root, title, body } = ui.inspector;
    title.textContent = `${fields[c]} · row ${r + 1}`;
    body.textContent = inspectText(v);
    root.hidden = false;
    ui.inspector.copy.onclick = () => { copyText(body.textContent); say(`Copied ${fields[c]}.`); };
  }
  const closeInspector = () => { ui.inspector.root.hidden = true; };
  ui.inspector.close.onclick = closeInspector;

  const cellAt = el => {
    const td = el.closest('td');
    const tr = td && td.closest('tr[data-r]');
    if (!tr) return null;
    return { r: Number(tr.dataset.r), c: td.classList.contains('rn') ? -1 : Number(td.dataset.c) };
  };
  function select(at, extend) {
    if (extend && anchor) focus = at;
    else { anchor = at; focus = at; }
    paint(true);
  }
  // Scrolls so row r is in view.
  function reveal(r) {
    const h = rowH || 24, headH = table.tHead ? table.tHead.offsetHeight : 0;
    const top = rowsTop() + r * h, bottom = top + h;
    if (top - headH < wrap.scrollTop) wrap.scrollTop = top - headH;
    else if (bottom > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = bottom - wrap.clientHeight;
  }

  table.onclick = e => {
    const th = e.target.closest('thead th');
    if (th) {
      if (th.classList.contains('rn')) { anchor = { r: 0, c: -1 }; focus = { r: view.length - 1, c: -1 }; paint(true); return; }
      const col = th.cellIndex - 1;
      sort = !sort || sort.col !== col ? { col, desc: false } : !sort.desc ? { col, desc: true } : null;
      // In place, so the CSV (the page's lastResult) follows; one row at a time, as 200k rows
      // will not spread.
      const next = sort ? sortedRows(original, res, sort) : original;
      for (let i = 0; i < next.length; i++) res.rows[i] = next[i];
      refilter();
      return;
    }
    const at = cellAt(e.target);
    if (at) { wrap.focus({ preventScroll: true }); select(at, e.shiftKey); }
  };
  table.ondblclick = e => {
    const at = cellAt(e.target);
    if (at && at.c >= 0) inspect(at.r, at.c);
  };
  // A right click outside the selection selects that cell first: the menu copies what it is on.
  table.oncontextmenu = e => {
    const at = cellAt(e.target);
    if (at && !selected(at.r, Math.max(at.c, 0))) select(at, false);
  };
  const onScroll = () => paint();
  wrap.addEventListener('scroll', onScroll, { passive: true });
  const onKey = e => {
    if (!ui.inspector.root.hidden && e.key === 'Escape') { closeInspector(); return; }
    // A document, the Stats card or a chart in its place keeps its own Ctrl+C and Ctrl+A.
    if (table.hidden || !(e.target === wrap || table.contains(e.target))) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copy(e.shiftKey ? 'tsv-headers' : 'tsv'); return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); anchor = { r: 0, c: 0 }; focus = { r: view.length - 1, c: fields.length - 1 }; paint(true); return; }
    if (e.key === 'Escape') { anchor = focus = null; paint(true); return; }
    if (e.key === 'Enter' && focus && focus.c >= 0) { inspect(focus.r, focus.c); return; }
    const move = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (!move || !focus) return;
    e.preventDefault();
    const next = { r: Math.min(view.length - 1, Math.max(0, focus.r + move[0])),
                   c: Math.min(fields.length - 1, Math.max(0, focus.c + move[1])) };
    if (e.shiftKey) focus = next; else { anchor = next; focus = next; }
    reveal(next.r);
    paint(true);
  };
  wrap.tabIndex = 0;
  wrap.addEventListener('keydown', onKey);
  ui.filter.value = '';
  ui.filter.oninput = () => { filterText = ui.filter.value; refilter(); };
  ui.filter.parentElement.hidden = false;
  // What the webview's context menu runs on: the grid (package.json webview/context).
  table.dataset.vscodeContext = JSON.stringify({ webviewSection: 'grid', preventDefaultContextMenuItems: true });

  draw();
  return {
    copy,
    text,
    destroy() {
      wrap.removeEventListener('scroll', onScroll);
      wrap.removeEventListener('keydown', onKey);
      table.onclick = table.ondblclick = table.oncontextmenu = null;
      delete table.dataset.vscodeContext;
      ui.filter.oninput = null;
      ui.filter.parentElement.hidden = true;
      closeInspector();
    },
  };
}
