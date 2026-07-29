// =============================================================================
// app.js — wire auth (auth.js) + Iceberg engine (data.js) to the DOM.
// =============================================================================
import {
  createAuth, describeAuthError, isConsentError,
  resolveConfig, saveOverride, clearOverride, appRedirectUri,
} from './auth.js';
import { createEngine } from './data.js';
import { isDocResult, textLinesDoc, fileExt, isTextExt, escapeHtml, basename,
         hasFilesArea, kindLabel, IMAGE_EXTS, sqlNeedsTable, quoteIdent } from './paths.js';
// Static import is safe: docview.js itself is tiny — the CDN fetch of the markdown
// parser only happens inside renderMarkdown(), and only for a document that IS markdown.
import { renderDocument } from './docview.js';

const $ = id => document.getElementById(id);
const DOCS = 'https://github.com/djouallah/onelake_studio';
// config.js ships no registration, so cfg.clientId is normally empty until the user names
// one — via ?clientId=…&tenantId=… or the gate form, persisted in localStorage by
// resolveConfig. An empty clientId here is the ordinary first run, not a broken deploy.
const cfg = resolveConfig(window.ONELAKE_STUDIO_CONFIG || {});

// Running inside the VS Code extension's webview rather than a browser tab. The two hosts
// share every line of this file; what differs is chrome that belongs to a browser (a sign-in
// gate, a sign-out link, a build stamp, a link out to GitHub), browsing — which the editor's
// own sidebar owns — and how OneLake reads get signed: a service worker in a tab, the
// extension's loopback proxy here. Each of those reads this flag and nothing else.
const HOST_VSCODE = cfg.host === 'vscode';
if (HOST_VSCODE) document.body.classList.add('host-vscode');

// Cap on rendered rows only. The CSV exports everything the engine materialised, which is
// itself capped — runQuery says so when the two differ.
const MAX_DOM_ROWS = 2000;
let engine = null;
let engineReady = null;      // resolves when engine.init() has finished; gates every use of it
let engineUp = false;        // ...and the settled form of it, for the synchronous checks
let signedIn = false;        // OneLake session established (browsing unlocked)
let lakehouse = null;        // { workspace, item }
let activeIdent = null;      // quoted identifier of the loaded table
let activeFile = null;       // the Files-tab entry behind it, when a file is what was opened
let lastResult = null;       // { fields, rows } for CSV export
let pane = 'tables';         // which sidebar pane is showing: 'tables' | 'files'
let docMode = 'pretty';      // Pretty | Raw for a document result; reset each query
let docSeq = 0;              // a slow CDN import must not paint over a newer result
// Whether THIS result's source could be a document at all. Shape alone is not enough:
// a one-column, one-row parquet is still a table, and offering to "prettify" it means
// offering to render one cell as if it were the file. Set per query by runQuery.
let docAllowed = true;
let docSourceExt = '';           // ...and which file it came from, when it came from one
let activeDocEligible = false;   // the same two answers for the loaded table/file, for Preview
let activeDocExt = '';
let lastTables = null;       // cached listTables() result, so switching panes is free
let lastTableCount = '';
let activeInfo = null;       // the selected TABLE's info object — what the Stats tab renders
let viewMode = 'data';       // Data | Stats for a selected table
let statsPrev = null;        // hidden-flags of the data surfaces while Stats covers them
// Reading a table is metered, so a selection buys the cheapest thing that answers the
// question and nothing more. 'stats' = metadata only (no data read at all), 'peek' = one
// parquet file, 'loaded' = every file registered behind a real view. Each step happens
// only when the user asks for it, and never twice.
let activeTableRef = null;   // the table object behind the selection, for escalating
let tableStage = 'none';     // 'none' | 'stats' | 'peek' | 'loaded'
let freshLoad = null;        // info from an escalation that still owes the user a report

function setStatus(msg, type = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = type;
  // The bar is one ellipsised line, and an engine error is long — the file, the SQL, and
  // the HTTP status the service worker saw all arrive together and all get cut off. The
  // useful half was always the tail. Keep the whole thing reachable: hover for it, and
  // click an error open. Truncating a diagnostic to "what this crap" is not reporting it.
  el.title = msg;
  el.classList.toggle('clickable', type === 'error');
  el.onclick = type === 'error' ? () => el.classList.toggle('expanded') : null;
  if (type !== 'error') el.classList.remove('expanded');
}

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------
const auth = createAuth(cfg, { onStatus: setStatus, onExpired: showExpired });

// ---------------------------------------------------------------------------
// What the service worker saw
// ---------------------------------------------------------------------------
// DuckDB reads OneLake itself, over registered URLs, and reports EVERY failed open the
// same way: "Failed to open file: data_10.parquet". No status, no URL — an expired token,
// a deleted file and a network drop are one message. Those requests never pass through
// data.js, so the page cannot observe them; sw.js is the only thing that sees the answer,
// and it now says so. That turns the whole class of "wtf is this" into a status code.
let lastReadFailure = null;              // { status, pathname, at }
const READ_FAILURE_TTL_MS = 30_000;      // older than this and it is about some other query

try {
  navigator.serviceWorker.addEventListener('message', e => {
    const d = e.data || {};
    if (d.type !== 'onelake-read-failed') return;
    lastReadFailure = { status: d.status, pathname: d.pathname, signed: d.signed, at: Date.now() };
    // Nothing else can renew on DuckDB's behalf: data.js retries its own 401s, but it
    // never issued this request. refresh() is single-flight, so a burst costs one round
    // trip, and it re-gates the UI if the session is genuinely over.
    if (d.status === 401) auth.refresh().catch(() => {});
  });
  // Without startMessages() a container using addEventListener never delivers.
  navigator.serviceWorker.startMessages();
} catch (_) { /* no service worker — the bare message is all there is */ }

// Pin what the worker saw onto DuckDB's opaque wording, when the two are about the
// same moment — and always append the page facts that tell the identical-looking
// causes apart: which build this is (a stale cache replays fixed bugs), whether the
// worker is even controlling the page (if not, DuckDB's reads go out unsigned and
// every one 401s), and whether the page holds a token at all.
function explainRead(message) {
  const msg = String(message);
  if (!/Failed to open file|HTTP Error|Could not establish connection/i.test(msg)) return msg;
  const f = lastReadFailure;
  const recent = f && Date.now() - f.at <= READ_FAILURE_TTL_MS;
  let out = msg;
  if (recent) {
    const what = f.status === 0 ? 'could not be reached' : `answered HTTP ${f.status}`;
    const why = f.status === 401 ? ' — the OneLake token had expired; renewing it now, so try again'
              : f.status === 403 ? ' — this identity may not read that path'
              : f.status === 404 ? ' — the file is no longer there (the table may have been rewritten since it was listed)'
              : '';
    out += `. OneLake ${what} for ${f.pathname}${f.signed === false ? ' (the request went out unsigned)' : ''}${why}`;
  }
  const swc = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  const stale = f && !recent;
  // In the webview there is no service worker and no page-side token by design — the
  // extension's loopback proxy signs DuckDB's reads. Reporting the browser's facts here
  // told users to reload a page that was never going to grow a worker, which is worse
  // than saying nothing: it is a confident wrong answer.
  const signer = HOST_VSCODE
    ? "the extension's loopback proxy signs DuckDB's reads"
    : (swc ? 'the service worker is controlling this page'
           : 'the service worker is NOT controlling this page, so DuckDB reads go out unsigned — reload the page');
  out += ` [build ${(window.ONELAKE_STUDIO_VERSION || {}).commit || 'dev'}; ` + signer +
    `; crossOriginIsolated ${!!self.crossOriginIsolated}` +
    (HOST_VSCODE ? '' : `; page-side token ${Object.keys(auth.getHeaders()).length ? 'held' : 'absent'}`) +
    (recent ? '' :
     stale ? `; last read failure the worker reported: HTTP ${f.status} for ${f.pathname}, ${Math.round((Date.now() - f.at) / 1000)}s ago${f.signed === false ? ', sent unsigned' : ''}`
     : swc ? '; the worker reported no failed OneLake read — the open failed before any request went out'
           : '') +
    ']';
  return out;
}

