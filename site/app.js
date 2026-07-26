// =============================================================================
// app.js — wire auth (auth.js) + Iceberg engine (data.js) to the DOM.
// =============================================================================
import {
  createAuth, describeAuthError, isConsentError,
  resolveConfig, saveOverride, clearOverride, adminConsentUrl, appRedirectUri,
} from './auth.js';
import { createEngine, READY } from './data.js';

const $ = id => document.getElementById(id);
const DOCS = 'https://github.com/djouallah/onelake_studio';
// config.js gives the built-in registration; resolveConfig lets ?clientId=…&tenantId=…
// (persisted in localStorage) replace it, which is how a locked-down tenant gets in.
const cfg = resolveConfig(window.ONELAKE_STUDIO_CONFIG || {});

// Cap on rendered rows only. The CSV exports everything the engine materialised, which is
// itself capped — runQuery says so when the two differ.
const MAX_DOM_ROWS = 2000;
let engine = null;
let lakehouse = null;        // { workspace, item }
let activeIdent = null;      // quoted identifier of the loaded table
let lastResult = null;       // { fields, rows } for CSV export
let pane = 'tables';         // which sidebar pane is showing: 'tables' | 'files'
let lastTables = null;       // cached listTables() result, so switching panes is free
let lastTableCount = '';

function setStatus(msg, type = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = type;
}

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------
const auth = createAuth(cfg, { onStatus: setStatus, onExpired: showExpired });

// Deliberately does NOT render the signed-in address. The identity is visible in the
// browser's own account UI, and this app gets screen-shared and screenshotted; a UPN in
// the header is a needless leak. auth.getUserId() is still there for console debugging.
function showSignedIn() {
  const box = $('userBox');
  box.textContent = '';
  const label = document.createElement('span');
  label.textContent = 'Signed in';
  const out = document.createElement('a');
  out.textContent = 'Sign out';
  out.className = 'signout';
  // There was no way to end a session from inside the app, which also meant no way to get
  // rid of the bearer token Cache Storage had written to disk on this machine.
  out.onclick = async () => {
    out.textContent = 'Signing out…';
    // Guarded: signOut ships with the token-lifecycle change to auth.js; until then the
    // button just reloads back to the gate.
    try { if (auth.signOut) await auth.signOut(); } catch (e) { console.error(e); }
    window.location.replace(appRedirectUri());
  };
  box.append(label, out);
}

function gateMsg(text, isError = false) {
  const el = $('authGateMsg');
  el.textContent = text;
  el.classList.toggle('err', isError);
}

function showSignIn(onDone, msg = 'Sign in with your Microsoft work or school account.') {
  const gate = $('authGate');
  gate.style.display = '';
  gateMsg(msg);
  let btn = $('signinBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'signinBtn';
    btn.className = 'primary';
    $('authActions').prepend(btn);
  }
  btn.disabled = false;
  btn.textContent = 'Sign in';
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      // acquireTokenRedirect navigates away and never resolves, so a `false` here means
      // "no silent session and no redirect" — put the button back.
      if (await auth.ensureSession(true)) { gate.style.display = 'none'; await onDone(); }
      else { btn.disabled = false; btn.textContent = 'Sign in'; }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Sign in';
      showAuthFailure(e);
    }
  };
  if (cfg.byo) showByoBanner();
}

// A failed sign-in that's really "your tenant hasn't consented" gets both fixes handed
// over — the admin-consent URL and the bring-your-own-registration form — because that
// is the expected outcome for an app that isn't publisher-verified.
function showAuthFailure(e) {
  const why = describeAuthError(e);
  gateMsg('Sign-in failed: ' + why, true);
  setStatus('Sign-in failed: ' + why, 'error');
  if (isConsentError(e)) showConsentHelp(true);   // both fixes, since neither is guaranteed
  console.error(e);
}

function showConsentHelp(withByo = false) {
  if ($('consentBox')) { if (withByo) showByoForm(); return; }
  const url = adminConsentUrl(cfg);
  const box = document.createElement('div');
  box.id = 'consentBox';
  box.className = 'gateBox';
  box.innerHTML = `
    <h4>Ask an admin to consent</h4>
    <div>One click, once, for your whole tenant. Send them this URL:</div>
    <div class="copyRow">
      <input id="consentUrl" readonly value="${escapeHtml(url)}" />
      <button id="copyConsentBtn">Copy</button>
    </div>
    <div>What they're approving, and how to revoke it later, is in the
      <a href="${DOCS}#for-admins" target="_blank" rel="noopener">admin notes</a>.</div>`;
  $('authActions').appendChild(box);
  $('copyConsentBtn').onclick = async () => {
    const input = $('consentUrl');
    input.select();
    try { await navigator.clipboard.writeText(input.value); } catch (_) { document.execCommand('copy'); }
    $('copyConsentBtn').textContent = 'Copied';
    setTimeout(() => { $('copyConsentBtn').textContent = 'Copy'; }, 1500);
  };
  if (withByo) showByoForm();
}

