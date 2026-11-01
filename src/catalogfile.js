'use strict';
// =============================================================================
// catalogfile.js — what the extension remembers, in SQLite
// =============================================================================
// The store's entries (store.js) live in one SQLite file per account, read and written with Node's own
// node:sqlite. No DuckDB is loaded for it and no server has to be running, so the tree draws from it
// before anything else has started.
//
// Listings and table metadata are the catalog's tables (catalogtables.js), which are never evicted.
// Everything else, first rows above all, is a key and a value in `kv`, and only first rows have a budget.
//
// Each window opens the file itself, and WAL lets it read while another window writes. What another
// window wrote or cleared is noticed by a look at the file every few seconds, since no pipe joins
// windows here. It also holds which window sweeps the tenant (syncworker.js), as a lease.
//
// What an older version kept, in the state file's kv table or in JSON files, is imported once.
//
// A file's bytes stay files (store.js blobs): they can be half a gigabyte, and a row is text.
// =============================================================================

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { dirname, join } = require('node:path');
const { sqlStr } = require('./sql');
const { createCatalogTables, CATALOG_SCHEMA } = require('./catalogtables');

const SCHEMA_VERSION = 2;        // 2: listings and table metadata moved out of kv into tables
const FIRST_ROWS = 'peek␟';      // onelake.js keys.peek, as keyOf writes it
// A list only ever kept to save walking the catalog one entry at a time, which SQLite doesn't need.
const NO_LONGER_KEPT = 'catalog snapshot';
const BATCH_BYTES = 1024 * 1024;
const PAGE_ROWS = 500;
const PRUNE_EVERY = 200;         // writes between looks at the budget
const BUSY_MS = 500;             // this runs on the extension host, so it never waits long for a writer
const CLEARED_EVERY_MS = 3_000;
const OLD_IMPORTED = '(imported)';
// A store's key can hold a NUL (onelake.js). The state file had to avoid it, and its keys come here as they are.
const keyOf = key => String(key).replace(/\0/g, '␟');
// SQLite's words for a file that will never open. A locked file or a full disk isn't one.
const UNUSABLE = /not a database|malformed/i;

const shortHash = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
// Both outlive a server and an update, so they are named after the account, not the install: what is
// remembered is what lets the next version work with no internet.
const stateFileOf = (stateDir, stateKey) => join(stateDir, `state-${shortHash(stateKey)}.duckdb`);
const catalogFileOf = (stateDir, stateKey) => join(stateDir, `catalog-${shortHash(stateKey)}.sqlite`);

const SCHEMA = `
  PRAGMA busy_timeout = ${BUSY_MS};
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, ts INTEGER NOT NULL, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  ${CATALOG_SCHEMA}
`;

