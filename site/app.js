// =============================================================================
// app.js — wire auth (auth.js) + Iceberg engine (data.js) to the DOM.
// =============================================================================
import { createAuth, describeAuthError } from './auth.js';
import { createEngine } from './data.js';

const $ = id => document.getElementById(id);
const cfg = window.RAYFIN_WASM_CONFIG || {};

const MAX_DOM_ROWS = 2000;   // cap rendered rows (CSV still exports the full result)
let engine = null;
let lakehouse = null;        // { workspace, item }
let activeIdent = null;      // quoted identifier of the loaded table
let lastResult = null;       // { fields, rows } for CSV export

function setStatus(msg, type = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = type;
}

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------
const auth = createAuth(cfg, { onStatus: setStatus, onExpired: showExpired });

function showSignIn(onDone, msg = 'Sign in with your Microsoft (Entra) identity to read OneLake.') {
  const gate = $('authGate');
  gate.querySelector('#authGateMsg').innerHTML = msg;
  let btn = gate.querySelector('#signinBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'signinBtn';
    btn.className = 'primary';
    btn.style.cssText = 'padding:0.7rem 1.5rem;font-size:1rem';
    gate.appendChild(btn);
  }
  btn.textContent = 'Sign in';
  btn.onclick = async () => {
    try {
      btn.textContent = 'Signing in…';
      if (await auth.ensureSession(true)) { gate.style.display = 'none'; await onDone(); }
      else btn.textContent = 'Sign in';
    } catch (e) {
      btn.textContent = 'Sign in';
      const why = describeAuthError(e);
      gate.querySelector('#authGateMsg').textContent = 'Sign-in failed: ' + why;
      setStatus('Sign-in failed: ' + why, 'error');
      console.error(e);
    }
  };
}

// Silent token renewal failed mid-session (refresh token expired). DuckDB and the loaded
// tables stay as they are — put the gate back up so one click restores the token.
function showExpired() {
  $('authGate').style.display = '';
  showSignIn(
    async () => { $('userBox').textContent = auth.getUserId() || ''; },
    'Your OneLake session expired. Sign in again to keep querying.'
  );
}

function showOpenInTab() {
  const gate = $('authGate');
  gate.innerHTML = `
    <div style="font-size:1.3rem;font-weight:700">Open in a separate window</div>
    <div id="authGateMsg">This app signs you in to OneLake, which the Fabric portal's embedded frame blocks. Open it in its own browser tab to continue.</div>
    <a class="primary" style="padding:0.7rem 1.5rem;border-radius:6px;text-decoration:none;color:#fff"
       href="${window.location.href}" target="_blank" rel="noopener">Open in new tab ↗</a>`;
}

// ---------------------------------------------------------------------------
// After sign-in: bring up DuckDB and enable the UI.
// ---------------------------------------------------------------------------
async function start() {
  $('userBox').textContent = auth.getUserId() || '';
  engine = createEngine(auth, { onStatus: setStatus });
  await engine.init();
  setStatus('Signed in. Enter a lakehouse path and press Connect.', 'ok');

  $('connectBtn').onclick = connect;
  $('lakehouseInput').addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
  $('runBtn').onclick = runQuery;
  $('previewBtn').onclick = () => { if (activeIdent) { $('sqlEditor').value = `SELECT * FROM ${activeIdent} LIMIT 100`; runQuery(); } };
  $('csvBtn').onclick = downloadCsv;
  $('sqlEditor').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runQuery(); }
  });

  if (cfg.defaultLakehouse) { $('lakehouseInput').value = cfg.defaultLakehouse; connect(); }
}

// ---------------------------------------------------------------------------
// Connect -> list tables -> sidebar
// ---------------------------------------------------------------------------
async function connect() {
  const raw = $('lakehouseInput').value;
  try {
    lakehouse = engine.parseLakehouse(raw);
  } catch (e) { setStatus(e.message, 'error'); return; }

  $('connectBtn').disabled = true;
  setStatus(`Listing tables in ${lakehouse.workspace}/${lakehouse.item}…`);
  $('tableList').innerHTML = '<div class="hint">Loading…</div>';
  try {
    const tables = await engine.listTables(lakehouse);
    renderTableList(tables);
    const ice = tables.filter(t => t.kind === 'iceberg').length;
    $('tableCount').textContent = `${ice}/${tables.length}`;
    setStatus(`${ice} Iceberg table(s) found in ${lakehouse.item}.` +
      (tables.length > ice ? ` (${tables.length - ice} non-Iceberg hidden from querying)` : ''), 'ok');
  } catch (e) {
    $('tableList').innerHTML = '<div class="hint">Could not list tables.</div>';
    setStatus('List failed: ' + e.message, 'error');
    console.error(e);
  } finally {
    $('connectBtn').disabled = false;
  }
}

