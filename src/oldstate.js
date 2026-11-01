'use strict';
// =============================================================================
// oldstate.js — an older version's DuckDB state file, read once
// =============================================================================
// Before the catalog file, what the extension remembered and its log were tables in a DuckDB file. What
// they held comes across (catalogfile.js importKept), and the file goes. This is the one thing a window
// loads DuckDB for without being asked to run anything, and only while such a file is there.
// =============================================================================

/**
 * @param {string} file  stateFileOf
 * @returns {Promise<{ run: (sql: string) => Promise<object[]>, logs: () => Promise<object[]>, close: () => void }>}
 *   Fails if another process holds it: a server of the version just updated from, until its window reloads.
 */
async function openOldState(file) {
  const { DuckDBInstance } = require('@duckdb/node-api');
  const db = await DuckDBInstance.create(file, { allow_persistent_secrets: 'false', threads: '1' });
  const conn = await db.connect();
  const run = async sql => (await conn.runAndReadAll(sql)).getRowObjectsJson();
  return {
    run,
    async logs() {
      const has = await run(`SELECT 1 AS found FROM information_schema.tables WHERE table_name = 'logs'`);
      if (!has.length) return [];
      return (await run('SELECT ts, win, sql, ms, status, error, conn FROM logs ORDER BY ts')).map(r => ({
        at: Number(r.ts), window: r.win, sql: r.sql, ms: Number(r.ms), status: r.status, error: r.error, conn: r.conn,
      }));
    },
    close() {
      try { conn.closeSync(); } catch (_) {}
      try { db.closeSync(); } catch (_) {}
    },
  };
}

module.exports = { openOldState };
