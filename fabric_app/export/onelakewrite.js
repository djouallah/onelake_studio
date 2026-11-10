'use strict';
// =============================================================================
// onelakewrite.js — the files the extension writes to OneLake
// =============================================================================
// Two writers, each only on a person's say-so: Export to Fabric writes a semantic model opened from its
// local copy, its .yaml, into the Files/ of the lakehouse it reads (exportflow.js), where the app reads it;
// and Upload writes files from this computer into a folder of a lakehouse's Files/ (extension.js
// uploadFiles). Everything else the extension reads stays in catalog.js, which writes nothing.
//
// DFS, as Azure Data Lake Storage Gen2: create a file beside the one wanted, append the bytes in pieces
// (CHUNK), flush at their length, and rename it into place. Creating over the file itself would empty
// it at once, so a failure part way would leave a reader with nothing. The storage token is the
// VS Code one catalog.js uses; a 401 is retried once with a fresh one.
// =============================================================================

const { randomBytes } = require('node:crypto');
const fsp = require('node:fs/promises');
const { DFS_ORIGIN, dfsFileUrl } = require('../../core/names');
const { authedFetch, oneLakeMessage } = require('../../core/onelake/http');

const TIMEOUT_MS = 5 * 60_000;
// One append's bytes: a big file is many requests, each with its own timeout, and one in memory at a time.
const CHUNK = 32 * 1024 * 1024;

/**
 * @param {object} o
 * @param {(o?: {fresh?: boolean}) => Promise<string|null>} o.getToken  storage audience
 */
function createOneLakeWriter({ getToken, dfsOrigin = DFS_ORIGIN, fetchImpl = (...a) => fetch(...a) }) {
  const call = (url, { method, headers = {}, body } = {}) =>
    authedFetch(url, { getToken, fetchImpl, method, headers, body, timeoutMs: TIMEOUT_MS });

  const urlOf = (ws, path) => dfsFileUrl(ws, path, dfsOrigin);

  // The file's size and version, or null when there is none.
  async function stat(ws, path) {
    const r = await call(urlOf(ws, path), { method: 'HEAD' });
    if (r.status === 404) return null;
    if (!r.ok) throw Object.assign(new Error(`Reading ${path} failed (HTTP ${r.status})`), { status: r.status });
    return { bytes: Number(r.headers.get('content-length')) || 0, etag: r.headers.get('etag') };
  }

  // What is at `path` against `text`: 'none', 'same' or 'different'. Only a 404 means nothing is
  // there. Not being able to tell throws, so a caller can't take it for leave to write: a file
  // that can't be read back is 'different', which a caller asks about.
  async function compare(ws, path, text, read) {
    if (!await stat(ws, path)) return 'none';
    const there = await Promise.resolve().then(read).catch(() => null);
    return there && Buffer.from(there).toString('utf8') === String(text) ? 'same' : 'different';
  }

  // `over`: what stat said is there, null for nothing, when a question was asked on it. Anything else
  // there by the time it lands fails the rename, and is left as it is. `size` bytes, read a piece at a
  // time by `pieceAt(position, length)`; `onProgress(written, size)` after each, and `cancelled()`
  // asked before each: a cancel throws { cancelled: true }, and leaves what was there.
  async function put(ws, path, size, pieceAt, { over, onProgress = () => {}, cancelled = () => false, chunk = CHUNK } = {}) {
    const onlyIf = over === undefined ? {} : over === null ? { 'if-none-match': '*' } : over.etag ? { 'if-match': over.etag } : {};
    const url = urlOf(ws, path);
    const tmp = urlOf(ws, `${path}.${randomBytes(4).toString('hex')}.tmp`);
    const step = async (what, target, init) => {
      if (cancelled()) throw Object.assign(new Error(`Writing ${path} was cancelled`), { cancelled: true });
      const r = await call(target, init);
      if (!r.ok) {
        const said = await oneLakeMessage(r);
        throw Object.assign(new Error(`Writing ${path} failed at ${what} (HTTP ${r.status})` + (said ? ` — ${said}` : '')),
          { status: r.status });
      }
    };
    try {
      await step('create', `${tmp}?resource=file`, { method: 'PUT', headers: { 'content-length': '0' } });
      for (let at = 0; at < size; at += chunk) {
        const body = Buffer.from(await pieceAt(at, Math.min(chunk, size - at)));
        await step('append', `${tmp}?action=append&position=${at}`, {
          method: 'PATCH', headers: { 'content-type': 'application/octet-stream' }, body });
        onProgress(at + body.length, size);
      }
      await step('flush', `${tmp}?action=flush&position=${size}`, { method: 'PATCH', headers: { 'content-length': '0' } });
      // A rename replaces what is at the destination, in one step.
      await step('rename', url, { method: 'PUT', headers: { 'content-length': '0', 'x-ms-rename-source': new URL(tmp).pathname, ...onlyIf } });
    } catch (e) {
      // What was there is untouched, and this says what went wrong: the temp file is only tidied.
      await call(tmp, { method: 'DELETE' }).catch(() => {});
      throw e;
    }
  }

  const writeFile = (ws, path, bytes, o = {}) => {
    const body = Buffer.from(bytes);
    return put(ws, path, body.length, (at, n) => body.subarray(at, at + n), o);
  };

  // A file on this computer, read a piece at a time, never whole.
  async function writeLocalFile(ws, path, file, o = {}) {
    const fh = await fsp.open(file, 'r');
    try {
      const { size } = await fh.stat();
      await put(ws, path, size, async (at, n) => {
        const buf = Buffer.alloc(n);
        let got = 0;
        while (got < n) {
          const { bytesRead } = await fh.read(buf, got, n - got, at + got);
          if (!bytesRead) throw new Error(`${file} changed while it was read`);
          got += bytesRead;
        }
        return buf;
      }, o);
      return size;
    } finally { await fh.close(); }
  }

  return { stat, compare, writeFile, writeLocalFile };
}

module.exports = { createOneLakeWriter };
