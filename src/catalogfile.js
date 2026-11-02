'use strict';
// =============================================================================
// catalogfile.js — the catalog, in SQLite
// =============================================================================
// All metadata lives in one SQLite file per account (catalogtables.js), read and written with Node's own
// node:sqlite. No DuckDB is loaded for it and no server has to be running, so the tree draws from it
// before anything else has started. Only a table's first rows are ever evicted.
//
// Each window opens the file itself, and WAL lets it read while another window writes. What another
// window wrote or cleared is noticed by a look at the file every few seconds, since no pipe joins
// windows here. It also holds which window sweeps the tenant (syncworker.js), as a lease.
//
// What an older version kept, in a DuckDB state file or in JSON files, comes across once, and a file
// from an older version moves to these tables as it opens. Those old files then go.
//
// A file's bytes stay files (store.js blobs): they can be half a gigabyte, and a row is text.
// =============================================================================

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { dirname, join } = require('node:path');
const { sqlStr } = require('./sql');
const { createCatalogTables, CATALOG_SCHEMA } = require('./catalogtables');

const SCHEMA_VERSION = 4;
const BATCH_BYTES = 1024 * 1024;
const PAGE_ROWS = 500;
const BUSY_MS = 500;             // this runs on the extension host, so it never waits long for a writer
const CLEARED_EVERY_MS = 3_000;
const OLD_IMPORTED = '(imported)';
const FIRST_ROWS_MAX_BYTES = 256 * 1024 * 1024;
const TRIM_EVERY = 200;          // writes between looks at that
// SQLite's words for a file that will never open. A locked file or a full disk isn't one.
const UNUSABLE = /not a database|malformed/i;

const shortHash = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
// Both outlive a server and an update, so they are named after the account, not the install: what is
// remembered is what lets the next version work with no internet.
// An older version's: what it held comes across once (oldstate.js), and it goes.
const stateFileOf = (stateDir, stateKey) => join(stateDir, `state-${shortHash(stateKey)}.duckdb`);
const catalogFileOf = (stateDir, stateKey) => join(stateDir, `catalog-${shortHash(stateKey)}.sqlite`);

const SCHEMA = `
  PRAGMA busy_timeout = ${BUSY_MS};
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  ${CATALOG_SCHEMA}
`;