// The form that switches the app to another registration. Reachable from the consent
// block and from the "Use my own app registration" link at the bottom of the gate.
function showByoForm() {
  if ($('byoBox')) { $('byoClientId').focus(); return; }
  const box = document.createElement('div');
  box.id = 'byoBox';
  box.className = 'gateBox';
  box.innerHTML = `
    <h4>Use your own app registration</h4>
    <div>An app from your own tenant needs no admin.
      <a href="${DOCS}#use-your-own-app-registration" target="_blank" rel="noopener">How to create one</a>
      — it takes about five minutes.</div>
    <div class="byoRow">
      <input id="byoClientId" placeholder="Application (client) ID" spellcheck="false" />
      <input id="byoTenantId" placeholder="Directory (tenant) ID — or blank" spellcheck="false" />
    </div>
    <div class="byoRow">
      <button id="byoUseBtn" class="primary">Use it</button>
      ${cfg.byo ? '<button id="byoResetBtn">Back to the built-in app</button>' : ''}
      <span id="byoErr" class="err"></span>
    </div>
    <div>Saved in this browser, so this is a one-off — you won't be asked again.</div>`;
  $('authActions').appendChild(box);
  $('byoUseBtn').onclick = () => {
    try {
      saveOverride($('byoClientId').value, $('byoTenantId').value);
      // Reload rather than re-create the provider: MSAL caches state per clientId, and a
      // clean load with the new registration is the only way to be sure none is reused.
      window.location.replace(appRedirectUri());
    } catch (e) {
      $('byoErr').textContent = e.message;
    }
  };
  const reset = $('byoResetBtn');
  if (reset) reset.onclick = () => { clearOverride(); window.location.replace(appRedirectUri()); };
  $('byoClientId').focus();
}

// Signed in through someone's own registration — say so, and offer the way back.
function showByoBanner() {
  if ($('byoBanner')) return;
  const el = document.createElement('div');
  el.id = 'byoBanner';
  el.className = 'gateFoot';
  el.innerHTML = `Using your own app registration (<code>${escapeHtml(cfg.clientId)}</code>). ` +
    '<a id="byoBannerReset">Use the built-in one instead</a>';
  $('authActions').appendChild(el);
  $('byoBannerReset').onclick = () => { clearOverride(); window.location.replace(appRedirectUri()); };
}

// Silent token renewal failed mid-session (refresh token expired). DuckDB and the loaded
// tables stay as they are — put the gate back up so one click restores the token.
function showExpired() {
  $('authGate').style.display = '';
  showSignIn(
    async () => { showSignedIn(); },
    'Your OneLake session expired. Sign in again to keep querying.'
  );
}

function showOpenInTab() {
  const gate = $('authGate');
  gate.innerHTML = `
    <div class="gateCard">
      <div class="gateBrand">Open in a separate window</div>
      <div id="authGateMsg">This app signs you in to OneLake, which an embedded frame blocks. Open it in its own browser tab to continue.</div>
      <a class="primary" style="padding:0.7rem 1.5rem;border-radius:6px;text-decoration:none;color:#fff;align-self:center"
         href="${window.location.href}" target="_blank" rel="noopener">Open in new tab ↗</a>
    </div>`;
}

// ---------------------------------------------------------------------------
// After sign-in: bring up DuckDB and enable the UI.
// ---------------------------------------------------------------------------
async function start() {
  showSignedIn();
  engine = createEngine(auth, { onStatus: setStatus });
  await engine.init();
  $('connectBtn').onclick = () => connect({ force: true });
  $('wsSelect').onchange = onWorkspaceChange;
  $('itemSelect').onchange = () => connect();
  $('tabTables').onclick = () => switchPane('tables');
  $('tabFiles').onclick = () => switchPane('files');
  $('runBtn').onclick = runQuery;
  $('previewBtn').onclick = () => { if (activeIdent) { $('sqlEditor').value = `SELECT * FROM ${activeIdent} LIMIT 100`; runQuery(); } };
  $('csvBtn').onclick = downloadCsv;
  $('sqlEditor').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runQuery(); }
  });

  await loadCatalog();
}

