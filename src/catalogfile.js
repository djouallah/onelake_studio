'use strict';
// =============================================================================
// catalogfile.js — what the extension remembers, in SQLite
// =============================================================================
// The store's entries (store.js: listings, table metadata, first rows) live in one SQLite file per
// account, read and written with Node's own node:sqlite. No DuckDB is loaded for it and no server has
// to be running, so the tree draws from it before anything else has started.
//
// Each window opens the file itself, and WAL lets it read while another window writes. Another
// window's Clear is noticed by a look at the file every few seconds, since no pipe joins windows here.
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

  const statement = sql => {
    if (!statements.has(sql)) statements.set(sql, database().prepare(sql));
    return statements.get(sql);
  };
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
    seen = metaOf('cleared');
    poll = setInterval(() => {
      try {
        const now = metaOf('cleared');
        if (now !== seen) { seen = now; onCleared(); }
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

  const total = () => Number(statement('SELECT coalesce(sum(length(value)), 0) AS total FROM kv').get().total);

  function prune() {
    const limit = maxBytes();
    if (total() <= limit) return;
    // Oldest first, down to 80%, so the next write does not land straight back here.
    statement(`DELETE FROM kv WHERE k IN (
      SELECT k FROM (SELECT k, sum(length(value)) OVER (ORDER BY ts DESC, k) AS kept FROM kv) WHERE kept > ?)`)
      .run(Math.floor(limit * 0.8));
  }

  function addRows(rows) {
    if (!rows.length) return;
    const add = statement('INSERT OR IGNORE INTO kv VALUES (?, ?, ?)');
    inOne(() => { for (const r of rows) add.run(r.k, r.ts, r.value); });
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
      const row = statement('SELECT ts, value FROM kv WHERE k = ?').get(keyOf(key));
      return row ? { at: Number(row.ts), json: row.value } : null;
    },
    async write(key, at, json) {
      statement('INSERT OR REPLACE INTO kv VALUES (?, ?, ?)').run(keyOf(key), Math.floor(at), json);
      if (++writes % PRUNE_EVERY === 0) prune();
    },
    async clear() {
      seen = crypto.randomBytes(8).toString('hex');
      inOne(() => {
        statement('DELETE FROM kv').run();
        setMeta('cleared', seen);
        // What was cleared doesn't come back from an older version's files.
        setMeta('imported', '1');
      });
    },
    async size() { return total(); },

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
