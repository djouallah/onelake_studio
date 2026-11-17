'use strict';
// =============================================================================
// fabricmodel.js — Create Semantic Model's semantic model, written over plain REST
// =============================================================================
// One name per workspace: the model of that name is updated, else one is created. Its definition
// is pbimodel.js's.
//   find      the workspace's model of that name, or null (read only: asked before anything is written)
//   write     create it (POST semanticModels) or replace its definition (updateDefinition), each a
//             long-running operation, waited for
//   frame     a refresh, which points the model at the tables' current versions
// The Fabric API with the Fabric-audience token (appToken), the Power BI API with Power BI's
// (fabricToken).
// No `vscode` import: the extension passes in its tokens.
// =============================================================================

const { FABRIC_API, authedFetch, fabricOk, jsonOrText: json, namedLike: byName, listPages, retryAfterMs, waitFabricOperation } = require('../../core/onelake/http');

const POWER_BI_API = 'https://api.powerbi.com/v1.0/myorg';
const FETCH_TIMEOUT_MS = 120_000;
const POLLS = 120;   // with Retry-After, a few minutes

/**
 * @param {object} o
 * @param {Function} o.getToken  the Fabric API's audience
 * @param {Function} o.powerBiToken  the Power BI API's
 */
function createFabricModel({ getToken, powerBiToken, apiBase = FABRIC_API, pbiBase = POWER_BI_API, log = () => {},
                             sleep = ms => new Promise(r => setTimeout(r, ms)), fetchImpl = fetch }) {
  async function call(url, { token = getToken, who = 'the Fabric API', method = 'GET', body, what = url, ok = [] } = {}) {
    const r = await authedFetch(url, { getToken: token, fetchImpl, method, body, timeoutMs: FETCH_TIMEOUT_MS, who,
                                       headers: body == null ? {} : { 'content-type': 'application/json' },
                                       retry: [429, 502, 503, 504], attempts: 4, backoffMs: a => 2000 * 2 ** (a - 1), sleep });
    return fabricOk(r, what, ok);
  }
  const pbi = (url, o = {}) => call(`${pbiBase}${url}`, { token: powerBiToken, who: 'the Power BI API', ...o });

  const list = ws => listPages(`${apiBase}/workspaces/${ws}/semanticModels`,
    async url => json(await call(url, { what: 'Listing the workspace\'s semantic models' })), { what: 'Listing the workspace\'s semantic models' });

  // { id, displayName } of the workspace's model called `name`, or null.
  const find = async (ws, name) => (await list(ws)).find(byName(name)) || null;

  // A long-running operation (202 + Location), to Succeeded.
  const waitOperation = (r, what) => waitFabricOperation(r, what, { call, sleep, waitMs: 3000, polls: POLLS });

  // The model called `name` with this definition: the one `id` names, else a new one. Returns
  // { id }.
  async function write(ws, name, definition, id = null) {
    if (id) {
      const what = `Updating the semantic model ${name}`;
      const r = await call(`${apiBase}/workspaces/${ws}/semanticModels/${id}/updateDefinition`, {
        method: 'POST', body: JSON.stringify({ definition }), what });
      if (r.status === 202) await waitOperation(r, what);
      log(`semantic model ${name}: definition updated (${id})`);
      return { id };
    }
    const what = `Creating the semantic model ${name}`;
    const r = await call(`${apiBase}/workspaces/${ws}/semanticModels`, {
      method: 'POST', body: JSON.stringify({ displayName: name, definition }), what });
    if (r.status === 202) await waitOperation(r, what);
    else {
      const item = await json(r);
      if (item && item.id) { log(`semantic model ${name}: created (${item.id})`); return { id: item.id }; }
    }
    const made = await find(ws, name);
    if (!made) throw new Error(`${what}: Fabric accepted it, but the workspace does not list it`);
    log(`semantic model ${name}: created (${made.id})`);
    return { id: made.id };
  }

  // A refresh frames the tables (their current Delta versions), and is waited for.
  async function frame(ws, id) {
    const what = 'Refreshing the semantic model';
    const r = await pbi(`/groups/${ws}/datasets/${id}/refreshes`, {
      method: 'POST', body: JSON.stringify({ type: 'full', commitMode: 'transactional', retryCount: 1 }), what });
    const location = r.headers.get('location');
    if (!location) return;
    // The POST's Retry-After for the first look, then each answer's own.
    let wait = retryAfterMs(r, 3000);
    for (let i = 0; i < POLLS; i++) {
      await sleep(wait);
      const p = await call(location, { token: powerBiToken, who: 'the Power BI API', what });
      const j = await json(p);
      const status = j && (j.extendedStatus || j.status);
      if (status === 'Completed') { log(`semantic model ${id}: refreshed`); return; }
      if (status === 'Failed' || status === 'Cancelled' || status === 'Disabled' || status === 'TimedOut') {
        const said = j.messages && j.messages.map(x => x.message).filter(Boolean).join('; ');
        throw new Error(`${what} ${status === 'TimedOut' ? 'timed out' : lc(status)}` + (said ? ` — ${said}` : ''));
      }
      wait = retryAfterMs(p, 3000);
    }
    throw new Error(`${what} did not finish`);
  }

  return { find, write, frame };
}

const lc = s => String(s).toLowerCase();

module.exports = { createFabricModel };