// ---------------------------------------------------------------------------
// Catalog — workspaces, then the lakehouses/warehouses inside one.
// ---------------------------------------------------------------------------
// Both levels come from the OneLake DFS API on the storage token we already hold, so
// browsing costs no extra Entra permission and no second consent prompt.
function fill(sel, options, placeholder) {
  sel.innerHTML = '';
  const first = document.createElement('option');
  first.value = '';
  first.textContent = placeholder;
  sel.appendChild(first);
  for (const o of options) {
    const el = document.createElement('option');
    el.value = o.value;
    el.textContent = o.label;
    sel.appendChild(el);
  }
}

async function loadCatalog() {
  const ws = $('wsSelect');
  try {
    setStatus('Loading workspaces…');
    const names = await engine.listWorkspaces();
    fill(ws, names.map(n => ({ value: n, label: n })), `Workspace (${names.length})`);
    setStatus(`${names.length} workspace(s). Pick one to browse its tables.`, 'ok');

    // cfg.defaultLakehouse ("workspace/item.Lakehouse") preselects both levels.
    if (cfg.defaultLakehouse) {
      const { workspace, item } = engine.parseLakehouse(cfg.defaultLakehouse);
      if (names.includes(workspace)) {
        ws.value = workspace;
        await onWorkspaceChange();
        const sel = $('itemSelect');
        if ([...sel.options].some(o => o.value === item)) { sel.value = item; await connect(); }
      }
    }
  } catch (e) {
    fill(ws, [], 'Could not list workspaces');
    setStatus('Could not list workspaces: ' + e.message, 'error');
    console.error(e);
  }
}

async function onWorkspaceChange() {
  const workspace = $('wsSelect').value;
  const sel = $('itemSelect');
  activeIdent = null;
  lastResult = null;
  lastTables = null;
  lastTableCount = '';
  // This is the point where the previous lakehouse is left behind — and because it also
  // clears `lakehouse`, connect() can no longer tell that the target changed. Hand the
  // engine's views and registered files back here instead.
  if (lakehouse) await engine.reset();
  lakehouse = null;
  $('tableList').innerHTML = '<div class="hint">Pick a lakehouse or warehouse.</div>';
  $('tableCount').textContent = '';
  if (!workspace) {
    sel.disabled = true;
    fill(sel, [], 'Select a workspace first');
    return;
  }
  sel.disabled = true;
  fill(sel, [], 'Loading…');
  try {
    setStatus(`Listing items in ${workspace}…`);
    const items = await engine.listItems(workspace);
    fill(sel, items.map(i => ({ value: i.name, label: `${i.name.replace(/\.[^.]+$/, '')}  ·  ${i.kind}` })),
         items.length ? `Item (${items.length})` : 'No lakehouses or warehouses');
    sel.disabled = !items.length;
    setStatus(items.length
      ? `${items.length} lakehouse(s)/warehouse(s) in ${workspace}.`
      : `${workspace} has no lakehouse or warehouse.`, items.length ? 'ok' : '');
  } catch (e) {
    fill(sel, [], 'Could not list items');
    setStatus('Could not list items: ' + e.message, 'error');
    console.error(e);
  }
}

