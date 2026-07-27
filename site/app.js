// =============================================================================
// app.js — wire auth (auth.js) + Iceberg engine (data.js) to the DOM.
// =============================================================================
import {
  createAuth, describeAuthError, isConsentError,
  resolveConfig, saveOverride, clearOverride, adminConsentUrl, appRedirectUri,
} from './auth.js';
import { createEngine, READY } from './data.js';
import { isDocResult } from './paths.js';
// Static import is safe: docview.js itself is tiny — the CDN fetch of the markdown
// parser only happens inside renderMarkdown(), on the first pretty render.
import { renderMarkdown } from './docview.js';

const $ = id => document.getElementById(id);
const DOCS = 'https://github.com/djouallah/onelake_studio';
// config.js gives the built-in registration; resolveConfig lets ?clientId=…&tenantId=…
// (persisted in localStorage) replace it, which is how a locked-down tenant gets in.
const cfg = resolveConfig(window.ONELAKE_STUDIO_CONFIG || {});

// Cap on rendered rows only. The CSV exports everything the engine materialised, which is
// itself capped — runQuery says so when the two differ.
const MAX_DOM_ROWS = 2000;
let engine = null;
let signedIn = false;        // OneLake session established (browsing unlocked)
let lakehouse = null;        // { workspace, item }
let activeIdent = null;      // quoted identifier of the loaded table
let lastResult = null;       // { fields, rows } for CSV export
let pane = 'tables';         // which sidebar pane is showing: 'tables' | 'files'
let docMode = 'pretty';      // Pretty | Raw for a document result; reset each query
let docSeq = 0;              // a slow CDN import must not paint over a newer result
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

