'use strict';
// =============================================================================
// fabric.js — a workspace's semantic models, and exporting one's .bim into Files/
// =============================================================================
// Everything else in the extension reads OneLake on the storage token. A semantic model is
// not in OneLake: its definition comes from the Fabric REST API, which wants a token in a
// different audience — asked for only when someone expands "Semantic models", never at
// sign-in. The export is the extension's one write, and it is narrow on purpose: one file,
// `<lakehouse>/Files/semantic_models/<model>.bim`, written only on the user's command.
// assertExportPath is what keeps it that narrow — every other path is refused before a
// request goes out.
//
// Host-side only. The webview's proxy stays GET/HEAD and never sees a Fabric token.
// =============================================================================

const { DFS_ORIGIN } = require('./catalog');

const FABRIC_API = 'https://api.fabric.microsoft.com/v1';
const FETCH_TIMEOUT_MS = 60_000;
const MAX_PAGES = 200;
// getDefinition is a long-running operation. A model's definition is seconds of work; two
// minutes is far past anything a real one takes, and short enough that a stuck operation
// says so instead of leaving a progress notification up for ever.
const LRO_TIMEOUT_MS = 120_000;
// DFS append takes far more than this per call; 4 MiB keeps each request a size that a
// slow link finishes well inside the timeout.
const CHUNK = 4 * 1024 * 1024;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
const encPath = p => String(p).split('/').map(encodeURIComponent).join('/');

// The folder an export lands in, inside a lakehouse's Files/ area.
const EXPORT_DIR = 'semantic_models';

