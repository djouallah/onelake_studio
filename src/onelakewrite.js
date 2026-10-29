'use strict';
// =============================================================================
// onelakewrite.js — the one file the extension writes to OneLake
// =============================================================================
// Export to Fabric writes a semantic model opened from its local copy, as its .bim, into the
// Files/ of the lakehouse it reads (extension.js, exportExplore), where the app reads it. That is
// the only write to OneLake, and only once an export is approved. Everything else the extension
// reads stays in catalog.js, which writes nothing.
//
// DFS, as Azure Data Lake Storage Gen2: create the file (an existing one is replaced), append
// the bytes at 0, flush at their length. The storage token is the VS Code one catalog.js
// uses; a 401 is retried once with a fresh one.
// =============================================================================

const { encPath } = require('./names');

const DFS_ORIGIN = 'https://onelake.dfs.fabric.microsoft.com';
const TIMEOUT_MS = 5 * 60_000;

async function oneLakeMessage(r) {
  try {
    const j = JSON.parse(await r.text());
    return (j && j.error && j.error.message) || '';
  } catch (_) { return ''; }
}

/**
 * @param {object} o
 * @param {(o?: {fresh?: boolean}) => Promise<string|null>} o.getToken  storage audience
 */
function createOneLakeWriter({ getToken, dfsOrigin = DFS_ORIGIN, fetchImpl = (...a) => fetch(...a) }) {
  async function call(url, { method, headers = {}, body } = {}) {
    let token = await getToken();
    if (!token) throw Object.assign(new Error('Not signed in to a Microsoft account.'), { status: 401 });
    const send = t => fetchImpl(url, { method, body, headers: { ...headers, authorization: `Bearer ${t}` },
                                       signal: AbortSignal.timeout(TIMEOUT_MS) });
    let r = await send(token);
    if (r.status === 401) {
      const fresh = await getToken({ fresh: true });
      if (fresh && fresh !== token) r = await send(token = fresh);
    }
    return r;
  }

  const urlOf = (ws, path) => `${dfsOrigin}/${encodeURIComponent(ws)}/${encPath(path)}`;

  // The file's size, or null when there is none.
  async function stat(ws, path) {
    const r = await call(urlOf(ws, path), { method: 'HEAD' });
    if (r.status === 404) return null;
    if (!r.ok) throw Object.assign(new Error(`Reading ${path} failed (HTTP ${r.status})`), { status: r.status });
    return { bytes: Number(r.headers.get('content-length')) || 0 };
  }

  async function writeFile(ws, path, bytes) {
    const body = Buffer.from(bytes);
    const url = urlOf(ws, path);
    const step = async (what, query, init) => {
      const r = await call(`${url}?${query}`, init);
      if (!r.ok) {
        const said = await oneLakeMessage(r);
        throw Object.assign(new Error(`Writing ${path} failed at ${what} (HTTP ${r.status})` + (said ? ` — ${said}` : '')),
          { status: r.status });
      }
    };
    await step('create', 'resource=file', { method: 'PUT', headers: { 'content-length': '0' } });
    if (body.length) {
      await step('append', 'action=append&position=0', {
        method: 'PATCH', headers: { 'content-type': 'application/octet-stream' }, body });
    }
    await step('flush', `action=flush&position=${body.length}`, { method: 'PATCH', headers: { 'content-length': '0' } });
  }

  return { stat, writeFile };
}

module.exports = { createOneLakeWriter };
