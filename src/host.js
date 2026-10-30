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

const { relative, resolve, isAbsolute } = require('node:path');
// A target from the page, reduced to the strings it may carry.
const { sqlNameOf } = require('./names');

const lhOf = x =>({ workspace: String(x.workspace), item: String(x.item) });
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
 * @param {(list: {workspace: string, item: string, schema: string, table: string}[]) => Promise<string[]>} [o.nameTables]
 *        a semantic model's Direct Lake tables (named by GUID) -> their SQL names
 * @param {(x: {sql: string, name: string}) => Promise<string|null>} [o.exportResult]
 *        Export: the query's every row to a file the user picks; its path (null: dismissed)
 * @param {(x: {as: string, content: string}) => Promise<void>} [o.openDocument]
 *        rows as an untitled CSV or JSON document
 * @param {(text: string) => Promise<void>} [o.copyText]
 *        text on the clipboard (the grid's copies)
 * @param {(x: {sql: string}) => Promise<void>} [o.editSql]
 *        Edit SQL: the SQL in a new query editor
 * @param {(x: {id: number, ok: boolean, error: string|null, rewritten: boolean, rows?: number, ms?: number}) => void} [o.queryDone]
 *        how a statement the query editor sent went
 * @param {(x: {workspace: string, model: string}) => Promise<object>} [o.openModel]
 *        a semantic model a query names, opened from its local copy (read from Fabric the first
 *        time) and kept as a view: { name, schema, path, text }
 */
function createHostMethods({ onelake, engine, onStatus = () => {}, saveFile = null, semviews = null, exportExplore = null,
                             nameTables = null, exportResult = null, openDocument = null, copyText = null, editSql = null, queryDone = null, openModel = null, modelsDir = null }) {
  const views = () => { if (!semviews) throw new Error('semantic views are not available here'); return semviews; };
  return {
    // Export to Fabric (exportapp.js): the model's text (to check it), where it lives in
    // OneLake (the app reads it there), its name and the Explore shelves. The host asks where
    // the local copy goes and publishes it.
    'fabric.exportExplore': async x => {
      if (!exportExplore) throw new Error('Export to Fabric is not available here');
      // A OneLake file (workspace + path), or a semantic model opened from its local copy
      // (model: { workspace, name }), which the export writes into its lakehouse.
      const model = x.model && x.model.workspace && x.model.name
        ? { workspace: String(x.model.workspace), name: String(x.model.name) } : null;
      if (!(x.workspace && x.path) && !model) {
        throw new Error('Export to Fabric needs a model that is a OneLake file, or one opened from the tree');
      }
      return exportExplore({ file: String(x.file || 'model'), name: String(x.name || 'model'),
                             text: String(x.text ?? ''),
                             ...(x.workspace && x.path ? { workspace: String(x.workspace), path: String(x.path) } : { model }),
                             state: x.state && typeof x.state === 'object' ? x.state : null });
    },
    // Semantic models (semviews.js): the ones this machine keeps, with their text, and one the
    // page just opened kept — its name in its schema, the model's workspace, so SQL names it
    // semanticmodel.ws.model. The path is a local file or an abfss:// URL.
    'semantic.views': () => views().texts(),
    'semantic.keep': async x => {
      if (!x.schema) throw new Error('a semantic model is kept in its workspace');
      const path = String(x.path);
      // The page names a model's local copy or a OneLake file — never any other file on disk.
      if (modelsDir && !/^abfss:\/\//i.test(path)) {
        const rel = relative(resolve(modelsDir), resolve(path));
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${path}: not a semantic model's local copy`);
      }
      return views().put(String(x.name), path, String(x.schema));
    },
    // A semantic model a query names and the page has no view of: opened and kept (openModel).
    'semantic.open': async x => {
      if (!openModel) throw new Error('semantic models are not available here');
      return openModel({ workspace: String(x.workspace), model: String(x.model) });
    },
    // A table's metadata, and its SQL name (lakehouse.ws.item.schema.table) for the editor.
    'onelake.table': async x => {
      const lh = lhOf(x), t = tableOf(x);
      let sqlName = null;
      try { sqlName = sqlNameOf(lh, t); } catch (_) { /* an item SQL cannot name */ }
      return { ...await onelake.table(lh, t, { onWait: onStatus }), sqlName };
    },
    // A semantic model's Direct Lake tables, which it names by GUID, as SQL names.
    'onelake.nameTables': async list => {
      if (!nameTables) throw new Error('semantic models are not available here');
      return nameTables((Array.isArray(list) ? list : []).map(x => ({
        workspace: String(x.workspace), item: String(x.item), schema: String(x.schema || 'dbo'), table: String(x.table),
      })));
    },
    // A Delta table's own log: its state as of the converted version, and its commits a
    // page at a time. The engine is passed for the checkpoint, the one log file that is parquet.
    'onelake.deltaState': x => onelake.deltaState(lhOf(x), tableOf(x), { run: sql => engine.call('query', [sql]) }),
    'onelake.deltaHistory': x => onelake.deltaHistory(lhOf(x), tableOf(x),
      { skip: Number.isSafeInteger(x.skip) && x.skip > 0 ? x.skip : 0 }),
    'onelake.peek': x => onelake.peek(lhOf(x), tableOf(x), sql => engine.call('query', [sql])),
    // The table, opened: its SQL name, the view behind it made. The page names the table;
    // the metadata location comes from the host's own store, never from the page.
    'onelake.openTable': async x => {
      const lh = lhOf(x), t = tableOf(x);
      await onelake.table(lh, t, { onWait: onStatus });
      return engine.openTable({ ...lh, ...t });
    },
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
      // Bytes are read only when this session has no copy yet.
      return engine.copyToTemp(`${ws}/${path}`, () => onelake.readBytes(ws, path));
    },
    // Save, through the editor's save dialog: text the page made (a CSV), or a OneLake
    // file the host reads itself — its bytes never cross into the page to be saved.
    'host.saveFile': async x => {
      if (!saveFile) throw new Error('saving is not available here');
      const name = String(x.name || 'download').replace(/[\\/:*?"<>|]+/g, '_');
      // A OneLake file is read after the dialog: a cancelled save downloads nothing.
      const bytes = typeof x.text === 'string'
        ? Buffer.from(x.text, 'utf8')
        : () => onelake.readBytes(String(x.workspace), String(x.path));
      return saveFile(name, bytes);
    },
    // Export: the query on screen, every row, to a CSV, Parquet or Excel file (the host asks
    // which and where, and its DuckDB writes it).
    'host.exportResult': async x => {
      if (!exportResult) throw new Error('export is not available here');
      return exportResult({ sql: String((x && x.sql) ?? ''), name: String((x && x.name) || 'query') });
    },
    'host.openDocument': async x => {
      if (!openDocument) throw new Error('documents are not available here');
      await openDocument({ as: x && x.as === 'json' ? 'json' : 'csv', content: String((x && x.content) ?? '') });
    },
    // The grid's copies: the clipboard is the editor's, not the page's.
    'host.copyText': async x => {
      if (!copyText) throw new Error('the clipboard is not available here');
      await copyText(String((x && x.text) ?? ''));
    },
    // Edit SQL: the SQL on the panel's screen, in a new query editor (queryeditor.js).
    'host.editSql': async x => {
      if (!editSql) throw new Error('query editors are not available here');
      await editSql({ sql: String((x && x.sql) ?? '') });
    },
    // A statement the query editor sent, run (or planned) by the page: how it went.
    'host.queryDone': async x => {
      const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
      if (queryDone && x) queryDone({ id: Number(x.id), ok: !!x.ok, error: x.error == null ? null : String(x.error),
                                      rewritten: !!x.rewritten, rows: num(x.rows), ms: num(x.ms) });
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