function setAside(file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try { fs.renameSync(f, `${f}.bad`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

/**
 * What store.js takes as `backend`: read, write, clear, size.
 * @param {object} o
 * @param {string} o.file  catalogFileOf
 * @param {() => number} [o.maxBytes]  budget; the oldest go first past it
 * @param {() => void} [o.onCleared]  another window emptied the file
 * @param {number} [o.clearedEveryMs]
 * @param {(line: string) => void} [o.log]  why the file can't be opened, once
 */
function createCatalogFile({ file, maxBytes = () => 256 * 1024 * 1024, onCleared = () => {},
                             clearedEveryMs = CLEARED_EVERY_MS, log = () => {} }) {
  let db = null, poll = null, seen = null, said = false, writes = 0;
  let statements = new Map();
  let dataVersion = null, changedFrom = 0;
  const subscribers = new Set();

  // What another connection committed: this connection's own writes don't move data_version.
  function lookForChanges() {
    const version = Number(statement('PRAGMA data_version').get().data_version);
    if (version === dataVersion) return;
    const first = dataVersion == null;
    dataVersion = version;
    if (first) return;
    const { keys, latest } = tables.changedSince(changedFrom);
    changedFrom = latest;
    if (keys.length) for (const fn of [...subscribers]) { try { fn(keys); } catch (_) {} }
  }

  const statement = sql => {
    if (!statements.has(sql)) statements.set(sql, database().prepare(sql));
    return statements.get(sql);
  };
  const tables = createCatalogTables({ statement });
  const metaOf = k => statement('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null;
  const setMeta = (k, v) => statement('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(k, v);

  function database() {
    if (db) return db;
    try {
      // Here and not at the top: a runtime without it costs what is remembered, not the activation.
      const { DatabaseSync } = require('node:sqlite');
      fs.mkdirSync(dirname(file), { recursive: true });
      const opened = () => {
        const d = new DatabaseSync(file);
        try { d.exec(SCHEMA); return d; }
        catch (e) { try { d.close(); } catch (_) {} throw e; }
      };
      try { db = opened(); }
      catch (e) {
        if (!UNUSABLE.test(e.message)) throw e;
        log(`the catalog file could not be opened, so it is set aside and started again: ${e.message}`);
        setAside(file);
        db = opened();
      }
    } catch (e) {
      if (!said) log(`the catalog file can't be read, so nothing is remembered: ${e.message}`);
      said = true;
      throw e;
    }
    migrate();
    seen = metaOf('cleared');
    changedFrom = Date.now();
    lookForChanges();
    poll = setInterval(() => {
      try {
        const now = metaOf('cleared');
        if (now !== seen) { seen = now; onCleared(); }
        lookForChanges();
      } catch (_) {}
    }, clearedEveryMs);
    if (poll.unref) poll.unref();
    return db;
  }

  function inOne(fn) {
    database().exec('BEGIN IMMEDIATE');
    try { fn(); database().exec('COMMIT'); }
    catch (e) { database().exec('ROLLBACK'); throw e; }
  }

  // One entry where it belongs: the catalog's tables if it fits them, and otherwise kv. In a transaction
  // of the caller's. A kept value that isn't JSON can't be catalog data.
  function place(k, ts, value) {
    let parsed;
    try { parsed = JSON.parse(value); } catch (_) { parsed = undefined; }
    if (parsed !== undefined && tables.write(k, k, parsed, ts)) {
      statement('DELETE FROM kv WHERE k = ?').run(k);
      return;
    }
    statement('INSERT OR REPLACE INTO kv VALUES (?, ?, ?)').run(k, ts, value);
  }

  // A file from before the tables: what it holds moves to where it now belongs, once.
  function migrate() {
    if (Number(database().prepare('PRAGMA user_version').get().user_version) >= SCHEMA_VERSION) return;
    inOne(() => {
      for (const r of database().prepare('SELECT k, ts, value FROM kv').all()) {
        if (r.k === NO_LONGER_KEPT) statement('DELETE FROM kv WHERE k = ?').run(r.k);
        else if (tables.isCatalogData(r.k)) place(r.k, r.ts, r.value);
      }
      database().exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  const firstRowsBytes = () => Number(statement(`SELECT coalesce(sum(length(value)), 0) AS total FROM kv
    WHERE k >= '${FIRST_ROWS}' AND k < '${FIRST_ROWS}￿'`).get().total);

  // Only first rows go, oldest first and down to 80%, so the next write does not land straight back
  // here. Everything else here is what offline depends on.
  function prune() {
    const limit = maxBytes();
    if (firstRowsBytes() <= limit) return;
    statement(`DELETE FROM kv WHERE k IN (
      SELECT k FROM (SELECT k, sum(length(value)) OVER (ORDER BY ts DESC, k) AS kept FROM kv
                     WHERE k >= '${FIRST_ROWS}' AND k < '${FIRST_ROWS}￿') WHERE kept > ?)`)
      .run(Math.floor(limit * 0.8));
  }

  // What an older version kept. What is already here is newer, and stays.
  function addRows(rows) {
    if (!rows.length) return;
    const inKv = statement('SELECT 1 AS found FROM kv WHERE k = ?');
    inOne(() => {
      for (const r of rows) {
        if (r.k === NO_LONGER_KEPT || tables.has(r.k, r.k) || inKv.get(r.k)) continue;
        place(r.k, r.ts, r.value);
      }
    });
  }

  // The state file's kv, a page at a time. False if it says the JSON files were imported into it, or
  // cleared since: what was taken doesn't come back from them.
  async function fromStateFile(run) {
    const found = await run(`SELECT 1 AS found FROM information_schema.tables WHERE table_name = 'kv'`);
    if (!found.length) return { rows: 0, jsonToo: true };
    let last = '', rows = 0;
    for (;;) {
      const page = await run(`SELECT k, ts, value FROM kv WHERE k > ${sqlStr(last)} AND k <> ${sqlStr(OLD_IMPORTED)} ORDER BY k LIMIT ${PAGE_ROWS}`);
      if (!page.length) break;
      addRows(page.map(r => ({ k: r.k, ts: Math.floor(Number(r.ts) || 0), value: r.value })));
      rows += page.length;
      last = page[page.length - 1].k;
    }
    return { rows, jsonToo: !(await run(`SELECT 1 AS done FROM kv WHERE k = ${sqlStr(OLD_IMPORTED)}`)).length };
  }

  async function fromJson(dir) {
    let batch = [], bytes = 0, rows = 0;
    const flush = () => { addRows(batch); rows += batch.length; batch = []; bytes = 0; };
    for (const n of await fsp.readdir(dir).catch(() => [])) {
      if (!n.endsWith('.json')) continue;
      let e = null;
      try { e = JSON.parse(await fsp.readFile(join(dir, n), 'utf8')); } catch (_) { continue; }
      if (!e || typeof e.key !== 'string') continue;
      const value = JSON.stringify(e.value);
      batch.push({ k: keyOf(e.key), ts: Math.floor(Number(e.at) || 0), value });
      bytes += value.length;
      if (bytes > BATCH_BYTES) flush();
    }
    flush();
    return rows;
  }

  return {
    async read(key) {
      const k = keyOf(key);
      database();
      const kept = tables.read(k, k);
      if (kept) return { at: Number(kept.at), json: JSON.stringify(kept.value) };
      const row = statement('SELECT ts, value FROM kv WHERE k = ?').get(k);
      return row ? { at: Number(row.ts), json: row.value } : null;
    },
    async write(key, at, json) {
      inOne(() => {
        place(keyOf(key), Math.floor(at), json);
        statement('DELETE FROM sync_state WHERE k = ?').run(keyOf(key));
      });
      if (++writes % PRUNE_EVERY === 0) prune();
    },
    /** A read of this entry failed: the last good answer is still served, and this says why it is old. */
    noteFailure(key, at, error) {
      statement('INSERT OR REPLACE INTO sync_state VALUES (?, ?, ?)').run(keyOf(key), Math.floor(at), String(error));
    },
    failureOf(key) {
      const row = statement('SELECT ts, error FROM sync_state WHERE k = ?').get(keyOf(key));
      return row ? { at: Number(row.ts), error: row.error } : null;
    },
    /** Hears the store's keys of what another window wrote. Answers how to stop. */
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    /** Whether `owner` is the one to sweep the tenant for the next `ms`: it held it, or nobody does. */
    lease(owner, ms, now = Date.now()) {
      let mine = false;
      inOne(() => {
        let held = null;
        try { held = JSON.parse(metaOf('sync_lease')); } catch (_) {}
        if (held && held.owner !== owner && held.until > now) return;
        setMeta('sync_lease', JSON.stringify({ owner, until: now + ms }));
        mine = true;
      });
      return mine;
    },
    async clear() {
      seen = crypto.randomBytes(8).toString('hex');
      inOne(() => {
        statement('DELETE FROM kv').run();
        tables.clear();
        setMeta('cleared', seen);
        // What was cleared doesn't come back from an older version's files.
        setMeta('imported', '1');
      });
    },
    // The file, or nothing if it holds nothing: an empty one still has its pages.
    async size() {
      database();
      if (!tables.anything() && !statement('SELECT EXISTS (SELECT 1 FROM kv) AS found').get().found) return 0;
      return Number(statement('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get().bytes);
    },

    imported: () => metaOf('imported') != null,
    /**
     * What an older version kept, once. Newer rows here are left alone, so this can run behind a tree
     * that is already reading and fetching. A failure marks nothing, and the next window tries again.
     * @param {object} o
     * @param {(sql: string) => Promise<object[]>} [o.run]  a statement on the state file, if there is one
     * @param {string} [o.jsonDir]  the JSON store's directory
     * @returns {Promise<number>} how many entries came across
     */
    async importKept({ run = null, jsonDir = null } = {}) {
      if (metaOf('imported') != null) return 0;
      const state = run ? await fromStateFile(run) : { rows: 0, jsonToo: true };
      const json = state.jsonToo && jsonDir ? await fromJson(jsonDir) : 0;
      setMeta('imported', '1');
      if (run) await run('DROP TABLE IF EXISTS kv');
      return state.rows + json;
    },
    close() {
      clearInterval(poll);
      poll = null;
      statements = new Map();
      if (db) { try { db.close(); } catch (_) {} }
      db = null;
    },
  };
}

module.exports = { createCatalogFile, catalogFileOf, stateFileOf, shortHash };