function setAside(file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try { fs.renameSync(f, `${f}.bad`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

/**
 * What store.js takes as `backend`: read, write, clear, size. A key is the store's (onelake.js); what it
 * asks for lives in that key's table.
 * @param {object} o
 * @param {string} o.file  catalogFileOf
 * @param {() => void} [o.onCleared]  another window emptied the file
 * @param {number} [o.clearedEveryMs]
 * @param {(line: string) => void} [o.log]  why the file can't be opened, once
 * @param {number} [o.firstRowsMaxBytes]
 */
function createCatalogFile({ file, onCleared = () => {}, clearedEveryMs = CLEARED_EVERY_MS, log = () => {},
                             firstRowsMaxBytes = FIRST_ROWS_MAX_BYTES }) {
  let db = null, poll = null, seen = null, said = false, writes = 0;
  let statements = new Map();
  let dataVersion = null, changedFrom = 0, toldAt = new Set();
  const subscribers = new Set();

  // What another connection committed: this connection's own writes don't move data_version.
  function lookForChanges() {
    const version = Number(statement('PRAGMA data_version').get().data_version);
    if (version === dataVersion) return;
    const first = dataVersion == null;
    dataVersion = version;
    if (first) return;
    const { keys, latest, atLatest } = tables.changedSince(changedFrom);
    if (!keys.length) return;
    // What has the time looked from was told last time. Any commit moves data_version, a lease's too.
    const news = keys.filter(k => !toldAt.has(k));
    changedFrom = latest;
    toldAt = atLatest;
    if (news.length) for (const fn of [...subscribers]) { try { fn(news); } catch (_) {} }
  }

  const statement = sql => {
    if (!statements.has(sql)) statements.set(sql, database().prepare(sql));
    return statements.get(sql);
  };
  const tables = createCatalogTables({ statement });
  const state = () => statement('SELECT * FROM catalog_state WHERE id = 1').get() || {};

  function database() {
    if (db) return db;
    const began = Date.now();
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
    log(`catalog: opened ${file}, schema ${version()}, in ${Date.now() - began}ms`);
    seen = state().cleared ?? null;
    changedFrom = Date.now();
    lookForChanges();
    poll = setInterval(() => {
      try {
        const now = state().cleared ?? null;
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

  // An entry an older version kept, where it now belongs. One that doesn't fit its table, or has none,
  // is left behind: it is only a cache, and is read again when it is needed. In a caller's transaction.
  function place(k, ts, value) {
    let parsed;
    try { parsed = JSON.parse(value); } catch (_) { return; }
    tables.write(k, parsed, ts);
  }

  const version = () => Number(db.prepare('PRAGMA user_version').get().user_version);

  // The tables an older version of this file had, moved to these and gone. Once, for one window.
  function migrate() {
    if (version() >= SCHEMA_VERSION) return;
    inOne(() => {
      if (version() >= SCHEMA_VERSION) return;
      log(`catalog: moving from schema ${version()} to ${SCHEMA_VERSION}`);
      const has = t => !!db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      db.exec('INSERT OR IGNORE INTO catalog_state (id) VALUES (1)');
      if (has('kv')) {
        for (const r of db.prepare('SELECT k, ts, value FROM kv').all()) place(r.k, r.ts, r.value);
        db.exec('DROP TABLE kv');
      }
      if (has('listing')) {
        for (const r of db.prepare('SELECT k, ts FROM listing').all()) tables.stamp(r.k, r.ts);
        db.exec('DROP TABLE listing');
      }
      if (has('sync_state')) db.exec('DROP TABLE sync_state');
      if (has('meta')) {
        const old = k => db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null;
        db.prepare('UPDATE catalog_state SET cleared = ?, imported = ?, views_imported = ? WHERE id = 1')
          .run(old('cleared'), old('imported') != null ? 1 : 0, old('views-imported') != null ? 1 : 0);
        db.exec('DROP TABLE meta');
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  // What an older version kept. What is already here is newer, and stays.
  function addRows(rows) {
    if (!rows.length) return;
    inOne(() => {
      for (const r of rows) if (!tables.has(r.k)) place(r.k, r.ts, r.value);
    });
  }

  // The state file's old table, a page at a time. False if it says the JSON files were imported into
  // it, or cleared since: what was taken doesn't come back from them.
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
      batch.push({ k: e.key, ts: Math.floor(Number(e.at) || 0), value });
      bytes += value.length;
      if (bytes > BATCH_BYTES) flush();
    }
    flush();
    return rows;
  }

  return {
    async read(key) {
      database();
      const kept = tables.read(key);
      return kept ? { at: Number(kept.at), value: kept.value } : null;
    },
    /** Fails on what has no table: every key the store is asked to keep has one. */
    async write(key, at, value) {
      inOne(() => {
        if (!tables.write(key, value, Math.floor(at))) throw new Error(`the catalog has no table for ${String(key).split('\0')[0]}`);
        tables.clearFailure(key);
      });
      if (++writes % TRIM_EVERY === 0) inOne(() => tables.trimFirstRows(firstRowsMaxBytes));
    },
    /** A read of this entry failed: the last good answer is still served, and this says why it is old. */
    noteFailure(key, at, error) { tables.noteFailure(key, Math.floor(at), String(error)); },
    failureOf(key) { database(); return tables.failureOf(key); },
    keptAt(key) { database(); return tables.keptAt(key); },
    allTables() { database(); return tables.allTables(); },
    latestRead(dir) { database(); return tables.latestRead(dir); },
    // Which tables are in use, and what was read of them whole (syncworker.js).
    noteUse(list, day) { inOne(() => tables.noteUse(list, day)); },
    tablesInUse(fromDay, minReads, most) { database(); return tables.tablesInUse(fromDay, minReads, most); },
    readsOf(t, fromDay) { database(); return tables.readsOf(t, fromDay); },
    keptAs(t, location) { database(); return tables.keptAs(t, location); },
    latestKept(t) { database(); return tables.latestKept(t); },
    noteKept(t, kept) { inOne(() => tables.noteKept(t, kept)); },
    keptSince(at) { database(); return tables.keptSince(at); },
    pruneUse(fromDay, fromAt) { inOne(() => tables.pruneUse(fromDay, fromAt)); },
    /** Hears the store's keys of what another window wrote. Answers how to stop. */
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    /** Whether `owner` is the one to sweep the tenant for the next `ms`: it held it, or nobody does. */
    lease(owner, ms, now = Date.now()) {
      let mine = false;
      inOne(() => {
        const held = state();
        if (held.lease_owner != null && held.lease_owner !== owner && held.lease_until > now) return;
        statement('UPDATE catalog_state SET lease_owner = ?, lease_until = ? WHERE id = 1').run(owner, now + ms);
        mine = true;
      });
      return mine;
    },
    async clear() {
      seen = crypto.randomBytes(8).toString('hex');
      inOne(() => {
        tables.clear();
        // What was cleared doesn't come back from an older version's files.
        statement('UPDATE catalog_state SET cleared = ?, imported = 1 WHERE id = 1').run(seen);
      });
      // The space too. Another window's read in the way only leaves it in the file, for the next rows.
      try { database().exec('VACUUM'); database().exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) {}
    },
    // The file, or nothing if it holds nothing: an empty one still has its pages.
    async size() {
      database();
      if (!tables.anything()) return 0;
      return Number(statement('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get().bytes);
    },

    // The semantic models opened here, for semviews.js.
    views: () => tables.views(),
    /** Replaces whichever views `same` picks with this one, in one step. */
    keepView(view, same) {
      inOne(() => {
        for (const v of tables.views()) if (same(v)) tables.removeView(v.id);
        tables.addView(view);
      });
    },
    /** The pointers an older version kept in a JSON file, once. The file then goes. */
    importViews(jsonFile) {
      database();
      if (state().views_imported) return null;
      let kept = [];
      try { kept = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch (_) {}
      inOne(() => {
        if (Array.isArray(kept)) for (const v of kept) if (v && v.name && v.path) tables.addView(v);
        statement('UPDATE catalog_state SET views_imported = 1 WHERE id = 1').run();
      });
      try { fs.rmSync(jsonFile, { force: true }); } catch (_) {}
      return Array.isArray(kept) ? kept.length : 0;
    },

    /** What is in it, for `status` and the log. */
    describe() {
      database();
      const size = f => { try { return fs.statSync(f).size; } catch (_) { return 0; } };
      const { imported, views_imported: viewsImported, lease_until: leaseUntil } = state();
      return { file, bytes: size(file) + size(`${file}-wal`), schema: version(), imported: !!imported, viewsImported: !!viewsImported,
               leaseUntil: leaseUntil ?? null, rows: { ...tables.counts() } };
    },

    imported() { database(); return !!state().imported; },
    /**
     * What an older version kept, once. Newer rows here are left alone, so this can run behind a tree
     * that is already reading and fetching. A failure marks nothing, and the next window tries again.
     * @param {object} o
     * @param {(sql: string) => Promise<object[]>} [o.run]  a statement on the state file, if there is one
     * @param {string} [o.jsonDir]  the JSON store's directory
     * @returns {Promise<number>} how many entries came across
     */
    async importKept({ run = null, jsonDir = null } = {}) {
      database();
      if (state().imported) return 0;
      const old = run ? await fromStateFile(run) : { rows: 0, jsonToo: true };
      const json = old.jsonToo && jsonDir ? await fromJson(jsonDir) : 0;
      statement('UPDATE catalog_state SET imported = 1 WHERE id = 1').run();
      return old.rows + json;
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