// ---------------------------------------------------------------------------
// Connect -> list tables -> sidebar
// ---------------------------------------------------------------------------
// `force` is what the Reload button passes. Without it, re-listing a lakehouse you are
// already on left every table served from cache, so "Reload" showed the same snapshot it
// showed before and there was no way to pick up a table that had changed underneath.
async function connect({ force = false } = {}) {
  const workspace = $('wsSelect').value, item = $('itemSelect').value;
  if (!workspace || !item) return;

  // Views, registered files and helper tables from the previous lakehouse are dead the
  // moment we point somewhere else, and they cost WASM memory for as long as the tab
  // lives. Cache entries are keyed per lakehouse so a stale one can't be served, but the
  // DuckDB objects behind them still have to be given back.
  const moved = lakehouse && (lakehouse.workspace !== workspace || lakehouse.item !== item);
  if (force || moved) {
    activeIdent = null;
    lastResult = null;
    $('activeTable').textContent = 'No table selected';
    await engine.reset();
  }
  lakehouse = { workspace, item };

  $('connectBtn').disabled = true;
  setStatus(`Listing tables in ${lakehouse.workspace}/${lakehouse.item}…`);
  $('tableList').innerHTML = '<div class="hint">Loading…</div>';
  try {
    const tables = await engine.listTables(lakehouse);
    // Storage format is the engine's business, not the user's. The only distinction worth
    // surfacing is whether a table can be opened yet.
    const ready = tables.filter(t => t.kind === READY).length;
    lastTables = tables;
    lastTableCount = String(tables.length);
    if (pane === 'tables') { renderTableList(tables); $('tableCount').textContent = lastTableCount; }
    else await renderFileTree();
    setStatus(`${tables.length} table(s) in ${lakehouse.item}.` +
      (tables.length > ready ? ` ${tables.length - ready} awaiting Iceberg conversion.` : ''), 'ok');
  } catch (e) {
    $('tableList').innerHTML = '<div class="hint">Could not list tables.</div>';
    setStatus('List failed: ' + e.message, 'error');
    console.error(e);
  } finally {
    $('connectBtn').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Files/ tree — the unmanaged half of a lakehouse
// ---------------------------------------------------------------------------
// Listed one directory at a time, on expand: a lakehouse's Files/ can be arbitrarily
// deep and wide, so a recursive listing up front would be slow for no benefit.
function switchPane(which) {
  pane = which;
  $('tabTables').classList.toggle('active', which === 'tables');
  $('tabFiles').classList.toggle('active', which === 'files');
  if (!lakehouse) {
    $('tableList').innerHTML = '<div class="hint">Pick a workspace, then a lakehouse or warehouse.</div>';
    return;
  }
  if (which === 'tables') { renderTableList(lastTables || []); $('tableCount').textContent = lastTableCount; }
  else renderFileTree();
}

async function renderFileTree() {
  const list = $('tableList');
  list.innerHTML = '<div class="hint">Loading…</div>';
  $('tableCount').textContent = '';
  try {
    const root = document.createElement('div');
    list.innerHTML = '';
    list.appendChild(root);
    await expandDir(root, '', 0);
    if (!root.children.length) list.innerHTML = '<div class="hint">Nothing under Files/.</div>';
  } catch (e) {
    list.innerHTML = '<div class="hint">Could not list Files/.</div>';
    setStatus('Files listing failed: ' + e.message, 'error');
    console.error(e);
  }
}

// Render one directory's children into `host`, indented by depth.
async function expandDir(host, dir, depth) {
  const entries = await engine.listFiles(lakehouse, dir);
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'fileItem' + (!e.isDir && !e.queryable ? ' plain' : '');
    row.style.paddingLeft = (0.75 + depth * 0.8) + 'rem';
    const caret = e.isDir ? '▸' : '';
    row.innerHTML = `<span class="caret">${caret}</span><span>${escapeHtml(e.name)}</span>` +
      (e.isDir ? '' : `<span class="size">${escapeHtml(engine.fmtBytes(e.bytes))}</span>`);
    host.appendChild(row);

    if (e.isDir) {
      const kids = document.createElement('div');
      kids.hidden = true;
      host.appendChild(kids);
      let loadedOnce = false;
      row.onclick = async () => {
        kids.hidden = !kids.hidden;
        row.querySelector('.caret').textContent = kids.hidden ? '▸' : '▾';
        if (!loadedOnce && !kids.hidden) {
          loadedOnce = true;
          try { await expandDir(kids, e.path.replace(/^.*?\/Files\/?/, ''), depth + 1); }
          catch (err) { setStatus('Could not list ' + e.name + ': ' + err.message, 'error'); }
        }
      };
    } else if (e.queryable) {
      row.onclick = () => selectFile(row, e);
    } else {
      row.title = e.name + ' — no reader for this file type';
    }
  }
}

async function selectFile(row, file) {
  document.querySelectorAll('.fileItem.active').forEach(el => el.classList.remove('active'));
  row.classList.add('active');
  $('activeTable').textContent = file.name;
  setBusy(true);
  try {
    const info = await engine.loadFile(lakehouse, file);
    activeIdent = info.ident;
    $('sqlEditor').value = `SELECT * FROM ${info.ident} LIMIT 100`;
    $('previewBtn').disabled = false;
    $('runBtn').disabled = false;
    reportLoad(info, await runQuery());
  } catch (e) {
    setStatus('Load failed: ' + e.message, 'error');
    console.error(e);
  } finally {
    setBusy(false);
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
      const pending = t.kind !== READY;
      row.className = 'tableItem' + (pending ? ' pending' : '');
      // OneLake surfaces every table as Iceberg, so a table with no metadata/ isn't a
      // format we can't read — it's one whose conversion hasn't run. That can still be
      // in flight, so let it be clicked: loadTable waits and then says what went wrong.
      row.title = pending
        ? `${t.table} — Iceberg metadata not written yet. Click to wait for it; ` +
          `conversion takes up to two minutes, or may not be enabled for this workspace.`
        : t.table;
      row.innerHTML = `<span>${escapeHtml(t.table)}</span>` +
        (pending ? '<span class="tag">converting</span>' : '');
      row.onclick = () => selectTable(row, t);
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
    $('sqlEditor').value = `SELECT * FROM ${info.ident} LIMIT 100`;
    $('previewBtn').disabled = false;
    $('runBtn').disabled = false;
    reportLoad(info, await runQuery());
    row.classList.remove('pending');
    row.querySelector('.tag')?.remove();
  } catch (e) {
    setStatus('Load failed: ' + e.message, 'error');
    console.error(e);
  } finally {
    setBusy(false);
  }
}

// The engine knows how it actually opened the table (range reads / full download) and
// whether anything about the read is not to be trusted; don't restate either here.
//
// Two rules. A load that carries warnings — equality deletes that were skipped, delete
// records that matched nothing, columns the current schema doesn't know — is not a
// success, so it must not render in the success colour. And if the auto-preview failed,
// its error stays on screen: overwriting it with a green load message told the user
// everything was fine while the results pane still showed the previous table.
function reportLoad(info, queryOk) {
  // The query error is already on screen and is the more actionable of the two, so a
  // failed preview keeps the status line whatever the load had to say about itself.
  if (!queryOk) return;
  const warnings = info.warnings || [];
  setStatus(
    engine.describeLoad(info) + (warnings.length ? '. Warning: ' + warnings.join('; ') : '') + '.',
    warnings.length ? 'warn' : 'ok');
}

// ---------------------------------------------------------------------------
// Run SQL -> results table
// ---------------------------------------------------------------------------
// Returns whether the query succeeded, so a caller that has its own message to show
// (selectTable, selectFile) can keep quiet when the error is the more useful thing.
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

    // Two different caps, and conflating them would be a lie about the CSV. MAX_DOM_ROWS
    // only limits what is drawn; res.truncated means the engine stopped materialising and
    // the rows beyond it do not exist here at all, so the export is short too.
    let msg = `${res.rows.length.toLocaleString('en')} row(s) in ${ms} ms`;
    if (res.rows.length > shown) msg += ` — showing first ${shown.toLocaleString('en')}`;
    if (res.truncated)
      msg += `. Stopped at ${res.limit.toLocaleString('en')} rows of ` +
             `${res.numRows.toLocaleString('en')} — add a LIMIT or narrow the query; ` +
             `the CSV export is capped at the same point`;
    setStatus(msg, res.truncated ? 'warn' : 'ok');
    $('csvBtn').disabled = res.rows.length === 0;
    return true;
  } catch (e) {
    setStatus('Query error: ' + e.message, 'error');
    console.error(e);
    return false;
  } finally {
    setBusy(false);
  }
}