// A model's display name as a file name: the characters Windows, OneLake or a URL would
// choke on become `_`, and a name that is nothing but those still gets a file.
function bimFileName(modelName) {
  const safe = String(modelName).replace(/[\\/:*?"<>|#%\u0000-\u001f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  return `${safe || 'model'}.bim`;
}

// Workspace-relative path of a model's export: `<item>/Files/semantic_models/<name>.bim`.
function exportPath(item, modelName) {
  return `${item}/Files/${EXPORT_DIR}/${bimFileName(modelName)}`;
}

// The only shape of path the extension will ever write. Anything else — Tables/, another
// item kind, a sub-directory, a `..`, a file that is not a .bim — is refused, so a bug or
// a crafted argument further up cannot turn the export into a general-purpose writer.
function assertExportPath(rel) {
  const segs = String(rel).split('/');
  const ok = segs.length === 4 &&
    /^[^/\\]+\.Lakehouse$/.test(segs[0]) &&
    segs[1] === 'Files' && segs[2] === EXPORT_DIR &&
    /^[^/\\]+\.bim$/i.test(segs[3]) &&
    !segs.some(s => s === '' || s === '.' || s === '..');
  if (!ok) throw new Error(`Refusing to write ${rel}: exports go only to <lakehouse>/Files/${EXPORT_DIR}/<name>.bim`);
}

// What Fabric said, from its error body. Its messages name the missing permission or the
// unsupported model, which a bare status code never does.
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
 * @param {object} opts
 * @param {(o?: {fresh?: boolean}) => Promise<string|null>} opts.getFabricToken  Fabric API audience
 * @param {(o?: {fresh?: boolean}) => Promise<string|null>} opts.getStorageToken OneLake (storage) audience
 */
function createFabric({ getFabricToken, getStorageToken, apiBase = FABRIC_API, dfsOrigin = DFS_ORIGIN,
                        sleep = ms => new Promise(r => setTimeout(r, ms)), lroTimeoutMs = LRO_TIMEOUT_MS }) {
  // Retry once on 401 with a fresh token, as catalog.js does; and wait out a 429, which
  // the Fabric API hands out freely and always with a Retry-After.
  async function call(getToken, url, { method = 'GET', body, headers = {} } = {}) {
    let token = await getToken();
    if (!token) {
      const e = new Error('Not signed in to the Fabric API.');
      e.status = 401;
      throw e;
    }
    const send = t => fetch(url, {
      method, body,
      headers: { ...headers, authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    let r = await send(token);
    if (r.status === 401) {
      const fresh = await getToken({ fresh: true });
      if (fresh && fresh !== token) r = await send(token = fresh);
    }
    for (let i = 0; r.status === 429 && i < 3; i++) {
      await sleep(retryAfterMs(r, 5000));
      r = await send(token);
    }
    return r;
  }

  async function fabricJson(url, what, opts) {
    const r = await call(getFabricToken, url, opts);
    if (!r.ok) {
      const said = await fabricMessage(r);
      const e = new Error(`${what} failed (HTTP ${r.status})` + (said ? ` — ${said}` : ''));
      e.status = r.status;
      throw e;
    }
    return r;
  }

  // Fabric's list calls page with continuationToken and say so in the body.
  async function listAll(path, what) {
    const out = [];
    let cont = '', pages = 0;
    do {
      if (++pages > MAX_PAGES) throw new Error(`${what} did not finish after ${MAX_PAGES} pages — giving up`);
      const u = new URL(`${apiBase}${path}`);
      if (cont) u.searchParams.set('continuationToken', cont);
      const j = await (await fabricJson(u.toString(), what)).json().catch(() => ({}));
      out.push(...(j.value || []));
      cont = j.continuationToken || '';
    } while (cont);
    return out;
  }

  // The tree knows a workspace by the name OneLake's DFS listing gives it; the Fabric API
  // knows it by GUID. One listing maps every name, memoised until a refresh.
  let wsIds = null;
  async function workspaceId(name) {
    if (GUID.test(name)) return name;
    if (!wsIds) {
      wsIds = listAll('/workspaces', 'Listing Fabric workspaces')
        .then(list => new Map(list.map(w => [w.displayName, w.id])))
        .catch(e => { wsIds = null; throw e; });
    }
    const id = (await wsIds).get(name);
    if (!id) throw new Error(`The Fabric API does not list a workspace named "${name}"`);
    return id;
  }

  // [{ id, name, description }] by name.
  async function listSemanticModels(workspace) {
    const id = await workspaceId(workspace);
    const list = await listAll(`/workspaces/${id}/semanticModels`, `Listing semantic models in ${workspace}`);
    return list.map(m => ({ id: m.id, name: m.displayName, description: m.description || '' }))
      .sort((a, b) => byName(a.name, b.name));
  }

  // The model's TMSL definition — model.bim — as bytes. getDefinition answers 200 with the
  // definition, or 202 with an operation to poll; the definition is then that operation's
  // /result.
  async function getBim(workspace, modelId) {
    const id = await workspaceId(workspace);
    const url = `${apiBase}/workspaces/${id}/semanticModels/${encodeURIComponent(modelId)}/getDefinition?format=TMSL`;
    let r = await fabricJson(url, 'Exporting the model definition', { method: 'POST' });
    if (r.status === 202) {
      const location = r.headers.get('location');
      if (!location) throw new Error('Exporting the model definition: Fabric accepted it but gave no operation to follow');
      const deadline = Date.now() + lroTimeoutMs;
      let wait = retryAfterMs(r, 2000);
      for (;;) {
        if (Date.now() > deadline) throw new Error(`Exporting the model definition did not finish within ${Math.round(lroTimeoutMs / 1000)} s`);
        await sleep(wait);
        const p = await fabricJson(location, 'Waiting for the model definition');
        const op = await p.json().catch(() => ({}));
        if (op.status === 'Succeeded') break;
        if (op.status === 'Failed' || op.status === 'Undefined') {
          const said = (op.error && (op.error.message || op.error.errorCode)) || op.status;
          throw new Error(`Exporting the model definition failed — ${said}`);
        }
        wait = retryAfterMs(p, 2000);
      }
      r = await fabricJson(`${location.replace(/\/+$/, '')}/result`, 'Reading the model definition');
    }
    const j = await r.json().catch(() => ({}));
    const parts = (j.definition && j.definition.parts) || [];
    const part = parts.find(p => /(^|\/)model\.bim$/i.test(p.path || ''));
    if (!part) {
      throw new Error('The model definition has no model.bim part' +
        (parts.length ? ` (it has ${parts.map(p => p.path).join(', ')})` : ''));
    }
    return Buffer.from(part.payload || '', 'base64');
  }

  const dfsUrl = (workspace, rel) => `${dfsOrigin}/${encodeURIComponent(workspace)}/${encPath(rel)}`;

  async function storage(url, opts, what) {
    const r = await call(getStorageToken, url, opts);
    if (!r.ok) {
      const said = await fabricMessage(r);
      const e = new Error(`${what} failed (HTTP ${r.status})` + (said ? ` — ${said}` : ''));
      e.status = r.status;
      throw e;
    }
    return r;
  }

  async function exists(workspace, rel) {
    assertExportPath(rel);
    const r = await call(getStorageToken, dfsUrl(workspace, rel), { method: 'HEAD' });
    if (r.status === 404) return false;
    if (r.ok) return true;
    const e = new Error(`Checking ${rel} failed (HTTP ${r.status})`);
    e.status = r.status;
    throw e;
  }

  // ADLS Gen2's three-step write: create (replacing any file already there), append the
  // bytes, flush at their length — nothing is visible until the flush.
  async function writeExport(workspace, rel, bytes) {
    assertExportPath(rel);
    const url = dfsUrl(workspace, rel);
    await storage(`${url}?resource=file`, { method: 'PUT' }, `Creating ${rel}`);
    let pos = 0;
    while (pos < bytes.length) {
      const chunk = bytes.subarray(pos, Math.min(pos + CHUNK, bytes.length));
      await storage(`${url}?action=append&position=${pos}`,
        { method: 'PATCH', body: chunk, headers: { 'content-type': 'application/octet-stream' } },
        `Writing ${rel}`);
      pos += chunk.length;
    }
    await storage(`${url}?action=flush&position=${bytes.length}`, { method: 'PATCH' }, `Finishing ${rel}`);
  }

  function reset() { wsIds = null; }

  return { workspaceId, listSemanticModels, getBim, exists, writeExport, reset };
}

module.exports = { createFabric, exportPath, bimFileName, assertExportPath, EXPORT_DIR };
