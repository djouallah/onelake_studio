'use strict';
// =============================================================================
// localtables.js — which tables have every file on this machine
// =============================================================================
// The tree's check on a table says its data is here: every data file of its snapshot, in the lake's copies, none
// left only on OneLake. The lake knows that (onelaketable.js localAll), and only an engine can ask the lake, so
// what it last said is kept in a file beside the lake: the tree draws from it with no engine and no internet.
// While an engine runs it is asked again every few seconds, as downloads finish.
// No `vscode` import.
// =============================================================================

const { readFileSync, writeFileSync, renameSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');

const EVERY_MS = 5_000;

// A table's folder, as the lake names it (engine-host.js folderOf): abfs:// and abfss:// are the same place.
const folderKey = f => String(f || '').replace(/^abfs:\/\//i, 'abfss://').replace(/\/+$/, '').toLowerCase();

/**
 * @param {object} o
 * @param {() => string|null} o.file  where it is kept for the account now, or null to keep nothing
 * @param {() => ({ lakeLocal: () => Promise<{folder: string, files: number, remote: number}[]> }|null)} o.engine
 * @param {(folders: string[]) => void} [o.onChange]  the folders whose answer changed
 * @param {(line: string) => void} [o.log]
 */
function createLocalTables({ file, engine, onChange = () => {}, log = () => {}, everyMs = EVERY_MS }) {
  let local = new Set(), from = undefined, timer = null, asking = null;

  function load() {
    const f = file();
    if (f === from) return;
    from = f;
    local = new Set();
    if (!f) return;
    try { local = new Set(JSON.parse(readFileSync(f, 'utf8')).map(folderKey)); } catch (_) { /* none yet */ }
  }

  function keep(next) {
    const f = file();
    if (!f) return;
    mkdirSync(dirname(f), { recursive: true });
    const partial = `${f}.${process.pid}.tmp`;
    writeFileSync(partial, JSON.stringify([...next].sort()));
    renameSync(partial, f);
  }

  async function refresh() {
    const e = engine();
    if (!e || !e.lakeLocal) return;
    const rows = await e.lakeLocal();
    load();
    const next = new Set(rows.filter(r => Number(r.remote) === 0).map(r => folderKey(r.folder)));
    const changed = [...next].filter(f => !local.has(f)).concat([...local].filter(f => !next.has(f)));
    if (!changed.length) return;
    local = next;
    keep(next);
    onChange(changed);
  }

  return {
    /** Whether every data file of the table in `folder` is on this machine. */
    has(folder) { load(); return local.has(folderKey(folder)); },
    refresh: () => (asking = asking || refresh().finally(() => { asking = null; })),
    start() {
      if (timer) return;
      timer = setInterval(() => {
        this.refresh().catch(e => log(`which tables are on this machine could not be read: ${(e && e.message) || e}`));
      }, everyMs);
      if (timer.unref) timer.unref();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { createLocalTables, folderKey };
