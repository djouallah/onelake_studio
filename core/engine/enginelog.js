'use strict';
// =============================================================================
// enginelog.js — what the engine ran, kept
// =============================================================================
// The record is DuckDB's own: with its Quack log on, each request a client makes is a row with the
// statement, the time to its first rows and any error (engine-host.js turns it on). That log lives in memory,
// so the server moves it into its own SQLite file (logfile.js), which outlives the process and answers
// the Logs tab with no scan of anything large. Nothing here looks at a statement as it runs.
//
// `SELECT * FROM duckdb_logs` still answers in a SQL box, for what hasn't been emptied yet.
// =============================================================================

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

// A semantic model's query runs as what dax-sql compiled it to, with the statement as written in a
// comment in front (page/explore/query.js withSource), from a tab's box or its Pivot: { source, sql } apart, source null for any other.
// An EXPLAIN or SUMMARIZE of one has it after its first word, and keeps that word.
const SOURCE = /\/\*semantic\n([\s\S]*?)\n\*\/\n/;
function sourceOf(sql) {
  const m = SOURCE.exec(sql);
  if (!m) return { source: null, sql };
  return { source: m[1].replace(/\\([\s\S])/g, '$1'), sql: (sql.slice(0, m.index) + sql.slice(m.index + m[0].length)).trim() };
}

// What the host and a page issue to get ready, rather than what someone asked.
const isSetup = sql => /^\s*(create|drop|attach|detach)\b/i.test(sql);

const cut = s => { const t = String(s).split('\0').join(''); return t.length > SQL_MAX ? `${t.slice(0, SQL_MAX)}\n… (cut)` : t; };

// After a fatal error DuckDB refuses every statement, whoever sends it, until the process is gone.
const FATAL = /database has been invalidated/i;

/**
 * @param {object} o
 * @param {{readLog: Function, emptyLog: Function}} o.engine
 * @param {ReturnType<import('../logfile').createLogFile>} o.logs
 * @param {number} o.maxBytes  how much to keep; 0 keeps none
 * @param {(line: string) => void} [o.log]
 * @param {(message: string) => void} [o.onFatal]  the database has died under this process, for good
 */
function createLogKeeper({ engine, logs, maxBytes, log = () => {}, onFatal = () => {} }) {
  let last = 0n, moved = 0, chain = Promise.resolve(), timers = [];
  // Turns in a row the log file refused rows, and how many of those keep the rows for the next.
  let refused = 0;
  const KEEP_TRYING = 5;
  let asked = 0;              // statements someone asked for, since this process started

  // The rows past `last`, as the log file keeps them.
  function take(rows) {
    const fresh = [];
    for (const r of rows) {
      const us = BigInt(r.us);
      if (us > last) last = us;
      moved++;
      const st = statementOf(parseRequest(r.message));
      if (st) {
        if (!isSetup(st.sql)) asked++;
        fresh.push({ at: Number(us / 1000n), window: st.window, sql: cut(st.sql), ms: st.ms, status: st.status,
                     error: st.error == null ? null : cut(st.error), conn: st.conn });
      }
    }
    return fresh;
  }
  async function move() {
    const rows = await engine.readLog(last);
    if (!rows.length) return;
    // Rows count as moved only once the log file has them: one that was busy gets them again next turn.
    // A file that stays unwritable is not waited on for ever: after a few turns the rows are let go, or DuckDB's
    // own log, which is emptied only as rows move, would grow for as long as the server lives.
    const was = { last, moved, asked };
    const fresh = take(rows);
    try { if (maxBytes > 0) logs.add(fresh); refused = 0; }
    catch (e) {
      if (++refused <= KEEP_TRYING) ({ last, moved, asked } = was);
      throw e;
    }
    if (moved > EMPTY_PAST_ROWS) {
      // What was logged while the rows above were being kept, read just before the log is emptied:
      // emptying takes everything, and a statement in neither read would never be in the Logs tab.
      const late = take(await engine.readLog(last));
      if (maxBytes > 0) logs.add(late);
      await engine.emptyLog();
      moved = 0;
    }
  }
  // One at a time, and a failure costs only that turn.
  const turn = fn => {
    const run = chain.then(fn);
    chain = run.catch(e => {
      const message = String((e && e.message) || e);
      log(`the log could not be kept: ${message}`);
      if (FATAL.test(message)) onFatal(message);
    });
    return run;
  };
  const flush = () => turn(move);

  async function trim() {
    if (maxBytes > 0) logs.trim(maxBytes);
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
      return logs.read(Math.max(1, Math.floor(limit))).map(x => {
        const { source, sql } = sourceOf(x.sql);
        return { at: Number(x.ts), window: x.win, sql, source, ms: Number(x.ms), status: x.status, error: x.error, setup: isSetup(sql) };
      });
    },
    /** How many statements someone has asked for so far, up to date: Performance's queries per second. */
    async statements() {
      await flush().catch(() => {});
      return asked;
    },
    clear: () => turn(async () => { logs.clear(); await engine.emptyLog(); moved = 0; }),
  };
}

module.exports = { createLogKeeper, parseRequest, statementOf, sourceOf, isSetup };
