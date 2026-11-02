'use strict';
// =============================================================================
// modeldata.js — Download Data: every table a semantic model reads, brought to this machine
// =============================================================================
// Reading a table whole through the engine is what fills the disk cache: every column of every file,
// and no row comes back (engine-host.js keepTable). After it the model answers from disk, and with
// no connection. The idle job in syncworker.js reads the same way, but it was nobody's request: it
// waits for quiet, gives way to any statement, and stays under a budget. This one was asked for. It
// goes now, one table at a time, with statements running beside it, until it's done or stopped. A
// table stopped part way keeps what it read, so the next click carries on from there.
//
// No `vscode` import: the extension hands in what it needs, and says how it's going.
// =============================================================================
const { SQL_KINDS, fmtBytes } = require('./names');
const { tableRefs } = require('./sql');

/**
 * @param {object} o
 * @param {(catalog: string) => Promise<string[]>} o.tablesOf  a model's tables, by their SQL names
 * @param {(ref: object, o: { fresh: boolean }) => Promise<object>} o.resolve  sqltables.js resolve
 * @param {(t: object) => Promise<{ value: object }|null>} o.cachedTable  a table's kept metadata
 * @param {(name: string, o: { signal: AbortSignal }) => Promise<any>} o.read  a table, read whole
 * @param {{ kept: Function, noteKept: Function }} o.usage  what's been read whole (onelake.js)
 * @param {() => string|null} o.offlineReason
 * @param {() => number} o.maxBytes  what the disk cache may hold. 0 is no disk cache
 * @param {(line: string) => void} [o.log]
 * @param {() => number} [o.now]
 */
function createModelData({ tablesOf, resolve, cachedTable, read, usage, offlineReason, maxBytes, log = () => {}, now = Date.now }) {
  const running = new Map();   // lower-cased SQL name -> Promise of what to say

  // Past the cache: this is for the snapshot it's at now, not the one last seen.
  async function locate(ident) {
    const [ref] = tableRefs(ident, SQL_KINDS);
    if (!ref) throw new Error(`${ident} does not name a table`);
    const named = await resolve(ref, { fresh: true });
    if (!named.metadataLocation) return null;   // an empty table has nothing to bring down
    const held = await cachedTable(named.listed).catch(() => null);
    const size = Number(held && held.value && held.value.stats && held.value.stats.totalFilesSize) || 0;
    return { name: ident, t: named.listed, location: named.metadataLocation, size };
  }

  async function run(catalog, model, { signal, say }) {
    const offline = offlineReason();
    if (offline) throw new Error(`Downloading ${model}'s data needs a connection, and ${offline}.`);
    const room = maxBytes();
    if (!(room > 0)) throw new Error(`Downloading ${model}'s data needs the disk cache, and onelakeStudio.diskCacheMaxGB turns it off.`);
    say('reading what its tables hold now…');
    const idents = await tablesOf(catalog);
    if (!idents.length) throw new Error(`${model} reads no tables in OneLake.`);
    const failed = [];
    const tables = [];
    for (const ident of idents) {
      if (signal.aborted) break;
      try {
        const t = await locate(ident);
        if (t) tables.push(t);
      } catch (e) { failed.push({ name: ident, error: e.message }); }
    }
    const total = tables.reduce((n, t) => n + t.size, 0);
    if (total > room) {
      throw new Error(`${model}'s tables hold ${fmtBytes(total)}, and the disk cache holds ${fmtBytes(room)}: raise onelakeStudio.diskCacheMaxGB to download them.`);
    }
    const todo = tables.filter(t => { const k = usage.kept(t.t, t.location); return !k || k.error; });
    log(`model data: ${model}: ${tables.length} table(s), ${fmtBytes(total)}, ${todo.length} to read`);

    let done = tables.length - todo.length;
    for (const [i, t] of todo.entries()) {
      if (signal.aborted) break;
      say(`${i + 1} of ${todo.length}: ${t.name.split('.').pop()}, ${fmtBytes(t.size)}`);
      const began = now();
      try {
        await read(t.name, { signal });
        // Nothing of the idle job's daily budget went on this: nobody asked that job for it.
        usage.noteKept(t.t, { location: t.location, at: now(), total: t.size, bytes: 0, ms: now() - began, error: null, retryAt: 0 });
        done++;
        log(`model data: ${t.name}, ${fmtBytes(t.size)}, in ${Math.round((now() - began) / 1000)}s`);
      } catch (e) {
        if (signal.aborted) break;
        failed.push({ name: t.name, error: (e && e.message) || String(e) });
        log(`model data: ${t.name} failed — ${(e && e.message) || e}`);
      }
    }
    if (signal.aborted) return `Stopped with ${done} of ${tables.length} tables of ${model} down. What was read stays, and Download Data carries on from there.`;
    if (failed.length) {
      throw new Error(`${done} of ${tables.length + failed.filter(f => !tables.some(t => t.name === f.name)).length} tables of ${model} came down. ` +
        failed.map(f => `${f.name}: ${f.error}`).join('; '));
    }
    return `${model} is on this machine: ${tables.length} table${tables.length === 1 ? '' : 's'}, ${fmtBytes(total)}. It answers from disk now, with or without a connection.`;
  }

  return {
    // Whether one is under way: the idle job holds off, or the two would read the same bytes twice.
    busy: () => running.size > 0,
    /** Answers what to tell the user. A second click on one under way joins it. */
    download(catalog, model, { signal = new AbortController().signal, say = () => {} } = {}) {
      const key = String(catalog).toLowerCase();
      if (!running.has(key)) {
        running.set(key, run(catalog, model, { signal, say }).finally(() => running.delete(key)));
      }
      return running.get(key);
    },
  };
}

module.exports = { createModelData };
