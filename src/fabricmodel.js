'use strict';
// =============================================================================
// fabricmodel.js — Export to Fabric's semantic model, written over plain REST
// =============================================================================
// DirectQuery and Direct Lake exports make the model a Fabric semantic model item, which the app's
// function queries in DAX. One name per workspace: the model of that name is updated, else one is
// created. Its definition is pbimodel.js's.
//   find      the workspace's model of that name, or null (read only: asked before anything is written)
//   write     create it (POST semanticModels) or replace its definition (updateDefinition), each a
//             long-running operation, waited for
//   frame     Direct Lake: a refresh, which points the model at the tables' current versions
//   bindSso   DirectQuery: the SQL endpoint's credentials, OAuth2 with the caller's own identity (SSO),
//             so every query runs as whoever asked it
// The Fabric API with the Fabric-audience token (appToken), the Power BI API with Power BI's
// (fabricToken), the SQL endpoint's token for the credentials (sqlToken).
// No `vscode` import: the extension passes in its tokens.
// =============================================================================

const { authedFetch, fabricMessage, listPages, retryAfterMs } = require('./http');

const FABRIC_API = 'https://api.fabric.microsoft.com/v1';
const POWER_BI_API = 'https://api.powerbi.com/v1.0/myorg';
const FETCH_TIMEOUT_MS = 120_000;
const POLLS = 120;   // with Retry-After, a few minutes

const byName = name => i => String(i.displayName).toLowerCase() === String(name).toLowerCase();

/**
 * @param {object} o
 * @param {Function} o.getToken  the Fabric API's audience
 * @param {Function} o.powerBiToken  the Power BI API's
 * @param {Function} o.sqlToken  the SQL endpoint's
 */
