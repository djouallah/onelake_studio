'use strict';
// =============================================================================
// fabricapp.js — a Fabric app (item type AppBackend) created and deployed over plain REST
// =============================================================================
// What `rayfin up` does for a project with static hosting and one function, and nothing else,
// read from @microsoft/rayfin-cli and rayfin-tools-common 1.36.2: no CLI, no npm, no Node on
// anyone's machine but the extension's. Every call is the Fabric API's, with the user's
// Fabric-audience token; the calls under the item name it again in a header (MONIKER).
//   1. the item: the one an earlier export created (its id, kept in the local copy), else a new
//      one (POST items). One of that name that no export created is never taken over unasked
//      (NAME_TAKEN): it may be someone's own app.
//   2. its backend: extended-properties, polled until it names BaaSEndpoint
//   3. its publishable key (the browser SDK's)
//   4. its runtime settings: Fabric sign-in, the function's identity, static hosting PROTECTED
//   5. the function's secrets: CATALOG_URL (the tables) and MODEL_URL (the model, read in place)
//   6. the site: a zip of dist/ (with rayfin.config.json, made here) -> hostingUrl
//   7. the function: the package built at package time (scripts/function-bundle.mjs), then
//      its deploy status polled
//   8. the hosting URL among the sign-in redirects (runtime settings again), when it is new
// The order is the CLI's: settings before content, content before functions.
// No `vscode` import: the extension passes in its token.
// =============================================================================

const FABRIC_API = 'https://api.fabric.microsoft.com/v1';
const ITEM_TYPE = 'AppBackend';
const MONIKER = 'X-Ms-Workload-Resource-Moniker';
const PORTAL_URL = 'https://app.fabric.microsoft.com/';
// The workload refuses static hosting from a client that does not say its version: the
// version of the CLI these calls were read from.
const CLIENT_VERSION = '1.36.2';
const FETCH_TIMEOUT_MS = 120_000;
const MAX_ZIP_BYTES = 100 * 1024 * 1024;
const FUNCTION_POLL_MS = 10_000;
const FUNCTION_POLLS = 30;   // ~5 minutes, as the CLI waits

const byName = name => i => String(i.displayName).toLowerCase() === String(name).toLowerCase();

