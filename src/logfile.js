'use strict';
// =============================================================================
// logfile.js — what the engine ran, in a SQLite file of its own
// =============================================================================
// The log isn't metadata about OneLake, so it isn't in the catalog: Clear Cached leaves it, and it can
// grow without touching what the tree reads. The server writes it (enginelog.js) and answers the Logs tab
// from it. A file that won't open is set aside and started again, and with no file at all the engine
// runs on with no log.
// =============================================================================

const fs = require('node:fs');
const { dirname, join } = require('node:path');
const { shortHash } = require('./catalogfile');

const SCHEMA = `
  PRAGMA busy_timeout = 500;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS logs (ts INTEGER, win TEXT, sql TEXT, ms INTEGER, status TEXT, error TEXT, conn TEXT);
  CREATE INDEX IF NOT EXISTS logs_ts ON logs (ts);
`;
const UNUSABLE = /not a database|malformed/i;

// Named after the account, not the install, so an update keeps it.
const logFileOf = (stateDir, stateKey) => join(stateDir, `logs-${shortHash(stateKey)}.sqlite`);

/**
 * @param {object} o
 * @param {string} o.file  logFileOf
 * @param {(line: string) => void} [o.log]  why the file was set aside
 */
function createLogFile({ file, log = () => {} }) {
  let db = null;

  function database() {
    if (db) return db;
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
      log(`the log file could not be opened, so it is set aside and started again: ${e.message}`);
      for (const f of [file, `${file}-wal`, `${file}-shm`]) {
        try { fs.renameSync(f, `${f}.bad`); } catch (x) { if (x.code !== 'ENOENT') throw x; }
      }
      db = opened();
    }
    return db;
  }

  return {
    /** @param {{at: number, window: string, sql: string, ms: number, status: string, error: string|null, conn: string}[]} rows */
    add(rows) {
      if (!rows.length) return;
      const insert = database().prepare('INSERT INTO logs VALUES (?, ?, ?, ?, ?, ?, ?)');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const r of rows) insert.run(r.at, r.window, r.sql, r.ms, r.status, r.error ?? null, r.conn ?? null);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    /** The newest first: `limit` statements, and as many of the engine's setup beside them. Each start
     * registers every table there is, thousands of them, and the newest rows were only that. */
    read(limit) {
      // enginelog.js isSetup, in SQL.
      const SETUP = ['create', 'drop', 'attach', 'detach'].map(w => `lower(ltrim(sql, ' ' || char(9, 10, 13))) GLOB '${w}[^a-z0-9_]*'`).join(' OR ');
      return database().prepare(`SELECT * FROM (SELECT ts, win, sql, ms, status, error FROM logs WHERE NOT (${SETUP}) ORDER BY ts DESC LIMIT ?)
        UNION ALL SELECT * FROM (SELECT ts, win, sql, ms, status, error FROM logs WHERE ${SETUP} ORDER BY ts DESC LIMIT ?)
        ORDER BY ts DESC`).all(limit, limit);
    },
    clear() { database().exec('DELETE FROM logs'); },
    // The oldest go, down to half, so this isn't at the limit again at once.
    trim(maxBytes) {
      // The pages in use say it fits with nothing read. The sum below reads up to a gigabyte's rows, on the
      // one thread the server has to answer its windows.
      const { live } = database().prepare('SELECT (page_count - freelist_count) * page_size AS live FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()').get();
      if (live <= maxBytes) return;
      const size = 'octet_length(sql) + coalesce(octet_length(error), 0)';
      const { total } = db.prepare(`SELECT coalesce(sum(${size}), 0) AS total FROM logs`).get();
      if (total <= maxBytes) return;
      db.prepare(`DELETE FROM logs WHERE ts <= (
        SELECT max(ts) FROM (SELECT ts, sum(${size}) OVER (ORDER BY ts DESC) AS kept FROM logs) WHERE kept > ?)`)
        .run(Math.floor(maxBytes / 2));
    },
    close() {
      if (db) { try { db.close(); } catch (_) {} }
      db = null;
    },
  };
}

module.exports = { createLogFile, logFileOf };