function renderTableList(tables) {
  const list = $('tableList');
  list.innerHTML = '';
  if (!tables.length) { list.innerHTML = '<div class="hint">No tables under Tables/.</div>'; return; }

  // Group by schema (null schema -> "(no schema)").
  const groups = new Map();
  for (const t of tables) {
    const key = t.schema || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  for (const [schema, items] of groups) {
    const g = document.createElement('div');
    g.className = 'schemaGroup';
    if (schema) {
      const h = document.createElement('div');
      h.className = 'schemaName';
      h.textContent = schema;
      g.appendChild(h);
    }
    for (const t of items) {
      const row = document.createElement('div');
      row.className = 'tableItem' + (t.kind === 'delta' ? ' delta' : '');
      row.title = t.kind === 'delta'
        ? `${t.table} — Delta table (Iceberg only, not queryable here)`
        : t.kind === 'iceberg' ? t.table : `${t.table} — unknown table type`;
      row.innerHTML = `<span>${escapeHtml(t.table)}</span>` +
        (t.kind !== 'iceberg' ? `<span class="tag">${t.kind || '?'}</span>` : '');
      if (t.kind !== 'delta') row.onclick = () => selectTable(row, t);
      g.appendChild(row);
    }
    list.appendChild(g);
  }
}

// ---------------------------------------------------------------------------
// Select a table -> load -> schema bar + preview
// ---------------------------------------------------------------------------
async function selectTable(row, t) {
  document.querySelectorAll('.tableItem.active').forEach(el => el.classList.remove('active'));
  row.classList.add('active');
  $('activeTable').textContent = t.schema ? `${t.schema}.${t.table}` : t.table;
  setBusy(true);
  try {
    const info = await engine.loadTable(lakehouse, t);
    activeIdent = info.ident;
    renderSchemaBar(info);
    $('sqlEditor').value = `SELECT * FROM ${info.ident} LIMIT 100`;
    $('previewBtn').disabled = false;
    $('runBtn').disabled = false;
    await runQuery();
    setStatus(`Loaded ${info.label} — ${info.fileCount} file(s), ${engine.fmtBytes(info.bytes)}.`, 'ok');
  } catch (e) {
    setStatus('Load failed: ' + e.message, 'error');
    console.error(e);
  } finally {
    setBusy(false);
  }
}

function renderSchemaBar(info) {
  $('schemaBar').innerHTML = info.columns
    .map(c => `<span class="col"><b>${escapeHtml(c.name)}</b> <span>${escapeHtml(c.type)}</span></span>`)
    .join('');
}

// ---------------------------------------------------------------------------
// Run SQL -> results table
// ---------------------------------------------------------------------------
async function runQuery() {
  const sql = $('sqlEditor').value;
  setBusy(true);
  const t0 = performance.now();
  try {
    const res = await engine.runSql(sql);
    lastResult = res;
    renderResults(res);
    const ms = Math.round(performance.now() - t0);
    const shown = Math.min(res.rows.length, MAX_DOM_ROWS);
    setStatus(`${res.rows.length.toLocaleString('en')} row(s) in ${ms} ms` +
      (res.rows.length > shown ? ` — showing first ${shown.toLocaleString('en')}` : ''), 'ok');
    $('csvBtn').disabled = res.rows.length === 0;
  } catch (e) {
    setStatus('Query error: ' + e.message, 'error');
    console.error(e);
  } finally {
    setBusy(false);
  }
}

function renderResults(res) {
  const table = $('resultsTable');
  const hint = $('resultsHint');
  if (!res.rows.length) {
    table.hidden = true; hint.hidden = false; hint.textContent = '(no rows)';
    return;
  }
  hint.hidden = true; table.hidden = false;
  const rows = res.rows.slice(0, MAX_DOM_ROWS);
  const head = '<thead><tr>' + res.fields.map(f => `<th>${escapeHtml(f)}</th>`).join('') + '</tr></thead>';
  const body = '<tbody>' + rows.map(r => '<tr>' + res.fields.map(f => {
    const v = r[f];
    const num = typeof v === 'number';
    return `<td class="${num ? 'num' : ''}">${escapeHtml(cellText(v))}</td>`;
  }).join('') + '</tr>').join('') + '</tbody>';
  table.innerHTML = head + body;
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------
function downloadCsv() {
  if (!lastResult || !lastResult.rows.length) return;
  const { fields, rows } = lastResult;
  const q = s => {
    const t = cellText(s);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [fields.map(q).join(',')];
  for (const r of rows) lines.push(fields.map(f => q(r[f])).join(','));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = ($('activeTable').textContent || 'query').replace(/[^\w.-]+/g, '_') + '.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function setBusy(b) {
  $('connectBtn').disabled = b;
  // Run/Preview are only meaningful once a table is loaded.
  const canQuery = !!activeIdent && !b;
  $('runBtn').disabled = !canQuery;
  $('previewBtn').disabled = !canQuery;
}

// ---------------------------------------------------------------------------
// Boot: silent session check, then gate.
// ---------------------------------------------------------------------------
const EMBEDDED = window.self !== window.top;   // inside the Fabric portal iframe?
(async () => {
  try {
    if (await auth.ensureSession(false)) {
      $('authGate').style.display = 'none';
      await start();
    } else if (auth.mode === 'msal' && EMBEDDED) {
      showOpenInTab();
    } else {
      showSignIn(start);
    }
  } catch (e) {
    const why = describeAuthError(e);
    $('authGateMsg').textContent = 'Error: ' + why;
    setStatus('Error: ' + why, 'error');
    console.error(e);
  }
})();