function createFabricModel({ getToken, powerBiToken, sqlToken, apiBase = FABRIC_API, pbiBase = POWER_BI_API, log = () => {},
                             sleep = ms => new Promise(r => setTimeout(r, ms)), fetchImpl = fetch }) {
  async function call(url, { token = getToken, who = 'the Fabric API', method = 'GET', body, what = url, ok = [] } = {}) {
    const r = await authedFetch(url, { getToken: token, fetchImpl, method, body, timeoutMs: FETCH_TIMEOUT_MS, who,
                                       headers: body == null ? {} : { 'content-type': 'application/json' },
                                       retry: [429, 502, 503, 504], attempts: 4, backoffMs: a => 2000 * 2 ** (a - 1), sleep });
    if (!r.ok && !ok.includes(r.status)) {
      const said = await fabricMessage(r);
      throw Object.assign(new Error(`${what} failed (HTTP ${r.status})` + (said ? ` — ${said}` : '')), { status: r.status });
    }
    return r;
  }
  const json = async r => { const t = await r.text(); try { return JSON.parse(t); } catch (_) { return t; } };
  const pbi = (url, o = {}) => call(`${pbiBase}${url}`, { token: powerBiToken, who: 'the Power BI API', ...o });

  const list = ws => listPages(`${apiBase}/workspaces/${ws}/semanticModels`,
    async url => json(await call(url, { what: 'Listing the workspace\'s semantic models' })), { what: 'Listing the workspace\'s semantic models' });

  // { id, displayName } of the workspace's model called `name`, or null.
  const find = async (ws, name) => (await list(ws)).find(byName(name)) || null;

  // A long-running operation (202 + Location), to Succeeded.
  async function waitOperation(r, what) {
    const location = r.headers.get('location');
    if (!location) return;
    let wait = retryAfterMs(r, 3000);
    for (let i = 0; i < POLLS; i++) {
      await sleep(wait);
      const p = await call(location, { what });
      const op = await json(p);
      if (op.status === 'Succeeded') return;
      if (op.status === 'Failed' || op.status === 'Undefined') {
        throw new Error(`${what} failed — ${(op.error && (op.error.message || op.error.errorCode)) || op.status}`);
      }
      wait = retryAfterMs(p, 3000);
    }
    throw new Error(`${what} did not finish`);
  }

  // The model called `name` with this definition: the one `id` names, else a new one. Returns
  // { id, created }.
  async function write(ws, name, definition, id = null) {
    if (id) {
      const what = `Updating the semantic model ${name}`;
      const r = await call(`${apiBase}/workspaces/${ws}/semanticModels/${id}/updateDefinition`, {
        method: 'POST', body: JSON.stringify({ definition }), what });
      if (r.status === 202) await waitOperation(r, what);
      log(`semantic model ${name}: definition updated (${id})`);
      return { id, created: false };
    }
    const what = `Creating the semantic model ${name}`;
    const r = await call(`${apiBase}/workspaces/${ws}/semanticModels`, {
      method: 'POST', body: JSON.stringify({ displayName: name, definition }), what });
    if (r.status === 202) await waitOperation(r, what);
    else {
      const item = await json(r);
      if (item && item.id) { log(`semantic model ${name}: created (${item.id})`); return { id: item.id, created: true }; }
    }
    const made = await find(ws, name);
    if (!made) throw new Error(`${what}: Fabric accepted it, but the workspace does not list it`);
    log(`semantic model ${name}: created (${made.id})`);
    return { id: made.id, created: true };
  }

  // Direct Lake: a refresh frames the tables (their current Delta versions), and is waited for.
  async function frame(ws, id) {
    const what = 'Refreshing the semantic model';
    const r = await pbi(`/groups/${ws}/datasets/${id}/refreshes`, {
      method: 'POST', body: JSON.stringify({ type: 'full', commitMode: 'transactional', retryCount: 1 }), what });
    const location = r.headers.get('location');
    if (!location) return;
    for (let i = 0; i < POLLS; i++) {
      await sleep(retryAfterMs(r, 3000));
      const j = await json(await call(location, { token: powerBiToken, who: 'the Power BI API', what }));
      const status = j && (j.extendedStatus || j.status);
      if (status === 'Completed') return;
      if (status === 'Failed' || status === 'Cancelled' || status === 'Disabled' || status === 'TimedOut') {
        const said = j.messages && j.messages.map(x => x.message).filter(Boolean).join('; ');
        throw new Error(`${what} ${status === 'TimedOut' ? 'timed out' : lc(status)}` + (said ? ` — ${said}` : ''));
      }
    }
    throw new Error(`${what} did not finish`);
  }

  // DirectQuery: each of the model's data sources takes OAuth2 with the caller's identity (SSO).
  // A model someone else set up is taken over first: only its owner may set its credentials.
  async function bindSso(ws, id) {
    const sources = async () => ((await json(await pbi(`/groups/${ws}/datasets/${id}/datasources`, { what: 'Reading the model\'s data sources' }))) || {}).value || [];
    const token = await sqlToken();
    if (!token) throw new Error('not signed in to the SQL endpoint');
    const credentialDetails = {
      credentialType: 'OAuth2',
      credentials: JSON.stringify({ credentialData: [{ name: 'accessToken', value: token }] }),
      encryptedConnection: 'Encrypted', encryptionAlgorithm: 'None', privacyLevel: 'Organizational',
      useEndUserOAuth2Credentials: true,
    };
    const set = s => pbi(`/gateways/${s.gatewayId}/datasources/${s.datasourceId}`, {
      method: 'PATCH', body: JSON.stringify({ credentialDetails }), what: 'Setting the SQL endpoint\'s credentials' });
    let list = await sources();
    try {
      for (const s of list) await set(s);
    } catch (e) {
      if (e.status !== 401 && e.status !== 403) throw e;
      await pbi(`/groups/${ws}/datasets/${id}/Default.TakeOver`, { method: 'POST', what: 'Taking over the semantic model' });
      list = await sources();
      for (const s of list) await set(s);
    }
    log(`semantic model ${id}: ${list.length} data source(s) on SSO`);
  }

  return { find, write, frame, bindSso };
}

const lc = s => String(s).toLowerCase();

module.exports = { createFabricModel };
