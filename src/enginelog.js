'use strict';
// =============================================================================
// enginelog.js — what the engine ran, kept
// =============================================================================
// The record is DuckDB's own: with its Quack log on, each request a client makes is a row with the
// statement, the time to its first rows and any error (engine-host.js turns it on). That log lives in memory,
// so the server moves it into a table in the state file, which outlives the process and answers the
// Logs tab with no scan of anything large. Nothing here looks at a statement as it runs.
//
// `SELECT * FROM duckdb_logs` still answers in a SQL box, for what hasn't been emptied yet.
// =============================================================================

const { sqlStr } = require('./sql');

const EVERY_MS = 2_000;
const TRIM_EVERY_MS = 60 * 60 * 1000;
const EMPTY_PAST_ROWS = 5_000;       // of DuckDB's log, already moved, kept for SQL over it
const SQL_MAX = 64 * 1024;           // the catalog's listing can be megabytes of views

const unescape = s => s.replace(/\\([\s\S])/g, '$1');

/** One row of DuckDB's Quack log, or null when it isn't one. Its text is a struct, printed. */
function parseRequest(message) {
  const m = String(message);
  const type = /^\{'message_type': (\w+)/.exec(m);
  if (!type) return null;
  const sql = /'query': '([\s\S]*?)', 'server': /.exec(m);
  const error = /'error': '([\s\S]*)'\}$/.exec(m);
  return {
    type: type[1],
    conn: (/'quack_connection_id': '?(\w*)/.exec(m) || [])[1] || '',
    sql: sql ? unescape(sql[1]) : null,
    ms: Number((/'duration_ms': (\d+)/.exec(m) || [])[1] || 0),
    response: (/'response_type': (\w+)/.exec(m) || [])[1] || null,
    error: error ? unescape(error[1]) : null,
  };
}

/** A statement a window sent: its tag says which window, and its text comes back without it. */
function statementOf(request) {
  if (!request || request.type !== 'PREPARE_REQUEST' || request.sql == null) return null;
  const tag = /\/\*onelake:([^:*]+):[^*]*\*\/\s*$/.exec(request.sql);
  if (!tag) return null;
  const failed = request.response === 'ERROR_RESPONSE';
  return {
    conn: request.conn, window: tag[1], ms: request.ms,
    sql: request.sql.slice(0, tag.index).trim(),
    status: !failed ? 'ok' : /interrupt|cancel/i.test(request.error || '') ? 'stopped' : 'error',
    error: request.error,
  };
}

// What the host and a page issue to get ready, rather than what someone asked.
const isSetup = sql => /^\s*(create|drop|attach|detach)\b/i.test(sql);

const cut = s => { const t = String(s).split('\0').join(''); return t.length > SQL_MAX ? `${t.slice(0, SQL_MAX)}\n… (cut)` : t; };

/**
 * @param {object} o
 * @param {{readLog: Function, emptyLog: Function}} o.engine
 * @param {any} o.state  a connection to the state file
 * @param {number} o.maxBytes  how much to keep; 0 keeps none
 * @param {(line: string) => void} [o.log]
 */
function createLogKeeper({ engine, state, maxBytes, log = () => {} }) {
  let last = 0n, moved = 0, chain = Promise.resolve(), timers = [];
  let asked = 0;              // statements someone asked for, since this process started

  async function move() {
    const rows = await engine.readLog(last);
    if (!rows.length) return;
    const fresh = [];
    for (const r of rows) {
      const us = BigInt(r.us);
      if (us > last) last = us;
      moved++;
      const st = statementOf(parseRequest(r.message));
      if (st) {
        if (!isSetup(st.sql)) asked++;
        const at = Number(us / 1000n);
        fresh.push(`(${at}, ${sqlStr(st.window)}, ${sqlStr(cut(st.sql))}, ${st.ms}, ${sqlStr(st.status)}, ${st.error == null ? 'NULL' : sqlStr(cut(st.error))}, ${sqlStr(st.conn)})`);
      }
    }
    if (maxBytes > 0 && fresh.length) await state.run(`INSERT INTO logs VALUES ${fresh.join(',\n')};`);
    if (moved > EMPTY_PAST_ROWS) {
      await engine.emptyLog();
      moved = 0;
    }
  }
  // One at a time, and a failure costs only that turn.
  const turn = fn => {
    const run = chain.then(fn);
    chain = run.catch(e => log(`the log could not be kept: ${(e && e.message) || e}`));
    return run;
  };
  const flush = () => turn(move);

  // The oldest go, down to half, so this isn't at the limit again at once.
  async function trim() {
    if (!(maxBytes > 0)) return;
    await state.run(`DELETE FROM logs WHERE ts <= (
      SELECT max(ts) FROM (SELECT ts, sum(length(sql) + coalesce(length(error), 0)) OVER (ORDER BY ts DESC) AS kept FROM logs)
      WHERE kept > ${Math.floor(maxBytes / 2)})
      AND (SELECT sum(length(sql) + coalesce(length(error), 0)) FROM logs) > ${Math.floor(maxBytes)};`);
  }

  return {
    start() {
      turn(trim);
      timers = [setInterval(flush, EVERY_MS), setInterval(() => turn(trim), TRIM_EVERY_MS)];
      for (const t of timers) t.unref();
    },
    flush,
    stop() { for (const t of timers) clearInterval(t); },
    /** The newest statements, up to date. */
    async read(limit = 1000) {
      await flush().catch(() => {});
      const r = await state.runAndReadAll(`SELECT ts, win, sql, ms, status, error FROM logs ORDER BY ts DESC LIMIT ${Math.max(1, Math.floor(limit))}`);
      return r.getRowObjectsJson().map(x => ({ at: Number(x.ts), window: x.win, sql: x.sql, ms: Number(x.ms), status: x.status, error: x.error, setup: isSetup(x.sql) }));
    },
    /** How many statements someone has asked for so far, up to date: Performance's queries per second. */
    async statements() {
      await flush().catch(() => {});
      return asked;
    },
    clear: () => turn(async () => { await state.run('DELETE FROM logs;'); await engine.emptyLog(); moved = 0; }),
  };
}

module.exports = { createLogKeeper, parseRequest, statementOf, isSetup };