// The signed-out header affordance. Signing in is an upgrade, not a precondition: the
// engine and the SQL editor already work, this only unlocks browsing OneLake.
function showSignedOut() {
  const box = $('userBox');
  box.textContent = '';
  const btn = document.createElement('button');
  btn.className = 'primary';
  btn.textContent = 'Sign in to OneLake';
  btn.onclick = () => {
    // MSAL redirect auth can't run inside an embedding iframe — hand over a real tab.
    if (auth.mode === 'msal' && EMBEDDED) showOpenInTab();
    else showSignIn(afterSignIn);
  };
  box.appendChild(btn);
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
    // The redirect flow reloads the page — a query someone wrote before deciding to
    // sign in must survive the round trip. Restored (once) by the boot path.
    try { sessionStorage.setItem(PENDING_SQL_KEY, $('sqlEditor').value); } catch (_) {}
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

// A foot link is an offer to open a block; once that block is open, with its own heading
// and its own docs link, the offer is just noise. (Guarded: showOpenInTab rebuilds the
// gate without the foot options.)
function hideOption(id) {
  const a = $(id);
  if (a) a.hidden = true;
}

function showConsentHelp(withByo = false) {
  hideOption('consentLink');
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
  hideOption('byoLink');
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

// Signed in through someone's own registration — say so, and offer the way back, with
// the one condition attached. That makes the "use your own" option below redundant.
function showByoBanner() {
  if ($('byoBanner')) return;
  hideOption('byoLink');
  const el = document.createElement('div');
  el.id = 'byoBanner';
  el.className = 'gateFoot';
  el.innerHTML = `Using your own app registration (<code>${escapeHtml(cfg.clientId)}</code>) — ` +
    '<a id="byoBannerReset">use the built-in one</a>, if your tenant has consented to it.';
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
      <div class="gateFoot"><a id="gateClose">← Continue without signing in</a></div>
    </div>`;
  gate.style.display = '';
  $('gateClose').onclick = () => { gate.style.display = 'none'; };
}

// ---------------------------------------------------------------------------
// Boot: bring up DuckDB and enable the UI — no sign-in required.
// ---------------------------------------------------------------------------
// The engine is a purely local machine; the token is only touched when OneLake is
// listed or read. So the editor works for everyone, and signing in is the upgrade
// that unlocks the workspace picker (afterSignIn).
const PENDING_SQL_KEY = 'onelake-studio-pending-sql';

// The landing page is a query result: on a fresh boot the app reads its own README
// through the engine and the Pretty view renders it. The docs demonstrate the tool
// by being served by it.
const README_SQL =
  "select content from read_text('https://raw.githubusercontent.com/djouallah/onelake_studio/refs/heads/main/README.md')";

async function startLocal() {
  engine = createEngine(auth, { onStatus: setStatus });
  await engine.init();
  $('runBtn').disabled = false;   // SQL needs the engine, not a lakehouse
  $('connectBtn').onclick = () => connect({ force: true });
  $('wsSelect').addEventListener('input', onWorkspaceInput);
  $('wsSelect').addEventListener('change', onWorkspaceInput);
  $('itemSelect').onchange = () => connect();
  $('tabTables').onclick = () => switchPane('tables');
  $('tabFiles').onclick = () => switchPane('files');
  $('runBtn').onclick = runQuery;
  $('previewBtn').onclick = () => { if (activeIdent) { $('sqlEditor').value = `SELECT * FROM ${activeIdent} LIMIT 100`; runQuery(); } };
  $('csvBtn').onclick = downloadCsv;
  $('docPretty').onclick = () => {
    if (docMode === 'pretty' || !lastResult) return;
    docMode = 'pretty';
    showDoc(lastResult.rows[0][lastResult.fields[0]]);   // module cached — instant
  };
  $('docRaw').onclick = () => {
    docMode = 'raw';
    setDocTabs();
    $('docView').hidden = true;
    $('resultsTable').hidden = false;
  };
  $('sqlEditor').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runQuery(); }
  });
  // SQL written before a sign-in redirect comes back here after the round trip.
  try {
    const stash = sessionStorage.getItem(PENDING_SQL_KEY);
    sessionStorage.removeItem(PENDING_SQL_KEY);
    if (stash && !$('sqlEditor').value) $('sqlEditor').value = stash;
  } catch (_) {}
  const booted = 'DuckDB ready — run SQL now, or sign in to browse OneLake.';
  if (!$('sqlEditor').value) {
    // Fresh visit: show the README as the landing content. The stash branch above
    // means a sign-in round trip never loses the user's SQL to this. Offline or
    // blocked, runQuery reports its error — the boot message below replaces it,
    // because a failed docs fetch must not read as a broken app.
    $('sqlEditor').value = README_SQL;
    await runQuery();
  }
  setStatus(booted, 'ok');
}

// After a OneLake session exists (silent on boot, or interactive): unlock browsing.
async function afterSignIn() {
  signedIn = true;
  $('authGate').style.display = 'none';
  showSignedIn();
  $('wsSelect').placeholder = 'Loading workspaces…';
  if (!lakehouse)
    $('tableList').innerHTML = '<div class="hint">Pick a workspace, then a lakehouse or warehouse.</div>';
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

// The workspace box is a datalist combobox: free text the user types, filtered as they
// type by the browser. That means its value is a CLAIM, not a selection — everything
// downstream goes through canonicalWs() to turn it into a real workspace name (exact
// first, then case-insensitive) or null.
let wsNames = [];
let lastWs = '';       // the workspace whose items are currently loaded, to dedupe events

function canonicalWs(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (wsNames.includes(s)) return s;
  const lower = s.toLowerCase();
  return wsNames.find(n => n.toLowerCase() === lower) || null;
}

function fillWorkspaces(names) {
  wsNames = names;
  const dl = $('wsOptions');
  dl.innerHTML = '';
  for (const n of names) {
    const o = document.createElement('option');
    o.value = n;
    dl.appendChild(o);
  }
  const el = $('wsSelect');
  el.disabled = !names.length;
  el.placeholder = names.length ? `Workspace (${names.length}) — type to search` : 'No workspaces';
}

// Datalist quirk: picking an option fires 'input', typing fires 'input', Enter/blur fire
// 'change'. One handler serves all three — act only when the text resolves to a real
// workspace we aren't already showing, so keystrokes along the way cost nothing.
function onWorkspaceInput() {
  const el = $('wsSelect');
  const v = el.value.trim();
  if (!v) { if (lastWs) onWorkspaceChange(); return; }
  const c = canonicalWs(v);
  if (!c || c === lastWs) return;
  if (el.value !== c) el.value = c;
  onWorkspaceChange();
}

async function loadCatalog() {
  try {
    setStatus('Loading workspaces…');
    const names = await engine.listWorkspaces();
    fillWorkspaces(names);
    setStatus(`${names.length} workspace(s). Type to search, pick one to browse its tables.`, 'ok');

    // cfg.defaultLakehouse ("workspace/item.Lakehouse") preselects both levels.
    if (cfg.defaultLakehouse) {
      const { workspace, item } = engine.parseLakehouse(cfg.defaultLakehouse);
      if (names.includes(workspace)) {
        $('wsSelect').value = workspace;
        await onWorkspaceChange();
        const sel = $('itemSelect');
        if ([...sel.options].some(o => o.value === item)) { sel.value = item; await connect(); }
      }
    }
  } catch (e) {
    fillWorkspaces([]);
    $('wsSelect').placeholder = 'Could not list workspaces';
    setStatus('Could not list workspaces: ' + e.message, 'error');
    console.error(e);
  }
}

async function onWorkspaceChange() {
  const workspace = canonicalWs($('wsSelect').value) || '';
  lastWs = workspace;
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
  const workspace = canonicalWs($('wsSelect').value), item = $('itemSelect').value;
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
    $('tableList').innerHTML = signedIn
      ? '<div class="hint">Pick a workspace, then a lakehouse or warehouse.</div>'
      : '<div class="hint">Sign in to OneLake to browse tables and files.</div>';
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
    // A database file with no tables attaches but leaves nothing to preview.
    if (info.ident) {
      $('sqlEditor').value = `SELECT * FROM ${info.ident} LIMIT 100`;
      $('previewBtn').disabled = false;
      $('runBtn').disabled = false;
      reportLoad(info, await runQuery());
    } else {
      reportLoad(info, true);
    }
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
  // A doc view from the previous result must never survive into this one.
  docSeq++; docMode = 'pretty';
  $('docBar').hidden = true;
  $('docView').hidden = true;
  $('docView').innerHTML = '';
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

  // The grid above is always rendered and stays the source of truth (CSV exports it
  // regardless). A document result additionally gets the Pretty view on top.
  if (isDocResult(res)) {
    $('docBar').hidden = false;
    showDoc(res.rows[0][res.fields[0]]);
  }
}

// ---------------------------------------------------------------------------
// Document view: a 1×1 multiline VARCHAR rendered as markdown (docview.js).
// Fails closed — any renderer trouble leaves the escaped grid on screen.
// ---------------------------------------------------------------------------
async function showDoc(text) {
  const seq = ++docSeq;
  try {
    const html = await renderMarkdown(text);
    if (seq !== docSeq || docMode !== 'pretty') return;
    $('docView').innerHTML = html;
    $('docView').hidden = false;
    $('resultsTable').hidden = true;
    setDocTabs();
  } catch (e) {
    if (seq !== docSeq) return;
    $('docBar').hidden = true;
    setStatus('Markdown renderer unavailable (' + e.message + ') — showing raw.', 'warn');
  }
}

function setDocTabs() {
  $('docPretty').classList.toggle('active', docMode === 'pretty');
  $('docRaw').classList.toggle('active', docMode !== 'pretty');
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
// says "dev"). One home only, by request: the status bar, bottom-right — always on
// screen for a signed-in session and never overwritten by status messages. It exists
// because a browser's cache will happily serve last week's app under today's URL and
// nothing else on the page would give that away.
function showVersion() {
  const v = window.ONELAKE_STUDIO_VERSION || {};
  const commit = v.commit || 'unknown';
  const when = v.builtAt ? new Date(v.builtAt) : null;
  const stamp = commit + (when ? ` · ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '');

  const bar = $('statusVer');
  bar.textContent = `build ${commit}`;
  bar.title = `Build ${stamp} — click to see this commit on GitHub`;
  if (commit !== 'dev' && commit !== 'unknown')
    bar.href = `${DOCS}/commit/${encodeURIComponent(commit)}`;
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
  // Run needs only the engine — SELECT h3_latlng_to_cell(...) is a fine first query
  // with no lakehouse selected. Preview rewrites the editor to SELECT * FROM <active
  // table>, so it alone keeps waiting for one.
  $('runBtn').disabled = !engine || b;
  $('previewBtn').disabled = !activeIdent || b;
}

// ---------------------------------------------------------------------------
// Boot: local engine first, then a silent session check — never a gate up front.
// ---------------------------------------------------------------------------
const EMBEDDED = window.self !== window.top;   // inside an embedding iframe?
$('byoLink').onclick = () => showByoForm();
$('consentLink').onclick = () => showConsentHelp();
$('gateClose').onclick = () => { $('authGate').style.display = 'none'; };
initSidebarToggle();
showVersion();
checkForNewBuild();
setInterval(checkForNewBuild, VERSION_RECHECK_MS);
(async () => {
  // Engine trouble (CDN down, wasm refused) must not block the sign-in path, and auth
  // trouble must not block local SQL — the two halves fail independently.
  try {
    await startLocal();
  } catch (e) {
    setStatus('Engine failed to start: ' + e.message, 'error');
    console.error(e);
  }
  try {
    // Silent only: restores a returning user's session (and completes a sign-in
    // redirect landing back here) without ever prompting a new visitor.
    if (await auth.ensureSession(false)) await afterSignIn();
    else showSignedOut();
  } catch (e) {
    // A redirect coming back with a consent failure lands here, not in the button
    // handler — so the gate has to be rendered before the error is explained.
    showSignedOut();
    showSignIn(afterSignIn);
    showAuthFailure(e);
  }
})();
