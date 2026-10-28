'use strict';
// =============================================================================
// host.js — what the panel may ask the extension host, and how it is answered
// =============================================================================
// One channel carries everything the page needs from outside itself, as four messages:
//
//   page -> host   { type: 'call',   id, method, args }
//   host -> page   { type: 'batch',  id, batch }           (streamed results, zero or more)
//                  { type: 'result', id, value }           (exactly one of these two)
//                  { type: 'error',  id, message, cancelled }
//
// The methods are DuckDB's (query, stream, cancel, info — engine-host.js) and OneLake's,
// answered cache first by onelake.js: a table's metadata and first rows, the identifier to
// select a table from, a Files/ listing, a file's bytes, a local copy of a file. The page
// holds no credential and makes no request of its own; this map is the whole of what it
// can reach.
//
// No `vscode` import, so the browser harnesses under test/ answer the real page with the
// real methods, exactly as panel.js does.
// =============================================================================

// A target from the page, reduced to the strings it may carry.
const lhOf = x => ({ workspace: String(x.workspace), item: String(x.item) });
const tableOf = x => ({ schema: String(x.schema || ''), table: String(x.table) });
const RANGE = /^bytes=\d+-\d*$/;

// The engine's own methods the page may call. Everything else on the engine — opening a
// table by metadata location, writing a temp file — is the host's to do, below.
const ENGINE_METHODS = new Set(['query', 'stream', 'cancel', 'info']);

/**
 * @param {object} o
 * @param {ReturnType<import('./onelake').createOneLake>} o.onelake
 * @param {ReturnType<import('./engine-host').createEngineHost>} o.engine
 * @param {(message: string) => void} [o.onStatus]  why a catalog call is taking long
 * @param {(name: string, bytes: Uint8Array) => Promise<string|null>} [o.saveFile]
 *        ask where to save, write it, answer the path (null: dismissed)
 * @param {(x: {file: string, name: string, text: string, state: object|null}) => Promise<string>} [o.exportExplore]
 *        Export to Fabric: answers what the page says when it is done
 */
function createHostMethods({ onelake, engine, onStatus = () => {}, saveFile = null, semviews = null, exportExplore = null }) {
  const views = () => { if (!semviews) throw new Error('semantic views are not available here'); return semviews; };
  return {
    // Export to Fabric (exportapp.js): the model's text, its file's name and the Explore
    // shelves. The host asks where the local copy goes and publishes it.
    'fabric.exportExplore': async x => {
      if (!exportExplore) throw new Error('Export to Fabric is not available here');
      return exportExplore({ file: String(x.file || 'model'), name: String(x.name || 'model'),
                             text: String(x.text ?? ''), state: x.state && typeof x.state === 'object' ? x.state : null });
    },
    // Semantic views (semviews.js): the ones this machine keeps, with their .bim text, and
    // CREATE / DROP SEMANTIC VIEW carried out — dax-sql (in the page) has already checked
    // the statement. `Files/…` is relative to the lakehouse the page has open.
    'semantic.views': () => views().texts(),
    'semantic.create': async x => {
      const lh = x.workspace && x.item ? lhOf(x) : null;
      return views().put(String(x.name), views().resolve(String(x.path), lh));
    },
    'semantic.drop': async x => { await views().remove(String(x.name)); return true; },
    'onelake.table': x => onelake.table(lhOf(x), tableOf(x), { onWait: onStatus }),
    'onelake.peek': x => onelake.peek(lhOf(x), tableOf(x), sql => engine.call('query', [sql])),
    // The identifier to select a table from. The page names the table; the metadata
    // location comes from the host's own store, never from the page.
    'onelake.openTable': async x => {
      const lh = lhOf(x), t = tableOf(x);
      const meta = await onelake.table(lh, t, { onWait: onStatus });
      return engine.openTable({ ...lh, ...t, metadataLocation: meta.metadataLocation });
    },
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
      return engine.copyToTemp(`${ws}/${path}`, await onelake.readBytes(ws, path));
    },
    // Save, through the editor's save dialog: text the page made (a CSV), or a OneLake
    // file the host reads itself — its bytes never cross into the page to be saved.
    'host.saveFile': async x => {
      if (!saveFile) throw new Error('saving is not available here');
      const name = String(x.name || 'download').replace(/[\\/:*?"<>|]+/g, '_');
      const bytes = typeof x.text === 'string'
        ? Buffer.from(x.text, 'utf8')
        : await onelake.readBytes(String(x.workspace), String(x.path));
      return saveFile(name, bytes);
    },
  };
}

/** Answer one `call` from the page. Every outcome is posted — a call that never settles
 *  is a page that hangs with nothing said. */
async function answer({ methods, engine }, msg, post) {
  const { id, method, args } = msg || {};
  const list = Array.isArray(args) ? args : [];
  try {
    let value;
    // hasOwn / has: the method name comes from the page.
    if (Object.hasOwn(methods, method)) value = await methods[method](...list);
    else if (ENGINE_METHODS.has(method)) value = await engine.call(method, list, batch => post({ type: 'batch', id, batch }));
    else throw new Error(`unknown method: ${method}`);
    post({ type: 'result', id, value });
  } catch (e) {
    post({ type: 'error', id, message: (e && e.message) || String(e), cancelled: !!(e && e.cancelled) });
  }
}

module.exports = { createHostMethods, answer, ENGINE_METHODS };