// Deliberately does NOT render the signed-in address. The identity is visible in the
// browser's own account UI, and this app gets screen-shared and screenshotted; a UPN in
// the header is a needless leak. auth.getUserId() is still there for console debugging.
function showSignedIn() {
  // VS Code owns the identity: the Accounts menu signs in and out, and the extension's
  // Switch Microsoft Account command changes which one is used. A second, half-working
  // set of controls in here — the sign-out below navigates the page, which a webview has
  // nowhere to navigate to — is worse than none.
  if (HOST_VSCODE) return;
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
  if (HOST_VSCODE) return;   // see showSignedIn
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
  // No registration named yet: a Sign-in button here could only throw, so ask for the one
  // thing that's missing instead. `onDone` is dropped on purpose — saving a registration
  // reloads the page (MSAL caches state per clientId), so nothing here survives to run it;
  // the reloaded gate starts over with a clientId in hand.
  if (!cfg.clientId) {
    gateMsg('OneLake Studio signs in through an Entra app registration in your own tenant. Name one to continue.');
    showByoForm();
    return;
  }
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

// A failed sign-in that's really "this registration has no Azure Storage consent" gets the
// form handed over, since the usual cause is a registration missing that permission — or
// the wrong one pasted in.
function showAuthFailure(e) {
  const why = describeAuthError(e);
  gateMsg('Sign-in failed: ' + why, true);
  setStatus('Sign-in failed: ' + why, 'error');
  if (isConsentError(e)) showByoForm();
  console.error(e);
}

// A foot link is an offer to open a block; once that block is open, with its own heading
// and its own docs link, the offer is just noise. (Guarded: showOpenInTab rebuilds the
// gate without the foot options.)
function hideOption(id) {
  const a = $(id);
  if (a) a.hidden = true;
}

// The form that names the registration to sign in with — the front door, not a workaround.
// Shown on first use, and again from the "Use a different app registration" link.
function showByoForm() {
  hideOption('byoLink');
  if ($('byoBox')) { $('byoClientId').focus(); return; }
  const box = document.createElement('div');
  box.id = 'byoBox';
  box.className = 'gateBox';
  box.innerHTML = `
    <h4>Your app registration</h4>
    <div>A single-page-application registration in your tenant, with the delegated
      permission <code>Azure Storage → user_impersonation</code>.
      <a href="${DOCS}#signing-in" target="_blank" rel="noopener">How to create one</a>
      — about two minutes, and there's a CLI one-liner.</div>
    <div class="byoRow">
      <input id="byoClientId" placeholder="Application (client) ID" spellcheck="false" />
      <input id="byoTenantId" placeholder="Directory (tenant) ID — or blank" spellcheck="false" />
    </div>
    <div class="byoRow">
      <button id="byoUseBtn" class="primary">Use it</button>
      ${cfg.byo ? '<button id="byoResetBtn">Use a different one</button>' : ''}
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

// Name the registration in play, and offer to swap it. Pasting the wrong GUID is easy and
// the resulting Entra errors don't say which app they mean — so show it. That also makes
// the "use your own" option below redundant.
function showByoBanner() {
  if ($('byoBanner')) return;
  hideOption('byoLink');
  const el = document.createElement('div');
  el.id = 'byoBanner';
  el.className = 'gateFoot';
  el.innerHTML = `Signing in through <code>${escapeHtml(cfg.clientId)}</code> — ` +
    '<a id="byoBannerReset">use a different registration</a>.';
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
//
// The VS Code host overrides the URL with the copy packaged inside the extension: a
// webview's CSP has no reason to allow GitHub, the packaged file is the one that
// documents the installed version, and it needs no network.
const README_URL = cfg.readmeUrl ||
  'https://raw.githubusercontent.com/djouallah/onelake_studio/refs/heads/main/README.md';
const README_SQL = `select content from read_text('${README_URL}')`;

// Every handler, wired before anything is awaited. It used to happen after engine.init(),
// which was also what kept connect()/runQuery() off a null engine; that guarantee now
// comes from awaiting engineReady inside those two, so the controls can exist during boot.
function wireUi() {
  $('connectBtn').onclick = () => connect({ force: true });
  $('wsSelect').addEventListener('input', onWorkspaceInput);
  $('wsSelect').addEventListener('change', onWorkspaceInput);
  $('wsSelect').addEventListener('input', openWsMenu);
  $('wsSelect').addEventListener('focus', openWsMenu);
  $('wsSelect').addEventListener('keydown', onWsKey);
  // Safe because the rows pick on mousedown-with-preventDefault, so choosing one never
  // takes the focus away in the first place.
  $('wsSelect').addEventListener('blur', hideWsMenu);
  $('itemSelect').onchange = () => connect();
  $('tabTables').onclick = () => switchPane('tables');
  $('tabFiles').onclick = () => switchPane('files');
  // Wrapped, not passed directly: onclick hands the handler a MouseEvent, which would
  // land in runQuery's options argument.
  $('runBtn').onclick = () => runWithTable();
  // Disable on the way out: the load ends at its next checkpoint, not this instant, and a
  // button that still invites clicking implies the first one didn't take.
  $('stopBtn').onclick = () => {
    engine.cancelLoad();
    $('stopBtn').disabled = true;
    setStatus('Stopping…');
  };
  // Preview means "show me this thing", so it always pays for the table if it has to.
  $('previewBtn').onclick = () => {
    const ident = activeIdent || (activeTableRef && identOf(activeTableRef));
    if (!ident) return;
    runWithTable(previewSql(ident, activeDocEligible));
  };
  $('csvBtn').onclick = downloadActive;
  $('docPretty').onclick = () => {
    if (docMode === 'pretty' || !lastResult) return;
    docMode = 'pretty';
    showDoc(docOf(lastResult));   // renderer module already loaded — instant
  };
  $('docRaw').onclick = () => {
    docMode = 'raw';
    setDocTabs();
    $('docView').hidden = true;
    $('resultsTable').hidden = false;
  };
  $('viewData').onclick = onDataTab;
  $('viewStats').onclick = showStats;
  $('sqlEditor').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runWithTable(); }
  });
  // SQL written before a sign-in redirect comes back here after the round trip.
  try {
    const stash = sessionStorage.getItem(PENDING_SQL_KEY);
    sessionStorage.removeItem(PENDING_SQL_KEY);
    if (stash && !$('sqlEditor').value) $('sqlEditor').value = stash;
  } catch (_) {}
}

// engineReady, not engine.init(), because runQuery() below awaits engineReady and this
// function calls runQuery — awaiting its own promise would deadlock the boot.
async function startEngine() {
  await engineReady;
  engineUp = true;
  $('runBtn').disabled = false;   // SQL needs the engine, not a lakehouse
  let landingFailed = false;
  if (!$('sqlEditor').value) {
    // Fresh visit: show the README as the landing content. The stash branch in wireUi
    // means a sign-in round trip never loses the user's SQL to this. Offline or
    // blocked, runQuery reports its error — the boot message below replaces it,
    // because a failed docs fetch must not read as a broken app.
    $('sqlEditor').value = README_SQL;
    landingFailed = !await runQuery();
  }
  // The auth stage runs alongside this one now, so it may already have said something
  // truer — "N workspace(s)" beats "sign in to browse OneLake". Only claim the line when
  // there's no session to talk about.
  //
  // ...unless the landing query left a red error on the bar. That claim was only ever
  // true for the browser, where a signed-in session means the auth stage spoke; in the
  // webview the session is implicit and always present, so nothing overwrote the docs
  // fetch's failure and "Query error" was the first thing a new user saw. A failed
  // README is not a broken app, and must not be reported as one in either host.
  if (!signedIn || landingFailed) {
    const where = HOST_VSCODE ? 'pick a table in the OneLake sidebar'
                              : 'sign in to browse OneLake';
    setStatus(`DuckDB ready — run SQL now, or ${where}.` +
      (landingFailed ? ' (The welcome page could not be read — the engine itself is fine.)' : ''),
      landingFailed ? 'warn' : 'ok');
  }
}

// After a OneLake session exists (silent on boot, or interactive): unlock browsing.
async function afterSignIn() {
  signedIn = true;
  $('authGate').style.display = 'none';
  showSignedIn();
  // In the editor the sidebar tree owns browsing and lists OneLake itself. A second
  // account-wide workspace listing here would be a slow round trip on every panel open,
  // to fill a picker that is not on screen.
  if (HOST_VSCODE) return;
  $('wsSelect').placeholder = 'Loading workspaces…';
  if (!lakehouse)
    $('tableList').innerHTML = '<div class="hint">Pick a workspace, then an item to browse.</div>';
  await loadCatalog();
}

// ---------------------------------------------------------------------------
// Catalog — workspaces, then the lakehouses/warehouses inside one.
// ---------------------------------------------------------------------------
// Both levels come from the OneLake DFS API on the storage token we already hold, so
// browsing costs no extra Entra permission and no second consent prompt.

// OneLake listings run for whole seconds; saying how many turns "is it stuck?" into an
// answer. Queries report "in N ms" (runQuery) — listings read better in seconds.
const fmtElapsed = ms => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

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

// The workspace box is a search box: free text the user types, matched against the list
// as they type. Its value is a CLAIM, not a selection — everything downstream goes
// through canonicalWs() to turn it into a real workspace name (exact first, then
// case-insensitive) or null.
//
// The suggestions below it are drawn here rather than by a <datalist>, whose popup the
// browser hands to the OS: white, page-tall and offset from the box it belongs to.
const WS_MENU_MAX = 60;   // the menu scrolls; drawing 500 rows nobody reads does not help
let wsNames = [];
let lastWs = '';       // the workspace whose items are currently loaded, to dedupe events
let wsShown = [];      // the names the menu is currently listing
let wsActive = -1;     // highlighted row, -1 = none (typing beats arrowing)

function canonicalWs(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (wsNames.includes(s)) return s;
  const lower = s.toLowerCase();
  return wsNames.find(n => n.toLowerCase() === lower) || null;
}

function fillWorkspaces(names) {
  wsNames = names;
  const el = $('wsSelect');
  el.disabled = !names.length;
  el.placeholder = names.length ? `Workspace (${names.length}) — type to search` : 'No workspaces';
  hideWsMenu();
}

function openWsMenu() {
  const el = $('wsSelect');
  if (el.disabled) return;
  const q = el.value.trim().toLowerCase();
  wsShown = (q ? wsNames.filter(n => n.toLowerCase().includes(q)) : wsNames).slice(0, WS_MENU_MAX);
  wsActive = -1;
  const menu = $('wsMenu');
  menu.textContent = '';
  if (!wsShown.length) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = 'No workspace matches';
    menu.appendChild(none);
  }
  for (const [i, n] of wsShown.entries()) {
    const row = document.createElement('div');
    row.textContent = n;
    // mousedown, not click: the input's blur fires first and would take the menu — and
    // this row — down before the click ever landed on it.
    row.addEventListener('mousedown', e => { e.preventDefault(); pickWs(i); });
    menu.appendChild(row);
  }
  menu.hidden = false;
}

function hideWsMenu() {
  $('wsMenu').hidden = true;
  wsActive = -1;
}

function markWsActive() {
  const rows = $('wsMenu').children;
  for (const [i, row] of [...rows].entries()) row.classList.toggle('on', i === wsActive);
  if (rows[wsActive]) rows[wsActive].scrollIntoView({ block: 'nearest' });
}

function pickWs(i) {
  const name = wsShown[i];
  if (!name) return;
  $('wsSelect').value = name;
  hideWsMenu();
  onWorkspaceInput();
}

// Arrows walk the menu, Enter takes the highlighted row, Escape puts it away. With no row
// highlighted, Enter falls through to the 'change' handler — which resolves whatever was
// typed — so a name typed in full still works without ever opening the menu.
function onWsKey(e) {
  if (e.key === 'Escape') { hideWsMenu(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if ($('wsMenu').hidden) openWsMenu();
    if (!wsShown.length) return;
    wsActive = e.key === 'ArrowDown'
      ? (wsActive + 1) % wsShown.length
      : (wsActive <= 0 ? wsShown.length : wsActive) - 1;
    markWsActive();
    return;
  }
  if (e.key === 'Enter' && wsActive >= 0) { e.preventDefault(); pickWs(wsActive); }
}

// Typing fires 'input', Enter/blur fire 'change', and pickWs calls this directly. One
// handler serves all three — act only when the text resolves to a real workspace we
// aren't already showing, so keystrokes along the way cost nothing.
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
    const t0 = performance.now();
    const names = await engine.listWorkspaces();
    fillWorkspaces(names);
    setStatus(`${names.length} workspace(s) in ${fmtElapsed(performance.now() - t0)}. ` +
      'Type to search, pick one to browse its tables.', 'ok');

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

// The last click wins here too. Discovery is network-bound and the pickers stay clickable
// throughout, so a listing that resumes after a NEWER workspace/item choice must not touch
// the screen — two fast item clicks otherwise paint whichever listing finished LAST, not
// whichever was clicked last. Same ticket pattern as selSeq below, shared between the two
// entry points because a workspace change must supersede an in-flight item connect and
// vice versa. Superseded listings still finish their fetches; they just stand down silently.
let catSeq = 0;

async function onWorkspaceChange() {
  const my = ++catSeq;
  const workspace = canonicalWs($('wsSelect').value) || '';
  lastWs = workspace;
  const sel = $('itemSelect');
  activeIdent = null;
  setActiveStats(null);
  activeTableRef = null; tableStage = 'none';
  lastResult = null;
  lastTables = null;
  lastTableCount = '';
  // This is the point where the previous lakehouse is left behind — and because it also
  // clears `lakehouse`, connect() can no longer tell that the target changed. Hand the
  // engine's views and registered files back here instead.
  // Teardown of the old item's views is queue work, the item listing is pure fetch — they
  // overlap, and the Promise.all below means nothing is painted until both are done.
  // `lakehouse` goes null before the first await so a connect() arriving mid-teardown
  // can't see the old item and start a second reset of it.
  const resetP = lakehouse ? engine.reset() : null;
  lakehouse = null;
  setPaneTabs('');   // no item picked: the switch goes back to offering both panes
  $('tableList').innerHTML = '<div class="hint">Pick a lakehouse, warehouse or mirrored item.</div>';
  $('tableCount').textContent = '';
  if (!workspace) {
    sel.disabled = true;
    fill(sel, [], 'Select a workspace first');
    if (resetP) await resetP;   // a teardown failure must not go unobserved
    return;
  }
  sel.disabled = true;
  fill(sel, [], 'Loading…');
  try {
    setStatus(`Listing items in ${workspace}…`);
    const t0 = performance.now();
    const [items] = await Promise.all([engine.listItems(workspace), resetP]);
    if (my !== catSeq) return;
    fill(sel, items.map(i => ({
      value: i.name,
      label: `${i.name.replace(/\.[^.]+$/, '')}  ·  ${kindLabel(i.kind)}`,
    })), items.length ? `Item (${items.length})` : 'Nothing with tables in it');
    sel.disabled = !items.length;
    setStatus(items.length
      ? `${items.length} item(s) with tables in ${workspace}, listed in ${fmtElapsed(performance.now() - t0)}.`
      : `${workspace} has nothing with tables in it.`, items.length ? 'ok' : '');
  } catch (e) {
    if (my !== catSeq) return;
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
// Views, registered files and helper tables from the previous lakehouse are dead the moment
// we point somewhere else, and they cost WASM memory for as long as the page lives. Cache
// entries are keyed per lakehouse so a stale one can't be served, but the DuckDB objects
// behind them still have to be given back. Returns the teardown promise rather than awaiting
// it — every caller has something to overlap it with, and none may leave it unobserved.
function leaveLakehouse() {
  activeIdent = null;
  setActiveStats(null);
  activeTableRef = null; tableStage = 'none';
  lastResult = null;
  $('activeTable').textContent = 'No table selected';
  return engine.reset();
}

async function connect({ force = false } = {}) {
  const my = ++catSeq;
  const workspace = canonicalWs($('wsSelect').value), item = $('itemSelect').value;
  if (!workspace || !item) return;
  await engineReady;   // the picker can be used before DuckDB has finished booting
  if (my !== catSeq) return;

  // Views, registered files and helper tables from the previous lakehouse are dead the
  // moment we point somewhere else, and they cost WASM memory for as long as the tab
  // lives. Cache entries are keyed per lakehouse so a stale one can't be served, but the
  // DuckDB objects behind them still have to be given back.
  const moved = lakehouse && (lakehouse.workspace !== workspace || lakehouse.item !== item);
  // Teardown drains serialized DROPs for every open table before; the listing is pure
  // fetch and never touches the worker or its queue, so the two overlap. The Promise.all
  // below keeps the old invariant: the sidebar is never painted (no table is clickable)
  // until the teardown has finished, and either failure lands in the same catch with
  // nothing left unobserved.
  const resetP = (force || moved) ? leaveLakehouse() : null;
  lakehouse = { workspace, item };
  setPaneTabs(item);   // before the pane is rendered below: it can move `pane` off Files

  $('connectBtn').disabled = true;
  setStatus(`Listing tables in ${lakehouse.workspace}/${lakehouse.item}…`);
  $('tableList').innerHTML = '<div class="hint">Loading…</div>';
  try {
    const t0 = performance.now();
    const [tables] = await Promise.all([engine.listTables(lakehouse), resetP]);
    if (my !== catSeq) return;
    const took = fmtElapsed(performance.now() - t0);
    lastTables = tables;
    lastTableCount = String(tables.length);
    if (pane === 'tables') { renderTableList(tables); $('tableCount').textContent = lastTableCount; }
    else { await renderFileTree(); if (my !== catSeq) return; }
    setStatus(`${tables.length} table(s) in ${lakehouse.item}, listed in ${took}.`, 'ok');
  } catch (e) {
    if (my !== catSeq) return;
    $('tableList').innerHTML = '<div class="hint">Could not list tables.</div>';
    setStatus('List failed: ' + e.message, 'error');
    console.error(e);
  } finally {
    // A stale connect's cleanup must not re-enable the button under the newer one's listing.
    if (my === catSeq) $('connectBtn').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Files/ tree — the unmanaged half of a lakehouse
// ---------------------------------------------------------------------------
// Listed one directory at a time, on expand: a lakehouse's Files/ can be arbitrarily
// deep and wide, so a recursive listing up front would be slow for no benefit.
// Only a lakehouse has a Files/ pane behind the switch (hasFilesArea says why). Kind is
// the item name's suffix, the same thing listItems matched on, so no extra call is
// needed to know it.
//
// `item` empty means nothing is picked yet — leave the switch as it is rather than
// flickering it away between a workspace change and the item that follows.
function setPaneTabs(item) {
  const files = !item || hasFilesArea(item);
  $('tabFiles').hidden = !files;
  $('paneTabs').classList.toggle('solo', !files);
  // A warehouse picked while the Files pane was open must not leave that pane showing.
  if (!files && pane === 'files') {
    pane = 'tables';
    $('tabTables').classList.add('active');
    $('tabFiles').classList.remove('active');
  }
}

function switchPane(which) {
  pane = which;
  $('tabTables').classList.toggle('active', which === 'tables');
  $('tabFiles').classList.toggle('active', which === 'files');
  if (!lakehouse) {
    $('tableList').innerHTML = signedIn
      ? '<div class="hint">Pick a workspace, then an item to browse.</div>'
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
    const isImage = !e.isDir && !e.queryable && IMAGE_EXTS.has(fileExt(e.name));
    row.className = 'fileItem' + (!e.isDir && !e.queryable && !isImage ? ' plain' : '');
    row.style.paddingLeft = (0.75 + depth * 0.8) + 'rem';
    const caret = e.isDir ? '▸' : '';
    row.innerHTML = `<span class="caret">${caret}</span><span class="name">${escapeHtml(e.name)}</span>` +
      (e.isDir ? '' : `<span class="size">${escapeHtml(engine.fmtBytes(e.bytes))}</span>`);
    // A GUID data file is longer than the sidebar however wide it's dragged, so the row
    // always carries its own full name.
    row.title = e.name;
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
    } else if (isImage) {
      row.onclick = () => selectImage(row, e);
    } else {
      row.title = e.name + ' — no reader for this file type';
    }
  }
}

// The last click wins. Loads run for seconds and stay clickable throughout, so a load
// that resumes after a NEWER selection must not touch the screen — that is how a
// dim_duid preview ended up rendered under dbt.log's name while a third table was
// still loading underneath. Each selection takes a ticket; after every await, a stale
// ticket means stand down silently (the engine side already cancelled the stale load —
// this guards the UI writes that happen after the await returns).
let selSeq = 0;

async function selectFile(row, file) {
  const my = ++selSeq;
  document.querySelectorAll('.fileItem.active').forEach(el => el.classList.remove('active'));
  row.classList.add('active');
  $('activeTable').textContent = file.name;
  // Only the plain-text formats are read as a document (one row per line, so a small file
  // comes back as a single multiline cell). Every other reader — parquet, csv, json, avro,
  // xlsx, a database file, a zip entry — produces a TABLE, and a table with one cell in it
  // is still a table.
  activeFile = file;
  activeDocExt = fileExt(file.name);
  activeDocEligible = isTextExt(activeDocExt);
  setActiveStats(null);          // a file is not a table; no snapshot behind it
  activeTableRef = null; tableStage = 'none';
  // Same rule as selectTable: no stale rows or stale SQL under this file's name.
  clearResults(`(loading ${file.name}…)`);
  $('sqlEditor').value = `-- loading ${file.name}…`;
  setBusy(true, { stoppable: true });
  try {
    const info = await engine.loadFile(lakehouse, file);
    if (my !== selSeq) return;
    activeIdent = info.ident;
    // A database file with no tables attaches but leaves nothing to preview.
    if (info.ident) {
      $('sqlEditor').value = previewSql(info.ident, activeDocEligible);
      $('previewBtn').disabled = false;
      $('runBtn').disabled = false;
      reportLoad(info, await runQuery({ doc: activeDocEligible, ext: activeDocExt }));
    } else {
      reportLoad(info, true);
    }
  } catch (e) {
    if (my !== selSeq) return;
    if (e.cancelled) {
      clearResults('(no result — loading stopped)');
      setStatus(`Stopped loading ${file.name}.`);
      row.classList.remove('active');
    } else {
      clearResults('(no result — the file could not be opened)');
      setStatus('Load failed: ' + explainRead(e.message), 'error');
      console.error(e);
    }
  } finally {
    // A stale selection's teardown must not flip the busy state out from under the
    // newer selection's own load.
    if (my === selSeq) setBusy(false);
  }
}

// The image on screen holds one object URL. clearResults() is the only place the <img>
// leaves the DOM, so it is the only place the URL is revoked.
let imageUrl = null;

// An image never goes through DuckDB: fetch the bytes with auth and show them over a
// blob URL. A plain <img src="https://onelake.dfs…"> would go out as a no-cors request,
// which the service worker refuses to sign, so it would 401.
async function selectImage(row, file) {
  const my = ++selSeq;
  document.querySelectorAll('.fileItem.active').forEach(el => el.classList.remove('active'));
  row.classList.add('active');
  $('activeTable').textContent = file.name;
  activeFile = file;
  activeIdent = null;            // no table behind this: Preview/Run stay disabled
  setActiveStats(null);
  activeTableRef = null; tableStage = 'none';
  activeDocEligible = false;
  clearResults(`(loading ${file.name}…)`);
  $('sqlEditor').value = `-- ${file.name} is an image — shown in the results pane`;
  setBusy(true);                 // not stoppable: one plain fetch
  try {
    const bytes = await engine.readFileBytes(lakehouse, file);
    if (my !== selSeq) return;
    clearResults();              // revokes the previous image's URL, bumps docSeq
    imageUrl = URL.createObjectURL(
      new Blob([bytes], { type: IMAGE_EXTS.get(fileExt(file.name)) }));
    $('docView').innerHTML = `<img src="${imageUrl}" alt="${escapeHtml(file.name)}">`;
    $('docView').hidden = false;
    $('csvBtn').disabled = false;
    setExportLabel();            // "Download file" — the image is a file on screen
    setStatus(`${file.name} — ${engine.fmtBytes(bytes.length)}.`, 'ok');
  } catch (e) {
    if (my !== selSeq) return;
    clearResults('(no result — the image could not be read)');
    setStatus('Load failed: ' + explainRead(e.message), 'error');
    console.error(e);
  } finally {
    if (my === selSeq) setBusy(false);
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
      row.className = 'tableItem';
      row.title = t.table;
      row.innerHTML = `<span class="name">${escapeHtml(t.table)}</span>`;
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
  // Without the service worker controlling the page, DuckDB's OneLake reads go out
  // unsigned and every one 401s — the load cannot succeed, so say why up front instead
  // of failing on the first footer read with a message that blames the file. The two
  // ways a page ends up here: DevTools with "Bypass for network" checked, and a hard
  // reload (which bypasses the worker for that one page load).
  // Not in the webview, where there is no service worker by design and the extension's
  // loopback proxy signs the reads instead. This passes there today only because
  // `navigator.serviceWorker` happens to be undefined — one VS Code release exposing a
  // dormant container would make every table refuse to open with a paragraph about
  // DevTools.
  if (!HOST_VSCODE && 'serviceWorker' in navigator && !navigator.serviceWorker.controller) {
    setStatus(
      'Cannot open tables: the service worker is not controlling this page, so OneLake ' +
      'reads would go out unsigned and fail. Do a normal reload (F5) to fix it. If DevTools ' +
      'is open, make sure "Bypass for network" is unchecked under Application → Service ' +
      'Workers; a hard reload (Ctrl+Shift+R) also causes this for one page load.', 'error');
    return;
  }
  const my = ++selSeq;
  document.querySelectorAll('.tableItem.active').forEach(el => el.classList.remove('active'));
  row.classList.add('active');
  $('activeTable').textContent = t.schema ? `${t.schema}.${t.table}` : t.table;
  activeFile = null;            // a table has no single file to hand back
  activeDocEligible = false;    // ...and is a table, whatever shape the preview comes back
  activeDocExt = '';
  activeIdent = null;           // no view exists yet — nothing is bound until asked for
  activeTableRef = t;
  tableStage = 'none';
  // The previous table's rows must not sit on screen under the new table's name — that
  // reads as the app showing the wrong data. The editor gets the same treatment.
  clearResults(`(no rows read yet — open the Data tab)`);
  setActiveStats(null);   // the OLD table's stats must not show under the new name
  $('sqlEditor').value = `-- reading ${$('activeTable').textContent} metadata…`;
  // Stoppable. This used to be one small request that was over before a Stop button could
  // render — but the catalog resolve now retries while Fabric writes a table's Iceberg
  // metadata, and an unstoppable minute and a half is exactly what the generation counter
  // exists to prevent.
  setBusy(true, { stoppable: true });
  try {
    // Selecting a table reads its METADATA and nothing else — no manifests, no parquet,
    // no bytes of data. That is the whole point: browsing a lakehouse should not cost
    // anything, and the tiers below spend only when the user asks to see rows.
    const info = await engine.statTable(lakehouse, t);
    if (my !== selSeq) return;
    // Re-selecting a table that is still bound gets its full info back, ident and all;
    // a fresh selection gets ident null, which is what keeps it unbound.
    activeIdent = info.ident;
    tableStage = info.stage === 'loaded' ? 'loaded' : 'stats';
    setActiveStats(info);
    showStats();                    // statistics ARE the landing view for a table now
    // SQL that will work the moment the table is bound; Run binds it (see needsBind).
    // The buttons are left to setBusy(false) in the finally — one owner for that state.
    $('sqlEditor').value = previewSql(identOf(t), false);
    setStatus(engine.describeLoad(info));
  } catch (e) {
    if (my !== selSeq) return;
    reportTableError(e, row);
  } finally {
    // A stale selection's teardown must not flip the busy state out from under the
    // newer selection's own load.
    if (my === selSeq) setBusy(false);
  }
}

// The identifier a table's view WILL have, derivable without opening anything — the
// engine builds the same string from the same two parts.
const identOf = t => t.schema ? `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`
                              : quoteIdent(t.table);

function reportTableError(e, row) {
  // A load the user stopped is not a failure, and calling it one in red is how a UI
  // teaches people to distrust its errors.
  if (e.cancelled) {
    clearResults('(no result — loading stopped)');
    setStatus(`Stopped loading ${$('activeTable').textContent}.`);
    if (row) row.classList.remove('active');
  } else {
    clearResults('(no result — the table could not be opened)');
    setStatus('Load failed: ' + explainRead(e.message), 'error');
    console.error(e);
  }
}

// Tier 2 — the Data tab's first click. Rows from ONE parquet file, so "what does this
// data look like" costs a single footer and a single row group instead of the table.
async function peekIntoView() {
  const my = selSeq;
  setBusy(true, { stoppable: true });
  try {
    const out = await engine.peekTable(lakehouse, activeTableRef);
    if (my !== selSeq) return;
    // A merge-on-read table has no honest cheap preview: reading one file raw would show
    // rows its delete files have removed. Pay for the real open rather than lie.
    if (out.suppressed) {
      setStatus(`${$('activeTable').textContent} has delete files, so a single-file preview ` +
                `could show deleted rows — opening the whole table instead…`, 'warn');
      await runWithTable();
      return;
    }
    tableStage = 'peek';
    docAllowed = false;             // a peek is a table, whatever shape it comes back
    renderResults(out);             // this lands the pane in the Data view by itself
    // A one-file table would otherwise read "1 of 1 file(s) — the other 0 were not read".
    const rest = out.fileCount - 1;
    setStatus(`${out.rows.length} row(s) from ${rest ? `1 of ${out.fileCount} file(s) — the other ` +
              `${rest} ${rest === 1 ? "was" : "were"} not read` : "the table's only file"}. ` +
              `Run a query to read the whole table.`);
  } catch (e) {
    if (my !== selSeq) return;
    reportTableError(e);
  } finally {
    if (my === selSeq) setBusy(false);
  }
}

// Tier 3 — every data file registered behind a real view, which is what SQL needs.
// Returns the info, or null if it could not be bound. The metadata and the manifest walk
// are already paid for by the tiers above; this adds the per-file registrations.
async function bindTable() {
  if (!activeTableRef) return null;
  if (tableStage === 'loaded') return activeInfo;
  const my = selSeq;
  setBusy(true, { stoppable: true });
  try {
    const info = await engine.loadTable(lakehouse, activeTableRef, {
      // Rows from the first file while the rest of a many-file open still runs.
      onPeek: (out, fileCount) => {
        if (my !== selSeq) return;
        docAllowed = false;
        renderResults(out);
        setStatus(`Quick look at the first of ${fileCount} file(s) — still opening…`);
      } });
    if (my !== selSeq) return null;
    activeIdent = info.ident;
    tableStage = 'loaded';
    freshLoad = info;               // owed a report once the caller's query lands
    setActiveStats(info);           // richer now: real columns, delete counts, warnings
    return info;
  } catch (e) {
    if (my !== selSeq) return null;
    reportTableError(e);
    return null;
  } finally {
    if (my === selSeq) setBusy(false);
  }
}

// Run SQL against the selected table, binding it first if the SQL actually needs it.
// `sql` replaces the editor contents when given (the Preview button); otherwise whatever
// the user wrote is run as-is.
async function runWithTable(sql) {
  if (sql != null) $('sqlEditor').value = sql;
  if (needsBind()) { if (!await bindTable()) return; }
  const ok = await runQuery({ doc: activeDocEligible, ext: activeDocExt });
  if (freshLoad) { reportLoad(freshLoad, ok); freshLoad = null; }
}

// Whether the editor's SQL requires the selected table to be bound. `SELECT 42` with a
// table selected must not register a single file — that would be spending money on a
// query that never mentions the table.
function needsBind() {
  return activeTableRef && tableStage !== 'loaded' &&
         sqlNeedsTable($('sqlEditor').value, activeTableRef.table);
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
// A table gets the first hundred rows; a text file gets ALL of it. The file is downloaded
// whole either way (there is nothing to range-read in a .sql), and a LIMIT here would cut
// the document silently — Pretty would render the first hundred lines of a file as if they
// were the file. The engine's own row cap still applies and still says so.
const previewSql = (ident, whole) => `SELECT * FROM ${ident}` + (whole ? '' : ' LIMIT 100');

// `doc` says whether a document view may be offered for this result at all. It defaults
// to true because hand-written SQL is where read_text() lives; the two callers that know
// they are previewing a TABLE (selectTable, and selectFile for every tabular format) pass
// false, so a one-column preview of one can never be mistaken for a document.
async function runQuery({ doc = true, ext = '' } = {}) {
  const sql = $('sqlEditor').value;
  // Queries run through send() now, so a query is stoppable too — and the preview inside
  // selectTable is a query, which is where the wait actually was.
  setBusy(true, { stoppable: true });
  docAllowed = doc;
  docSourceExt = ext;
  let t0 = performance.now();
  try {
    await engineReady;   // Ctrl+Enter is live before the engine is
    t0 = performance.now();   // ...and waiting for it is not query time
    const res = await engine.runSql(sql);
    renderResults(res);
    lastResult = res;
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
    setExportLabel();
    return true;
  } catch (e) {
    // The pane is not a scratchpad of whatever last worked. Leaving the previous result up
    // is how a JSON file from another lakehouse ended up on screen under a .sql file's name.
    // A stopped query clears the same way but is not an error — and when it was stopped by
    // the user picking another table, that table's own status must not be overwritten.
    if (e.cancelled) {
      clearResults('(no result — query stopped)');
      // Say so. Without this the status line kept whatever the Stop button had written
      // and sat on "Stopping…" forever, because the caller skips its own message when the
      // query failed. A load that supersedes this one overwrites it a moment later.
      setStatus('Stopped.');
      return false;
    }
    clearResults('(no result — the query failed)');
    setStatus('Query error: ' + explainRead(e.message), 'error');
    console.error(e);
    return false;
  } finally {
    setBusy(false);
  }
}

// Column types live in the header cells, under the names — an empty result still shows
// the shape of what was asked for, which is what the old schema strip was for.
const NUMERIC_TYPE = /^(U?(TINY|SMALL|BIG|HUGE)INT|U?INTEGER|DOUBLE|FLOAT|DECIMAL)/;

// Empty the whole pane. Every path that ends without a result goes through here, so
// nothing on screen ever belongs to a query other than the current one.
function clearResults(hint = '') {
  docSeq++;              // an in-flight showDoc() must not paint over this
  // A new result belongs to the Data view; the Stats tab stays clickable (#viewBar is
  // "a table is open" state, owned by setActiveStats, and is deliberately not touched).
  viewMode = 'data';
  statsPrev = null;
  $('statsView').hidden = true;
  $('statsView').innerHTML = '';
  setViewTabs();
  $('docBar').hidden = true;
  $('docView').hidden = true;
  $('docView').innerHTML = '';
  if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = null; }
  $('resultsTable').hidden = true;
  $('resultsTable').innerHTML = '';
  $('resultsHint').hidden = !hint;
  $('resultsHint').textContent = hint;
  lastResult = null;
  $('csvBtn').disabled = true;
  setExportLabel();
}

// The document a result holds, or null if it holds none. TWO shapes qualify and both have
// to be read the same way everywhere — rendering the result and clicking back to Pretty
// took different routes, and the tab's route was the old single-cell one, so returning
// from Raw showed the first LINE of the file ("{") as the whole document.
function docOf(res) {
  if (!docAllowed || !res) return null;
  return isDocResult(res) ? res.rows[0][res.fields[0]]   // read_text(): one cell
                          : textLinesDoc(res);           // the Files tab: one row per line
}

function renderResults(res) {
  const table = $('resultsTable');
  const hint = $('resultsHint');
  // A doc view from the previous result must never survive into this one.
  clearResults();
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
  // regardless). A document result additionally gets the Pretty view on top — but only
  // when the source was something that can hold a document in the first place.
  const doc = docOf(res);
  if (doc != null) {
    $('docBar').hidden = false;
    setDocTabs();
    // docMode is a session preference, not per-query state: someone who switched to Raw
    // meant it, and having the next document flip them back to Pretty made the toggle feel
    // like it had not been pressed. Raw is already what the grid above shows.
    if (docMode === 'pretty') showDoc(doc);
  }
}

// ---------------------------------------------------------------------------
// Document view: a 1×1 multiline VARCHAR rendered as itself (docview.js) — JSON
// re-indented, markdown rendered, anything else left exactly as it came.
// Fails closed — any renderer trouble leaves the escaped grid on screen.
// ---------------------------------------------------------------------------
const DOC_KIND_TITLE = {
  json: 'Rendered as indented JSON',
  markdown: 'Rendered as markdown',
  text: 'Shown as plain text, exactly as stored',
  bim: 'Rendered as semantic model diagram',
};

async function showDoc(text) {
  const seq = ++docSeq;
  try {
    const { html, kind, mount } = await renderDocument(text, docSourceExt);
    if (seq !== docSeq || docMode !== 'pretty') return;
    $('docView').innerHTML = html;
    // Only prose gets the reading measure; code keeps the full width (see index.html).
    $('docView').classList.toggle('prose', kind === 'markdown');
    $('docView').hidden = false;
    $('resultsTable').hidden = true;
    // After unhiding, never before: a mounting renderer (the .bim diagram) measures
    // its elements, and everything inside a hidden ancestor measures 0×0.
    if (mount) mount($('docView'));
    $('docPretty').title = DOC_KIND_TITLE[kind] || '';
    setDocTabs();
  } catch (e) {
    if (seq !== docSeq) return;
    $('docBar').hidden = true;
    setStatus('Document renderer unavailable (' + e.message + ') — showing raw.', 'warn');
  }
}

function setDocTabs() {
  $('docPretty').classList.toggle('active', docMode === 'pretty');
  $('docRaw').classList.toggle('active', docMode !== 'pretty');
}

// ---------------------------------------------------------------------------
// Stats view: Data | Stats for a loaded table (#viewBar). Everything on the card
// was already fetched to open the table — rendering it is synchronous and free.
// ---------------------------------------------------------------------------
// The bar belongs to "a table is open", not to any one result, so clearResults leaves
// it alone; every path that opens something that is NOT a table hands null here.
function setActiveStats(info) {
  activeInfo = (info && info.stats) ? info : null;
  $('viewBar').hidden = !activeInfo;
  if (!activeInfo && viewMode === 'stats') showData();
}

function setViewTabs() {
  $('viewData').classList.toggle('active', viewMode === 'data');
  $('viewStats').classList.toggle('active', viewMode === 'stats');
}

// Stats covers the result surfaces rather than replacing them: whatever combination of
// hint/grid/doc was showing is put back EXACTLY on return — re-deriving it from
// renderResults' rules here is how the two would drift apart.
function showStats() {
  if (!activeInfo || viewMode === 'stats') return;
  viewMode = 'stats';
  statsPrev = ['resultsHint', 'docView', 'resultsTable', 'docBar']
    .map(id => [id, $(id).hidden]);
  for (const [id] of statsPrev) $(id).hidden = true;
  $('statsView').innerHTML = statsCardHtml(activeInfo);
  $('statsView').hidden = false;
  setViewTabs();
}

// The Data tab is where the user first asks to see rows, so it is also where the first
// data read of a table selection happens — one file, not the table (see peekIntoView).
function onDataTab() {
  if (viewMode !== 'stats') return;
  if (tableStage === 'stats' && activeTableRef) { peekIntoView(); return; }
  showData();
}

function showData() {
  if (viewMode !== 'stats') return;
  viewMode = 'data';
  $('statsView').hidden = true;
  if (statsPrev) for (const [id, h] of statsPrev) $(id).hidden = h;
  statsPrev = null;
  setViewTabs();
}

// Only what the Iceberg snapshot metadata already said — no scans, no footers, and no
// guesses: a fact the metadata doesn't carry renders as an em dash, never as "no".
function statsCardHtml(info) {
  const s = info.stats || {};
  const n = v => v == null ? '—' : Number(v).toLocaleString('en');
  const deletes = info.posDeletes || info.eqDeletes || s.totalDeleteFiles;
  const rows = [];
  rows.push(['Rows', n(info.totalRecords) +
    (deletes ? ' (physical — before delete files are applied)' : '')]);
  rows.push(['Data files', n(info.fileCount)]);
  // Before the table is bound, the only breakdown available is the snapshot's own total;
  // the position/equality split comes from the manifests, which tier 1 never reads.
  if (deletes)
    rows.push(['Delete files', info.stage === 'loaded'
      ? `${n(info.posDeletes)} position, ${n(info.eqDeletes)} equality`
      : n(s.totalDeleteFiles)]);
  rows.push(['Total size', s.totalFilesSize == null ? '—' : engine.fmtBytes(s.totalFilesSize)]);
  if (s.totalFilesSize && info.fileCount)
    rows.push(['Avg file size', engine.fmtBytes(s.totalFilesSize / info.fileCount)]);
  rows.push(['Columns', n((info.columns || []).length)]);
  rows.push(['Partitioning', (s.partitionColumns || []).length ? s.partitionColumns.join(', ') : 'none']);
  rows.push(['Compression', s.codec || '—']);
  rows.push(['Last write', s.snapshotTs == null ? '—' :
    new Date(s.snapshotTs).toLocaleString('en') + (s.operation ? ` (${s.operation})` : '')]);
  rows.push(['Snapshots', n(s.snapshotCount || null)]);
  if (s.formatVersion != null) rows.push(['Format', `Iceberg v${s.formatVersion}`]);
  // Probed: the conversion doesn't write this property today, so the line only appears
  // if that ever changes. Absence is unknown, not "no" — no line is the honest render.
  if (s.vorderProp != null) rows.push(['V-Order', s.vorderProp ? 'enabled' : 'disabled']);

  // The schema is free at every tier: from the Iceberg metadata before the table is
  // bound, from DESCRIBE after. Both arrive as {name, type}.
  const cols = info.columns || [];
  const colList = cols.length
    ? '<h3>Columns</h3><table>' + cols.map(c =>
        `<tr><th>${escapeHtml(c.name)}</th><td>${escapeHtml(c.type || '')}</td></tr>`).join('') +
      '</table>'
    : '';
  const note = info.stage === 'loaded'
    ? 'From the Iceberg snapshot metadata — nothing was scanned to show this.'
    : 'From the Iceberg snapshot metadata — no data files have been read yet. ' +
      'Open Data for rows from one file, or Preview to read all of them.';
  return '<table>' + rows.map(([k, v]) =>
    `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`).join('') +
    '</table>' + colList + `<p class="statsNote">${escapeHtml(note)}</p>`;
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------
// The export button does whichever of two things the thing on screen actually is. A grid
// of rows exports as CSV; a FILE opened from the tree downloads as that file — a .bim
// asked for is a .bim, not its lines wrapped in CSV quoting. An image counts as a file
// too: imageUrl is non-null exactly while an <img> is on screen.
function exportIsFile() {
  return !!(activeFile && (imageUrl || (lastResult && docOf(lastResult) != null)));
}

function setExportLabel() {
  const btn = $('csvBtn');
  const file = exportIsFile();
  btn.textContent = file ? 'Download file' : 'Download CSV';
  btn.title = file ? `Save ${activeFile.name} exactly as it is stored` : '';
}

async function downloadActive() {
  if (!exportIsFile()) return downloadCsv();
  const btn = $('csvBtn');
  btn.disabled = true;
  try {
    // Straight from OneLake, not rebuilt from the rows: the reader dropped the CR of every
    // CRLF and a file's final newline, so the grid can no longer produce the exact bytes.
    const bytes = await engine.readFileBytes(lakehouse, activeFile);
    save(new Blob([bytes], { type: 'application/octet-stream' }), activeFile.name);
    setStatus(`Downloaded ${activeFile.name} (${engine.fmtBytes(bytes.length)}).`, 'ok');
  } catch (e) {
    setStatus('Download failed: ' + explainRead(e.message), 'error');
  } finally {
    btn.disabled = false;
  }
}

function save(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = basename(name);
  a.click();
  // Revoking in this same task races the download the click just started, and Firefox in
  // particular ends up saving nothing. One turn of the event loop is enough.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadCsv() {
  if (!lastResult || !lastResult.rows.length) return;
  const { fields, rows } = lastResult;
  const q = s => {
    const t = cellText(s);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [fields.map(q).join(',')];
  for (const r of rows) lines.push(fields.map(f => q(r[f])).join(','));
  save(new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }),
       ($('activeTable').textContent || 'query').replace(/[^\w.-]+/g, '_') + '.csv');
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
// Sidebar width — draggable, and remembered for the same reason the collapse state is.
// ---------------------------------------------------------------------------
// A Files/ tree bottoms out in GUID-named Iceberg data files, indented one level per
// directory: no fixed width shows those whole, so the width is the user's to set.
const SIDEBAR_W_KEY = 'onelakeStudio.sidebarWidth';
const SIDEBAR_MIN = 200;

// The results grid still needs room, so the ceiling follows the window.
const maxSidebarWidth = () => Math.max(SIDEBAR_MIN, window.innerWidth - 360);

function setSidebarWidth(px, persist) {
  const w = Math.round(Math.min(maxSidebarWidth(), Math.max(SIDEBAR_MIN, px)));
  document.documentElement.style.setProperty('--sidebarW', w + 'px');
  if (persist) { try { localStorage.setItem(SIDEBAR_W_KEY, String(w)); } catch (_) {} }
}

// Double-click the grip: widen to whatever the longest name on screen needs. A name
// ellipsizes by shrinking its own span rather than overflowing the row, so the span's
// scrollWidth is the only place its full length survives.
function fitSidebarWidth() {
  const left = $('sidebar').getBoundingClientRect().left;
  let want = SIDEBAR_MIN;
  for (const el of document.querySelectorAll('#tableList .name')) {
    const tail = el.parentElement.querySelector('.size, .tag');
    want = Math.max(want, el.getBoundingClientRect().left - left + el.scrollWidth +
      (tail ? tail.offsetWidth + 8 : 0) + 26);   // row padding + scrollbar
  }
  return want;
}

function initSidebarResize() {
  let saved = 0;
  try { saved = parseInt(localStorage.getItem(SIDEBAR_W_KEY), 10) || 0; } catch (_) {}
  if (saved) setSidebarWidth(saved, false);

  const grip = $('sidebarResizer');
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const left = $('sidebar').getBoundingClientRect().left;
    const move = ev => setSidebarWidth(ev.clientX - left, false);
    const done = ev => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', done);
      grip.removeEventListener('pointercancel', done);
      document.body.classList.remove('resizing');
      setSidebarWidth(ev.clientX - left, true);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', done);
    grip.addEventListener('pointercancel', done);
  });
  grip.addEventListener('dblclick', () => setSidebarWidth(fitSidebarWidth(), true));
  // The ceiling moves with the window, so a shrunk window must pull the sidebar back in.
  // Collapsed measures 0 — re-clamping that would throw away the width being kept for
  // when it reopens.
  window.addEventListener('resize', () => {
    const aside = $('sidebar');
    if (!aside.classList.contains('collapsed')) setSidebarWidth(aside.offsetWidth, false);
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
// `stoppable` is true for table loads, file loads and queries — all of them now run
// through cancellable statements that cancelLoad() reaches. Offering Stop for anything
// else would be a button that does nothing.
function setBusy(b, { stoppable = false } = {}) {
  const stop = $('stopBtn');
  stop.hidden = !(b && stoppable);
  if (!stop.hidden) stop.disabled = false;
  $('connectBtn').disabled = b;
  // Run needs only the engine — SELECT h3_latlng_to_cell(...) is a fine first query
  // with no lakehouse selected. Preview rewrites the editor to SELECT * FROM <active
  // table>, so it alone keeps waiting for one.
  // `engine` exists from the first line of boot now, so it says nothing about readiness —
  // engineUp is the flag that used to be implied by it being non-null.
  $('runBtn').disabled = !engineUp || b;
  // Live as soon as something is selected — a table selected but not yet bound very much
  // included, since binding it is exactly what this button is for.
  $('previewBtn').disabled = !(activeIdent || activeTableRef) || b;
}

// ---------------------------------------------------------------------------
// Boot: paint the UI, then run the engine and the silent session check side by side.
// ---------------------------------------------------------------------------
// Neither stage is quick — DuckDB is a wasm bundle plus four extensions off a CDN, and
// MSAL's ssoSilent is an iframe round trip to Microsoft that a visitor with no session
// there pays a full timeout for. Running them in series put the header's sign-in button
// (static DOM that needs neither) behind both, ~3.5s on a warm cache and ~14s cold with
// no Microsoft session. Nothing in the auth stage touches DuckDB: listWorkspaces and
// listItems are plain authed fetches, and the two calls that do need the engine —
// connect() and runQuery() — await engineReady themselves.
const EMBEDDED = window.self !== window.top;   // inside an embedding iframe?
$('byoLink').onclick = () => showByoForm();
$('gateClose').onclick = () => { $('authGate').style.display = 'none'; };
initSidebarToggle();
initSidebarResize();
// The staleness poller is a browser question — GitHub Pages caches for ten minutes, and
// a webview has no server to ask. But WHICH build is running is everyone's question: a
// Marketplace install, a sideloaded vsix and an F5 checkout look identical from inside,
// and "is it even running my fix?" once cost an hour of chasing a bug in code that was
// not there. The stamp shows everywhere — "dev" from a checkout, a commit otherwise.
showVersion();
if (!HOST_VSCODE) {
  checkForNewBuild();
  setInterval(checkForNewBuild, VERSION_RECHECK_MS);
}
wireUi();
// Painted before either stage starts. If the silent check turns out to find a session,
// afterSignIn swaps this for "Signed in" — and closes the gate, if it was opened in the
// meantime, so an early click on it costs nothing.
showSignedOut();
// Both origins are normally absent, and createEngine's defaults address OneLake directly.
// The VS Code extension supplies a loopback proxy for each, because a webview has no
// service worker to sign DuckDB's range reads with.
engine = createEngine(auth, {
  onStatus: setStatus,
  dfsOrigin: cfg.dfsOrigin,
  tableOrigin: cfg.tableOrigin,
});
engineReady = engine.init();

// Engine trouble (CDN down, wasm refused) must not block the sign-in path, and auth
// trouble must not block local SQL — the two halves fail independently, so they get a
// try/catch each rather than one around both.
(async () => {
  try {
    await startEngine();
  } catch (e) {
    setStatus('Engine failed to start: ' + e.message, 'error');
    console.error(e);
  }
})();

(async () => {
  try {
    // Silent only: restores a returning user's session (and completes a sign-in
    // redirect landing back here) without ever prompting a new visitor. No session ->
    // the button showSignedOut already painted is the right one, so there's nothing to do.
    if (await auth.ensureSession(false)) await afterSignIn();
  } catch (e) {
    // A redirect coming back with a consent failure lands here, not in the button
    // handler — so the gate has to be rendered before the error is explained.
    showSignIn(afterSignIn);
    showAuthFailure(e);
  }
})();

// ---------------------------------------------------------------------------
// The editor's sidebar, driving this panel
// ---------------------------------------------------------------------------
// Browsing lives in the VS Code tree; this is the other end of that. A click over there
// arrives here as one message and is handed to exactly the same selectTable/selectFile
// the panel's own sidebar calls, so a table opened from the tree costs the same three
// tiers, takes the same ticket, and reports the same way. No second code path for the
// same act, and nothing here is reachable from a browser tab.
if (HOST_VSCODE) {
  // Only the webview defines this. The guard is what lets the same page be driven in a
  // plain browser for testing — without it the whole block throws on load.
  const vs = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {} };

  // selectTable/selectFile take the row they were clicked on so they can mark it. Nothing
  // in the tree has a row on this side, and a detached element satisfies them without
  // pretending the hidden list is what was clicked.
  const detachedRow = () => document.createElement('div');

  // The panel follows the tree rather than leading it, so this is a plain state change:
  // no listing, no picker to update. The teardown is the part that matters — the previous
  // lakehouse's views and registrations have to be handed back before another one's
  // tables are opened.
  async function goToLakehouse(workspace, item) {
    await engineReady;
    if (lakehouse && lakehouse.workspace === workspace && lakehouse.item === item) return;
    const resetP = lakehouse ? leaveLakehouse() : null;
    lakehouse = { workspace, item };
    setPaneTabs(item);
    if (resetP) await resetP;
  }

  async function openTable(m) {
    await goToLakehouse(m.workspace, m.item);
    await selectTable(detachedRow(), { schema: m.schema || '', table: m.table });
  }

  // The message carries everything a listing would have: the tree just read this
  // directory. Re-listing it here to recover the entry cost a DFS round trip before every
  // file open, which is exactly the kind of thing that makes an editor feel slower than a
  // web page. The one flag not sent is `queryable` — whether a reader exists depends on
  // which DuckDB extensions loaded — and it is not needed: loadFile decides that itself
  // and says so, which is a better answer than refusing up front.
  async function openFile(m) {
    await goToLakehouse(m.workspace, m.item);
    const entry = { name: basename(m.path), path: m.path, isDir: false, bytes: m.bytes || 0 };
    if (IMAGE_EXTS.has(fileExt(entry.name))) await selectImage(detachedRow(), entry);
    else await selectFile(detachedRow(), entry);
  }

  // Where the bytes came from. DuckDB's reads never pass through this page — it cannot see
  // how many there were or how long OneLake took — so the extension counts them and sends
  // the total. Deliberately NOT written through setStatus: that does `el.className = type`
  // and would drop any class parked on it, and this is a standing fact rather than a
  // message about what just happened.
  // A round number is a round number: "20.0 GB" and "210.0 MB" read like a measurement
  // taken to a precision nobody asked for. And zero is nothing, not "1 KB".
  const trim = s => s.replace(/\.0$/, '');
  const bytes = n => !n ? 'nothing'
                   : n >= 1e9 ? `${trim((n / 1e9).toFixed(1))} GB`
                   : n >= 1e6 ? `${trim((n / 1e6).toFixed(1))} MB`
                   : `${Math.max(1, Math.round(n / 1e3))} KB`;

  function showReads(m) {
    const el = $('readSrc');
    el.hidden = false;
    el.className = '';
    const fromNet = m.misses + m.skips;
    // Background fills: downloads the extension started so the NEXT read is local. Real
    // network spend, so "local" is never claimed while one is in the burst — the ⇣ says
    // the bytes served locally were bought in the background.
    const filled = m.storeBytes || 0;
    const dl = filled ? ` · ⇣ ${bytes(filled)}` : '';
    if (m.cacheOff) {
      el.textContent = '☁ no cache';
      el.className = 'nocache';
    } else if (!fromNet) {
      el.textContent = `▤ local${dl}`;
      el.className = 'local';
    } else if (m.hits) {
      el.textContent = `▤ ${m.hits} · ☁ ${fromNet} · ${bytes(m.netBytes)}${dl}`;
    } else {
      el.textContent = `☁ network · ${bytes(m.netBytes)}${dl}`;
    }
    el.title = [
      `${m.reads} read(s) behind the last thing you waited for.`,
      m.hits ? `${m.hits} from this machine (${bytes(m.cacheBytes)}).` : 'None came from this machine.',
      fromNet ? `${fromNet} from OneLake (${bytes(m.netBytes)}, ${(m.netMs / 1000).toFixed(1)}s).` : '',
      // A skip is not a miss: nothing of it was kept, so it will cost the network again.
      m.skips ? `${m.skips} of those were not kept, and will cost the network again.` : '',
      m.stores ? `${m.stores} background download(s) filled the cache (${bytes(filled)}) ` +
                 `so the next read is local.` : '',
      m.cacheOff ? `Cache is OFF: ${m.cacheOff}` : `Cache holds ${bytes(m.cacheStored)} of ${bytes(m.cacheMax)}.`,
      'Click for the full read log.',
    ].filter(Boolean).join('\n');
  }

  $('readSrc').onclick = () => vs.postMessage({ type: 'show-log' });

  window.addEventListener('message', async e => {
    const m = e.data || {};
    try {
      if (m.type === 'open-table') await openTable(m);
      else if (m.type === 'open-file') await openFile(m);
      // The tree was refreshed, so what this side holds about the old listing is suspect.
      else if (m.type === 'reset') { await engineReady; await leaveLakehouse(); lakehouse = null; }
      else if (m.type === 'reads') showReads(m);
    } catch (err) {
      setStatus('Could not open that: ' + explainRead(err.message), 'error');
      console.error(err);
    }
  });

  // Said once the engine is up, because that is when a message can actually be acted on.
  // Until then the extension holds the last click rather than dropping it — booting DuckDB
  // takes seconds, and a click in that window is the most likely one there is.
  engineReady.then(() => vs.postMessage({ type: 'ready' }), () => {});
}
