'use strict';
// =============================================================================
// host.js — what the panel may ask the extension host, and how it is answered
// =============================================================================
// One channel carries everything the page needs from outside itself: DuckDB statements
// (engine-host.js) and OneLake — a table's metadata and first rows, a Files/ listing, a
// file's bytes — answered cache first by onelake.js. The page holds no credential and
// makes no request of its own; this map is the whole of what it can reach.
//
// No `vscode` import, so the browser harnesses under test/ answer the real page with the
// real methods, exactly as panel.js does.
// =============================================================================

// A target from the page, reduced to the strings it may carry.
const lhOf = x => ({ workspace: String(x.workspace), item: String(x.item) });
const tableOf = x => ({ schema: String(x.schema || ''), table: String(x.table) });
const RANGE = /^bytes=\d+-\d*$/;

/**
 * @param {object} o
 * @param {ReturnType<import('./onelake').createOneLake>} o.onelake
 * @param {{ call: Function }} o.engine
 * @param {(message: string) => void} [o.onStatus]  why a catalog call is taking long
 */
function createHostMethods({ onelake, engine, onStatus = () => {} }) {
  return {
    'onelake.table': x => onelake.table(lhOf(x), tableOf(x), { onWait: onStatus }),
    'onelake.peek': x => onelake.peek(lhOf(x), tableOf(x), sql => engine.call('query', [sql])),
    // One level of a lakehouse's Files/ — the same cached listing the tree draws.
    'onelake.files': x => onelake.files(lhOf(x), String(x.dir || '')),
    // A file's bytes, or a range of them, signed here. base64, because a webview message
    // is JSON and a Uint8Array does not survive it.
    'onelake.readBytes': async x => {
      const range = typeof x.range === 'string' && RANGE.test(x.range) ? x.range : undefined;
      const bytes = await onelake.readBytes(String(x.workspace), String(x.path), { range });
      return { base64: Buffer.from(bytes).toString('base64') };
    },
    // A Files/ object the engine must open as a LOCAL file (a SQLite database: DuckDB's
    // sqlite extension reads only local paths). The host reads it and writes it into the
    // engine's temp directory; the page gets the path, never the bytes.
    'onelake.localCopy': async x => {
      const ws = String(x.workspace), path = String(x.path);
      if (typeof engine.copyToTemp !== 'function') throw new Error('this engine cannot take a local copy');
      return engine.copyToTemp(`${ws}/${path}`, await onelake.readBytes(ws, path));
    },
  };
}

/**
 * Answer one `engine-call` from the page: a host method when it names one, otherwise a
 * DuckDB call. Every outcome is posted — a call that never settles is a page that hangs
 * with nothing said. Streaming results arrive as `engine-batch` messages under the call's
 * id, then one `engine-result`.
 */
async function answer({ methods, engine }, msg, post) {
  const { id, method, args } = msg || {};
  try {
    // hasOwn: the method name comes from the page.
    const value = Object.hasOwn(methods, method)
      ? await methods[method](...(Array.isArray(args) ? args : []))
      : await engine.call(method, args || [], batch => post({ type: 'engine-batch', id, batch }));
    post({ type: 'engine-result', id, value });
  } catch (e) {
    post({
      type: 'engine-error', id,
      message: (e && e.message) || String(e),
      cancelled: !!(e && e.cancelled),
    });
  }
}

module.exports = { createHostMethods, answer };
