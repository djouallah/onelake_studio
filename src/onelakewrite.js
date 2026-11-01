'use strict';
// =============================================================================
// onelakewrite.js — the one file the extension writes to OneLake
// =============================================================================
// Export to Fabric writes a semantic model opened from its local copy, its .yaml, into the
// Files/ of the lakehouse it reads (extension.js, exportExplore), where the app reads it. That is
// the only write to OneLake, and only once an export is approved. Everything else the extension
// reads stays in catalog.js, which writes nothing.
//
// DFS, as Azure Data Lake Storage Gen2: create a file beside the one wanted, append the bytes at
// 0, flush at their length, and rename it into place. Creating over the file itself would empty
// it at once, so a failure part way would leave the app reading nothing. The storage token is the
// VS Code one catalog.js uses; a 401 is retried once with a fresh one.
// =============================================================================

const { randomBytes } = require('node:crypto');
const { DFS_ORIGIN, dfsFileUrl } = require('./names');
const { authedFetch, oneLakeMessage } = require('./http');

const TIMEOUT_MS = 5 * 60_000;

/**
 * @param {object} o
 * @param {(o?: {fresh?: boolean}) => Promise<string|null>} o.getToken  storage audience
 */
function createOneLakeWriter({ getToken, dfsOrigin = DFS_ORIGIN, fetchImpl = (...a) => fetch(...a) }) {
  const call = (url, { method, headers = {}, body } = {}) =>
    authedFetch(url, { getToken, fetchImpl, method, headers, body, timeoutMs: TIMEOUT_MS });

  const urlOf = (ws, path) => dfsFileUrl(ws, path, dfsOrigin);

  // The file's size, or null when there is none.
  async function stat(ws, path) {
    const r = await call(urlOf(ws, path), { method: 'HEAD' });
    if (r.status === 404) return null;
    if (!r.ok) throw Object.assign(new Error(`Reading ${path} failed (HTTP ${r.status})`), { status: r.status });
    return { bytes: Number(r.headers.get('content-length')) || 0 };
  }

  // What is at `path` against `text`: 'none', 'same' or 'different'. Only a 404 means nothing is
  // there. Not being able to tell throws, so a caller can't take it for leave to write: a file
  // that can't be read back is 'different', which a caller asks about.
  async function compare(ws, path, text, read) {
    if (!await stat(ws, path)) return 'none';
    const there = await Promise.resolve().then(read).catch(() => null);
    return there && Buffer.from(there).toString('utf8') === String(text) ? 'same' : 'different';
  }

  async function writeFile(ws, path, bytes) {
    const body = Buffer.from(bytes);
    const url = urlOf(ws, path);
    const tmp = urlOf(ws, `${path}.${randomBytes(4).toString('hex')}.tmp`);
    const step = async (what, target, init) => {
      const r = await call(target, init);
      if (!r.ok) {
        const said = await oneLakeMessage(r);
        throw Object.assign(new Error(`Writing ${path} failed at ${what} (HTTP ${r.status})` + (said ? ` — ${said}` : '')),
          { status: r.status });
      }
    };
    try {
      await step('create', `${tmp}?resource=file`, { method: 'PUT', headers: { 'content-length': '0' } });
      if (body.length) {
        await step('append', `${tmp}?action=append&position=0`, {
          method: 'PATCH', headers: { 'content-type': 'application/octet-stream' }, body });
      }
      await step('flush', `${tmp}?action=flush&position=${body.length}`, { method: 'PATCH', headers: { 'content-length': '0' } });
      // A rename replaces what is at the destination, in one step.
      await step('rename', url, { method: 'PUT', headers: { 'content-length': '0', 'x-ms-rename-source': new URL(tmp).pathname } });
    } catch (e) {
      // What was there is untouched, and this says what went wrong: the temp file is only tidied.
      await call(tmp, { method: 'DELETE' }).catch(() => {});
      throw e;
    }
  }

  return { stat, compare, writeFile };
}

module.exports = { createOneLakeWriter };