// Column types live in the header cells, under the names — an empty result still shows
// the shape of what was asked for, which is what the old schema strip was for.
const NUMERIC_TYPE = /^(U?(TINY|SMALL|BIG|HUGE)INT|U?INTEGER|DOUBLE|FLOAT|DECIMAL)/;

function renderResults(res) {
  const table = $('resultsTable');
  const hint = $('resultsHint');
  if (!res.fields.length) {
    table.hidden = true; hint.hidden = false; hint.textContent = '(no columns)';
    return;
  }
  hint.hidden = true; table.hidden = false;
  const types = res.types || [];
  const head = '<thead><tr>' + res.fields.map((f, i) => {
    const t = types[i] || '';
    return `<th class="${NUMERIC_TYPE.test(t) ? 'num' : ''}" title="${escapeHtml(f + ' ' + t)}">` +
      `<span class="cname">${escapeHtml(f)}</span>` +
      `<span class="ctype">${escapeHtml(t)}</span></th>`;
  }).join('') + '</tr></thead>';

  if (!res.rows.length) {
    table.innerHTML = head +
      `<tbody><tr><td colspan="${res.fields.length}">(no rows)</td></tr></tbody>`;
    return;
  }
  const rows = res.rows.slice(0, MAX_DOM_ROWS);
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
  // Revoking in this same task races the download the click just started, and Firefox in
  // particular ends up saving nothing. One turn of the event loop is enough.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ---------------------------------------------------------------------------
// Sidebar collapse — remembered across reloads, since it's a layout preference
// (small screens, or a wide result set) rather than a per-session choice.
// ---------------------------------------------------------------------------
const SIDEBAR_KEY = 'onelakeStudio.sidebarCollapsed';

function setSidebar(collapsed) {
  $('sidebar').classList.toggle('collapsed', collapsed);
  const btn = $('sidebarToggle');
  btn.textContent = collapsed ? '»' : '«';
  btn.title = (collapsed ? 'Show' : 'Hide') + ' sidebar (Ctrl+B)';
  btn.setAttribute('aria-expanded', String(!collapsed));
  try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch (_) {}
}

function initSidebarToggle() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(SIDEBAR_KEY) === '1'; } catch (_) {}
  setSidebar(collapsed);
  $('sidebarToggle').onclick = () => setSidebar(!$('sidebar').classList.contains('collapsed'));
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      setSidebar(!$('sidebar').classList.contains('collapsed'));
    }
  });
}

