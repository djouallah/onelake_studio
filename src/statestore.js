'use strict';
// =============================================================================
// statestore.js — what the extension remembers, in DuckDB
// =============================================================================
// On the shared engine the store's entries (store.js: listings, table metadata, first rows) live in
// a table in the server's state file, one per account, in place of one JSON file per key. A kept
// answer that used to be a file is imported once. Those files are left where they are, so turning
// the setting off finds them, as they were when it was turned on.
//
// A file's bytes stay files (store.js blobs): they can be half a gigabyte, and a statement is text.
// =============================================================================

const fs = require('node:fs/promises');
const { join } = require('node:path');
const { sqlStr } = require('./sql');

const IMPORTED = '(imported)';
const BATCH_BYTES = 1024 * 1024;
const PRUNE_EVERY = 200;      // writes between looks at the budget
// A store's key can hold a NUL (onelake.js), which ends a statement's text. U+241F isn't in one.
const keyOf = key => sqlStr(String(key).replace(/\0/g, '␟'));

/**
 * @param {object} o
 * @param {(sql: string) => Promise<object[]>} o.run  a statement on the state file (createStateClient)
 * @param {string|null} [o.importFrom]  the JSON store's directory
 * @param {() => number} [o.maxBytes]  budget; the oldest go first past it
 */
function createStateBackend({ run, importFrom = null, maxBytes = () => 256 * 1024 * 1024 }) {
  async function importOnce() {
    const done = await run(`SELECT 1 AS done FROM kv WHERE k = ${sqlStr(IMPORTED)}`);
    if (done.length) return;
    const names = importFrom ? await fs.readdir(importFrom).catch(() => []) : [];
    let batch = [], bytes = 0;
    const flush = async () => {
      if (batch.length) await run(`INSERT OR REPLACE INTO kv VALUES ${batch.join(',\n')}`);
      batch = []; bytes = 0;
    };
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      let e = null;
      try { e = JSON.parse(await fs.readFile(join(importFrom, n), 'utf8')); } catch (_) { continue; }
      if (!e || typeof e.key !== 'string') continue;
      const value = JSON.stringify(e.value);
      batch.push(`(${keyOf(e.key)}, ${Math.floor(Number(e.at) || 0)}, ${sqlStr(value)})`);
      bytes += value.length;
      if (bytes > BATCH_BYTES) await flush();
    }
    await flush();
    await run(`INSERT OR REPLACE INTO kv VALUES (${sqlStr(IMPORTED)}, 0, '')`);
  }
  // Once it worked: a failure is tried again by the next read.
  let ready = null;
  const opened = () => {
    if (!ready) ready = importOnce().catch(e => { ready = null; throw e; });
    return ready;
  };

  let writes = 0;
  async function prune() {
    const limit = maxBytes();
    const [{ total }] = await run('SELECT coalesce(sum(length(value)), 0)::BIGINT AS total FROM kv');
    if (Number(total) <= limit) return;
    // Oldest first, down to 80%, as the files were.
    await run(`DELETE FROM kv WHERE k <> ${sqlStr(IMPORTED)} AND k IN (
      SELECT k FROM (SELECT k, sum(length(value)) OVER (ORDER BY ts DESC, k) AS kept FROM kv) WHERE kept > ${Math.floor(limit * 0.8)})`);
  }

  return {
    async read(key) {
      await opened();
      const rows = await run(`SELECT ts, value FROM kv WHERE k = ${keyOf(key)}`);
      return rows.length ? { at: Number(rows[0].ts), json: rows[0].value } : null;
    },
    async write(key, at, json) {
      await opened();
      await run(`INSERT OR REPLACE INTO kv VALUES (${keyOf(key)}, ${Math.floor(at)}, ${sqlStr(json)})`);
      if (++writes % PRUNE_EVERY === 0) await prune();
    },
    async clear() {
      await opened();
      // Still marked as imported: what was cleared doesn't come back from the old files.
      await run(`DELETE FROM kv WHERE k <> ${sqlStr(IMPORTED)}`);
    },
    async size() {
      await opened();
      const [{ total }] = await run('SELECT coalesce(sum(length(value)), 0)::BIGINT AS total FROM kv');
      return Number(total);
    },
  };
}

module.exports = { createStateBackend };