// What Fabric said, from its error body (as fabric.js reads it): its messages name the
// missing permission or capacity, which a bare status code never does.
async function fabricMessage(r) {
  try {
    const j = JSON.parse(await r.text());
    return (j && (j.message || (j.error && j.error.message))) || '';
  } catch (_) { return ''; }
}
const retryAfterMs = (r, fallback) => {
  const s = Number(r.headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? Math.min(s, 30) * 1000 : fallback;
};

/**
 * @param {object} o
 * @param {(o?: {fresh?: boolean}) => Promise<string|null>} o.getToken  Fabric API audience
 * @param {(line: string) => void} [o.log]
 */
function createFabricApp({ getToken, apiBase = FABRIC_API, log = () => {},
                           sleep = ms => new Promise(r => setTimeout(r, ms)), fetchImpl = fetch }) {
  // One request: a fresh token once on a 401, Retry-After waited out on a 429, and the
  // statuses the CLI treats as "not ready yet" (`retry`) retried with its backoff.
  async function call(url, { method = 'GET', headers = {}, body, retry = [], what = url } = {}) {
    let token = await getToken();
    if (!token) throw Object.assign(new Error('Not signed in to the Fabric API.'), { status: 401 });
    const send = t => fetchImpl(url, { method, body, headers: { ...headers, authorization: `Bearer ${t}` },
                                       signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    let r, refreshed = false;
    for (let attempt = 1; ; attempt++) {
      r = await send(token);
      if (r.status === 401 && !refreshed) {
        refreshed = true;
        const fresh = await getToken({ fresh: true });
        if (fresh && fresh !== token) { token = fresh; attempt--; continue; }
      }
      const again = r.status === 429 || retry.includes(r.status);
      if (!again || attempt >= 5) break;
      await sleep(retryAfterMs(r, 2000 * 2 ** (attempt - 1)));
    }
    if (!r.ok) {
      const said = await fabricMessage(r);
      throw Object.assign(new Error(`${what} failed (HTTP ${r.status})` + (said ? ` — ${said}` : '')), { status: r.status });
    }
    return r;
  }
  const json = async r => { const t = await r.text(); try { return JSON.parse(t); } catch (_) { return t; } };

  async function listItems(ws) {
    const out = [];
    let cont = '';
    do {
      const u = new URL(`${apiBase}/workspaces/${ws}/items`);
      u.searchParams.set('type', ITEM_TYPE);
      if (cont) u.searchParams.set('continuationToken', cont);
      const j = await json(await call(u.toString(), { what: 'Listing the workspace\'s apps' }));
      out.push(...(j.value || []));
      cont = j.continuationToken || '';
    } while (cont);
    return out;
  }

  // The item called `name`, or a new one. Created once: a create that answered nothing
  // usable is looked for by name, never sent again (a second POST is a name conflict).
  async function ensureItem(ws, name, { itemId = null, takeOver = false } = {}) {
    const items = await listItems(ws);
    const mine = itemId && items.find(i => i.id === itemId);
    if (mine) { log(`app ${name}: item ${mine.id} (exported before)`); return { item: mine, created: false }; }
    const named = items.find(byName(name));
    if (named && !takeOver) {
      throw Object.assign(new Error(`an app named ${named.displayName} already exists in this workspace, and this export did not create it`),
        { code: 'NAME_TAKEN', item: named });
    }
    if (named) { log(`app ${name}: item ${named.id} (taken over)`); return { item: named, created: false }; }
    let r;
    try {
      r = await call(`${apiBase}/workspaces/${ws}/items`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: ITEM_TYPE, displayName: name }), what: `Creating the app ${name}`,
      });
    } catch (e) {
      if (e.status && e.status < 500 && e.status !== 429) throw e;
      const late = (await listItems(ws)).find(byName(name));
      if (late) return { item: late, created: true };
      throw e;
    }
    if (r.status === 202) await waitOperation(r, `Creating the app ${name}`);
    else {
      const item = await json(r);
      if (item && item.id) { log(`app ${name}: item ${item.id} (created)`); return { item, created: true }; }
    }
    for (let i = 0; i < 6; i++) {
      const item = (await listItems(ws)).find(byName(name));
      if (item) { log(`app ${name}: item ${item.id} (created)`); return { item, created: true }; }
      await sleep(5000);
    }
    throw new Error(`Creating the app ${name}: Fabric accepted it, but the workspace does not list it`);
  }

  // A long-running operation (202 + Location), to Succeeded.
  async function waitOperation(r, what) {
    const location = r.headers.get('location');
    if (!location) return;
    let wait = retryAfterMs(r, 5000);
    for (let i = 0; i < 60; i++) {
      await sleep(wait);
      const p = await call(location, { what });
      const op = await json(p);
      if (op.status === 'Succeeded') return;
      if (op.status === 'Failed' || op.status === 'Undefined') {
        throw new Error(`${what} failed — ${(op.error && (op.error.message || op.error.errorCode)) || op.status}`);
      }
      wait = retryAfterMs(p, 5000);
    }
    throw new Error(`${what} did not finish`);
  }

  const endpoint = (ws, id) => `${apiBase}/workspaces/${ws}/appBackends/${id}`;

  // The item's backend, once it is up: a new item takes a while to say where it is.
  async function backend(ws, id) {
    for (let attempt = 0; ; attempt++) {
      const r = await call(`${endpoint(ws, id)}/__private/extended-properties`, {
        headers: { [MONIKER]: id }, retry: [404, 500, 502, 503, 504], what: 'Reading the app\'s backend' });
      const j = await json(r);
      const url = j && j.extendedProperties && j.extendedProperties.BaaSEndpoint;
      if (url) return url;
      if (attempt >= 6) throw new Error('The app\'s backend is not ready (no BaaSEndpoint yet): export again in a minute');
      await sleep(retryAfterMs(r, 2000 * 2 ** attempt));
    }
  }

  // rayfin-tools-common's parsePublishableKeyResponse: a JSON string, { publishableKey }, or
  // the bare key.
  async function publishableKey(ws, id) {
    const r = await call(`${endpoint(ws, id)}/__private/publishable-key`, {
      headers: { [MONIKER]: id }, retry: [404, 502, 503], what: 'Reading the app\'s publishable key' });
    const body = (await r.text()).trim();
    try {
      const p = JSON.parse(body);
      if (typeof p === 'string') return p;
      if (p && typeof p.publishableKey === 'string') return p.publishableKey;
    } catch (_) {
      if (/^pk[-_][A-Za-z0-9_-]+$/.test(body)) return body;
    }
    return body;
  }

  const settings = redirects => ({
    auth: { enabled: true, fabric: { enabled: true }, allowedRedirectUris: redirects },
    data: { enabled: false },
    storage: { enabled: false },
    functions: { enabled: true, auth: { type: 'application' } },
    // anonymousAccess false: assetAccess "protected", the site is only for who may open the app.
    staticHosting: { enabled: true, folder: 'dist', indexDocument: 'index.html', anonymousAccess: false },
    packageVersions: { '@microsoft/rayfin-cli': CLIENT_VERSION },
  });
  const postSettings = (ws, id, redirects) => call(`${endpoint(ws, id)}/__private/projectRuntimeSettings`, {
    method: 'POST', headers: { 'content-type': 'application/json', [MONIKER]: id },
    body: JSON.stringify(settings(redirects)), retry: [408, 500, 502, 503, 504], what: 'Applying the app\'s settings' });

  const postSecret = (ws, id, name, value) => call(`${endpoint(ws, id)}/__private/secrets`, {
    method: 'POST', headers: { 'content-type': 'application/json', [MONIKER]: id },
    body: JSON.stringify({ name, value }), retry: [502, 503], what: `Setting the app's secret ${name}` });

  async function deploySite(ws, id, zip) {
    if (zip.length > MAX_ZIP_BYTES) throw new Error(`The site is ${(zip.length / 1048576).toFixed(0)} MB zipped: Fabric takes 100 MB at most`);
    const r = await call(`${endpoint(ws, id)}/__private/webapp/deploy`, {
      method: 'POST', headers: { 'content-type': 'application/zip', [MONIKER]: id }, body: zip,
      retry: [404, 408, 425, 502, 503], what: 'Uploading the site' });
    const j = await json(r);
    if (!j || typeof j !== 'object') throw new Error(`Uploading the site: unexpected answer ${String(j).slice(0, 200)}`);
    if (j.success === false) throw new Error(`Uploading the site failed: ${j.errorMessage || 'no reason given'}`);
    return j.hostingUrl || null;
  }

  // The function's package: a multipart form, as the CLI sends it (no content-type of our
  // own: the boundary is fetch's). Then its status, until Complete or Fail.
  async function deployFunction(ws, id, { sourceZip, deployMetaData }) {
    const form = new FormData();
    form.append('SourceZipFile', new Blob([sourceZip], { type: 'application/zip' }), 'source.zip');
    form.append('DeployMetaData', deployMetaData);
    form.append('isCompiledZip', 'true');
    const r = await call(`${endpoint(ws, id)}/__private/functions/deploy`, {
      method: 'POST', headers: { [MONIKER]: id }, body: form,
      retry: [404, 408, 425, 502, 503], what: 'Deploying the function' });
    const accepted = await json(r);
    const udf = accepted && accepted.udfArtifactId;
    if (!udf) throw new Error('Deploying the function: Fabric gave no function item to follow');
    const url = `${apiBase}/workspaces/${ws}/userDataFunctions/${udf}/__private/functions/metadata`;
    for (let i = 0; i < FUNCTION_POLLS; i++) {
      await sleep(FUNCTION_POLL_MS);
      let j;
      try {
        j = await json(await call(url, { retry: [408, 425, 502, 503], what: 'Reading the function\'s deploy status' }));
      } catch (e) { if (e.status === 404) continue; throw e; }
      const d = (j && j.deploy) || {};
      if (d.status === 'Complete') return udf;
      if (d.status === 'Fail') throw new Error(`Deploying the function failed — ${d.error || d.errorCode || 'no reason given'}`);
    }
    throw new Error('Deploying the function did not finish within 5 minutes');
  }

  /**
   * Publishes the app. `site(config)` answers the site's zip, given the rayfin.config.json
   * the browser reads (it names the backend). Returns { itemId, hostingUrl, created }.
   */
  async function publish({ workspaceId: ws, name, tenantId, catalogUrl, modelUrl, site, fn, redirects: known = [],
                          itemId = null, takeOver = false }) {
    const { item, created } = await ensureItem(ws, name, { itemId, takeOver });
    const id = item.id;
    log(`app ${name}: waiting for its backend`);
    const apiUrl = await backend(ws, id);
    const key = await publishableKey(ws, id);
    const redirects = [...new Set(known.filter(Boolean))];
    await postSettings(ws, id, redirects);
    await postSecret(ws, id, 'CATALOG_URL', catalogUrl);
    await postSecret(ws, id, 'MODEL_URL', modelUrl);
    log(`app ${name}: uploading the site`);
    const config = { apiUrl, publishableKey: key, workspaceId: ws, itemId: id, portalUrl: PORTAL_URL, ...(tenantId ? { tenantId } : {}) };
    const hostingUrl = await deploySite(ws, id, await site(config));
    log(`app ${name}: deploying the function (a few minutes)`);
    await deployFunction(ws, id, fn);
    // Sign-in comes back to the site: its origin must be one of the app's redirects.
    const origin = hostingUrl && new URL(hostingUrl).origin;
    if (origin && !redirects.includes(origin)) {
      redirects.push(origin);
      await postSettings(ws, id, redirects);
    }
    return { itemId: id, hostingUrl, created, redirects };
  }

  return { publish, ensureItem, settings };
}

// The tenant a token was issued in (its `tid`), for rayfin.config.json.
function tenantOf(token) {
  try {
    const payload = String(token).split('.')[1];
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).tid || null;
  } catch (_) { return null; }
}

module.exports = { createFabricApp, tenantOf, ITEM_TYPE, MONIKER, CLIENT_VERSION };