// ---------------------------------------------------------------------------
// Version stamp — which build this page is actually running.
// ---------------------------------------------------------------------------
// build.mjs writes the commit + build time into version.js on deploy (the tracked file
// says "dev"). Shown in the header and on the sign-in gate, and linked to the commit,
// because a browser's cache will happily serve last week's app under today's URL and
// nothing else on the page would give that away.
function showVersion() {
  const v = window.ONELAKE_STUDIO_VERSION || {};
  const commit = v.commit || 'unknown';
  const when = v.builtAt ? new Date(v.builtAt) : null;
  const stamp = commit + (when ? ` · ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '');

  const link = commit !== 'dev' && commit !== 'unknown'
    ? `${DOCS}/commit/${encodeURIComponent(commit)}` : null;

  // Three homes: the header, the gate footer, and — the one a signed-in session actually
  // sees — the status bar, where nothing ever overwrites it.
  const box = $('verBox');
  box.textContent = commit;
  box.title = `Build ${stamp}`;
  if (link) box.href = link;

  const bar = $('statusVer');
  bar.textContent = `build ${commit}`;
  bar.title = `Build ${stamp} — click to see this commit on GitHub`;
  if (link) bar.href = link;

  $('gateVersion').textContent = `Build ${stamp}`;
}

// The stamp says which build the cache gave you; this says whether that's the current
// one. GitHub Pages serves with max-age=600, so for up to ten minutes after a deploy a
// plain load replays the previous build — the one situation the stamp exists for.
// A no-store fetch of version.js bypasses that cache, and a mismatch turns the stamp
// into a "refresh" prompt instead of leaving you to diff hashes against GitHub.
const VERSION_RECHECK_MS = 15 * 60 * 1000;

async function checkForNewBuild() {
  const mine = (window.ONELAKE_STUDIO_VERSION || {}).commit;
  if (!mine || mine === 'dev' || mine === 'unknown') return;   // local dev has no server truth
  try {
    const r = await fetch('version.js', { cache: 'no-store' });
    if (!r.ok) return;
    const m = /commit:\s*"([^"]+)"/.exec(await r.text());
    if (!m || m[1] === mine) return;
    const bar = $('statusVer');
    bar.textContent = `build ${mine} — ${m[1]} is live, click to refresh`;
    bar.title = `This tab is running ${mine}; the server has ${m[1]}. Click to reload.`;
    bar.removeAttribute('href');
    bar.classList.add('stale');
    bar.onclick = e => { e.preventDefault(); window.location.reload(); };
  } catch (_) { /* offline — nothing worth saying */ }
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
const EMBEDDED = window.self !== window.top;   // inside an embedding iframe?
$('byoLink').onclick = () => showByoForm();
$('consentLink').onclick = () => showConsentHelp();
initSidebarToggle();
showVersion();
checkForNewBuild();
setInterval(checkForNewBuild, VERSION_RECHECK_MS);
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
    // A redirect coming back with a consent failure lands here, not in the button
    // handler — so the gate has to be rendered before the error is explained.
    showSignIn(start);
    showAuthFailure(e);
  }
})();
