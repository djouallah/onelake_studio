'use strict';
// =============================================================================
// tsql.js — a statement run on a workspace's Fabric SQL endpoint
// =============================================================================
// SQL endpoint mode (onelakeStudio.sqlEngine) sends T-SQL to Fabric instead of DuckDB. This is the
// TDS side of it: one login per statement, with the SQL audience's token (signin.js sqlToken), on
// the host fabric.js sqlEndpoints names. tedious is pure JavaScript, so it needs no binding in the
// vsix; it is required on first use, so the tree never waits for it.
//
// Host-side only. The panel never sees the token.
// =============================================================================

const TDS_PORT = 1433;
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Runs `sql` in `database` on `host`, logged in with `token`.
 * @returns {Promise<{ fields: {name: string, type: string}[], rows: unknown[][], truncated: boolean }>}
 */
function runTsql({ host, database, token, sql, maxRows = 10_000, signal }) {
  const { Connection, Request } = require('tedious');
  return new Promise((resolve, reject) => {
    const conn = new Connection({
      server: String(host).replace(/,\d+$/, ''),
      authentication: { type: 'azure-active-directory-access-token', options: { token } },
      options: { database, port: TDS_PORT, encrypt: true, connectTimeout: CONNECT_TIMEOUT_MS, requestTimeout: 0 },
    });
    let fields = [];
    const rows = [];
    let truncated = false;
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      conn.close();
      err ? reject(err) : resolve(value);
    };
    if (signal) signal.addEventListener('abort', () => { conn.cancel(); done(new Error('Stopped')); }, { once: true });
    conn.on('error', e => done(e));
    conn.connect(e => {
      if (e) return done(e);
      const req = new Request(sql, e2 => done(e2, { fields, rows, truncated }));
      req.on('columnMetadata', cols => {
        fields = cols.map(c => ({ name: c.colName, type: c.type && c.type.name }));
      });
      req.on('row', cols => {
        if (rows.length >= maxRows) { truncated = true; return; }
        rows.push(cols.map(c => c.value));
      });
      conn.execSql(req);
    });
  });
}

module.exports = { runTsql };
