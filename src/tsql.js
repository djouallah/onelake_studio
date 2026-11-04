'use strict';
// =============================================================================
// tsql.js — a statement run on a workspace's Fabric SQL endpoint
// =============================================================================
// SQL endpoint mode (onelakeStudio.sqlEngine) sends the SQL box's T-SQL, and a semantic model's
// queries compiled to T-SQL by dax-sql, to Fabric instead of DuckDB. A statement names its tables
// as everywhere else (NAMING.md), lakehouse.<workspace>.<item>.<schema>.<table>; here each is
// "item"."schema"."table", in that workspace's endpoint, which holds every lakehouse and warehouse
// of the workspace as a database of its name. One workspace a statement: T-SQL names four parts at
// most, and Fabric has no linked servers.
//
// The answer is the engine's (engine-host.js): batches of { fields, rows, numRows }, a field's type
// in DuckDB's words and a row as an object of JSON-safe values, so the grid, Explore, the command
// line and Excel read it as they read DuckDB's. Read only, as DuckDB's path is (assertTsqlRead).
// The SQL audience's token comes from signin.js sqlToken; tedious, pure JavaScript, is required on
// first use, so nothing waits for it at activation.
//
// Host-side only. The panel never sees the token.
// =============================================================================

const TDS_PORT = 1433;
const CONNECT_TIMEOUT_MS = 30_000;
const BATCH_ROWS = 10_000;
const IDLE_MS = 5 * 60_000;
const POOL_MAX = 4;

// --- reading T-SQL: comments, strings and names skipped whole ----------------------------------

// The statement as tokens: { k: 'word' | 'name' | 'str' | 'sym', v, start, end }. A name is
// "quoted" or [bracketed], its text unquoted in `v`.
function tokens(sql) {
  const s = String(sql), out = [];
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && s[i + 1] === '-') { const e = s.indexOf('\n', i); i = e < 0 ? s.length : e; continue; }
    if (c === '/' && s[i + 1] === '*') {
      // T-SQL nests block comments.
      let depth = 0, j = i;
      for (; j < s.length; j++) {
        if (s[j] === '/' && s[j + 1] === '*') { depth++; j++; } else if (s[j] === '*' && s[j + 1] === '/') { j++; if (!--depth) break; }
      }
      i = j + 1;
      continue;
    }
    const start = i;
    if (c === "'" || ((c === 'N' || c === 'n') && s[i + 1] === "'")) {
      let j = s.indexOf("'", i) + 1;
      for (;;) {
        const e = s.indexOf("'", j);
        if (e < 0) throw new Error('A string is not closed.');
        if (s[e + 1] === "'") { j = e + 2; continue; }
        i = e + 1;
        break;
      }
      out.push({ k: 'str', start, end: i });
      continue;
    }
    if (c === '"' || c === '[') {
      const close = c === '"' ? '"' : ']';
      let j = i + 1, v = '';
      for (;;) {
        const e = s.indexOf(close, j);
        if (e < 0) throw new Error('A quoted name is not closed.');
        v += s.slice(j, e);
        if (s[e + 1] === close) { v += close; j = e + 2; continue; }
        i = e + 1;
        break;
      }
      out.push({ k: 'name', v, start, end: i });
      continue;
    }
    const w = /^[A-Za-z_@#À-￿][\w@#$À-￿]*/.exec(s.slice(i));
    if (w) { i += w[0].length; out.push({ k: 'word', v: w[0], start, end: i }); continue; }
    i++;
    out.push({ k: 'sym', v: c, start, end: i });
  }
  return out;
}

// What a statement may not do on the endpoint: write, run code, change the session. A warehouse's
// endpoint can write, so this matters as much as DuckDB's guard (sql.js assertReads).
const WRITES = new Set(['insert', 'update', 'delete', 'merge', 'create', 'alter', 'drop', 'truncate', 'exec', 'execute',
  'grant', 'revoke', 'deny', 'into', 'declare', 'set', 'use', 'backup', 'restore', 'kill', 'shutdown', 'dbcc', 'bulk',
  'openquery', 'opendatasource', 'waitfor', 'reconfigure', 'checkpoint', 'begin', 'commit', 'rollback', 'save']);

function assertTsqlRead(sql) {
  const toks = tokens(sql);
  const first = toks.find(t => t.k === 'word');
  if (!first || !/^(select|with)$/i.test(first.v)) throw new Error('Read only: on the SQL endpoint a statement is a SELECT (or WITH … SELECT).');
  const semi = toks.findIndex(t => t.k === 'sym' && t.v === ';');
  if (semi >= 0 && semi < toks.length - 1) throw new Error("Run one statement at a time (no ';').");
  const bad = toks.find(t => t.k === 'word' && WRITES.has(t.v.toLowerCase()));
  if (bad) throw new Error(`Read only: ${bad.v.toUpperCase()} is not run on the SQL endpoint.`);
}

// --- the names ---------------------------------------------------------------------------------

const ENDPOINT_KINDS = new Map([['lakehouse', 'Lakehouse'], ['warehouse', 'Warehouse']]);
const OTHER_KINDS = new Set(['sqldatabase', 'mirroreddatabase']);
const tsqlIdent = s => `"${String(s).replace(/"/g, '""')}"`;

// The statement with each table's five-part name as the endpoint's three, and where it runs:
// { sql, workspace, items: [{ kind, item }] }. A statement that names no table, or tables of two
// workspaces, is refused by name.
function onEndpoint(sql) {
  const s = String(sql), toks = tokens(s);
  const part = t => t && (t.k === 'name' || t.k === 'word');
  const dot = t => t && t.k === 'sym' && t.v === '.';
  const edits = [], items = [];
  let workspace = null;
  for (let i = 0; i < toks.length; i++) {
    if (!part(toks[i]) || (i > 0 && dot(toks[i - 1]))) continue;
    const chain = [toks[i]];
    for (let j = i + 1; dot(toks[j]) && part(toks[j + 1]); j += 2) chain.push(toks[j + 1]);
    if (chain.length !== 5) continue;
    const kind = chain[0].v.toLowerCase();
    if (OTHER_KINDS.has(kind)) throw new Error(`${chain.map(t => t.v).join('.')}: a SQL database or a mirrored database has an endpoint of its own; on the SQL endpoint, a statement reads lakehouses and warehouses.`);
    if (!ENDPOINT_KINDS.has(kind)) continue;
    const ws = chain[1].v;
    if (workspace && workspace.toLowerCase() !== ws.toLowerCase()) {
      throw new Error(`One workspace a statement on the SQL endpoint: this one names ${workspace} and ${ws}.`);
    }
    workspace = workspace || ws;
    const item = chain[2].v;
    if (!items.some(x => x.item.toLowerCase() === item.toLowerCase())) items.push({ kind: ENDPOINT_KINDS.get(kind), item });
    edits.push({ start: chain[0].start, end: chain[4].end, text: chain.slice(2).map(t => tsqlIdent(t.v)).join('.') });
    i += 8;
  }
  if (!workspace) throw new Error('On the SQL endpoint a statement names a table, lakehouse.<workspace>.<item>.<schema>.<table>: that says whose endpoint runs it.');
  let out = s;
  for (const e of edits.reverse()) out = `${out.slice(0, e.start)}${e.text}${out.slice(e.end)}`;
  return { sql: out, workspace, items };
}

// --- results, in DuckDB's words ----------------------------------------------------------------

function fieldType(c) {
  const t = c.type && c.type.name, n = c.dataLength;
  switch (t) {
    case 'IntN': return n === 8 ? 'BIGINT' : n === 2 ? 'SMALLINT' : n === 1 ? 'TINYINT' : 'INTEGER';
    case 'BigInt': return 'BIGINT';
    case 'Int': return 'INTEGER';
    case 'SmallInt': return 'SMALLINT';
    case 'TinyInt': return 'TINYINT';
    case 'FloatN': return n === 4 ? 'FLOAT' : 'DOUBLE';
    case 'Float': return 'DOUBLE';
    case 'Real': return 'FLOAT';
    case 'DecimalN': case 'NumericN': case 'Decimal': case 'Numeric':
      return `DECIMAL(${c.precision ?? 18},${c.scale ?? 0})`;
    case 'Money': case 'MoneyN': case 'SmallMoney': return 'DECIMAL(19,4)';
    case 'BitN': case 'Bit': return 'BOOLEAN';
    case 'Date': case 'DateN': return 'DATE';
    case 'DateTime': case 'DateTimeN': case 'DateTime2': case 'DateTime2N': case 'SmallDateTime': return 'TIMESTAMP';
    case 'DateTimeOffset': case 'DateTimeOffsetN': return 'TIMESTAMP WITH TIME ZONE';
    case 'Time': case 'TimeN': return 'TIME';
    case 'UniqueIdentifier': return 'UUID';
    case 'Binary': case 'VarBinary': case 'Image': return 'BLOB';
    default: return 'VARCHAR';
  }
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
// A value as DuckDB's rows give it (engine-host.js jsonSafe): a date as 2024-01-31, a timestamp as
// 2024-01-31 10:00:00 (the fraction when there is one), a big whole number as text.
function value(v, type) {
  if (v == null) return null;
  if (typeof v === 'string' && type === 'BIGINT') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v;
  }
  if (v instanceof Date) {
    const d = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    if (type === 'DATE') return d;
    const ms = v.getUTCMilliseconds(), us = v.nanosecondDelta ? Math.round(v.nanosecondDelta * 1e6) : 0;
    const frac = ms || us ? `.${pad(ms, 3)}${us ? pad(us, 3) : ''}`.replace(/0+$/, '') : '';
    const time = `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}${frac}`;
    return type === 'TIME' ? time : `${d} ${time}`;
  }
  if (Buffer.isBuffer(v)) return Array.from(v);
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return v;
}

const dedupe = names => {
  const seen = {};
  return names.map(n => { const k = (seen[n] = (seen[n] || 0) + 1); return k > 1 ? `${n}:${k - 1}` : n; });
};

// --- connections -------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {(workspace: string) => Promise<{name: string, type: string, host: string}[]>} o.endpoints  fabric.js sqlEndpoints
 * @param {(o?: {createIfNone?: boolean, fresh?: boolean}) => Promise<string|null>} o.sqlToken  signin.js
 * @param {() => number} [o.maxRows]
 * @param {(line: string) => void} [o.log]
 * @param {() => string|null} [o.account]  whose connections these are: another account's never reuses one
 */
function createTsql({ endpoints, sqlToken, maxRows = () => 200_000, log = () => {}, account = () => null }) {
  const pools = new Map();   // host|db -> idle connections
  const known = new Map();   // lower-cased workspace -> its endpoints, as the Fabric API said
  const running = new Set(); // { owner, cancel }

  async function endpointOf(workspace, items) {
    const key = workspace.toLowerCase();
    let list = known.get(`${account() ?? ''}|${key}`);
    const find = it => list && list.find(x => x.type === it.kind && x.name.toLowerCase() === it.item.toLowerCase());
    if (!list || items.some(it => !find(it))) { list = await endpoints(workspace); known.set(`${account() ?? ''}|${key}`, list); }
    for (const it of items) {
      if (!find(it)) throw new Error(`${workspace} has no ${it.kind.toLowerCase()} ${it.item} with a SQL endpoint.`);
    }
    return { host: find(items[0]).host, database: find(items[0]).name };
  }

  function connect(host, database, token) {
    const { Connection } = require('tedious');
    return new Promise((resolve, reject) => {
      const conn = new Connection({
        server: String(host).replace(/,\d+$/, ''),
        authentication: { type: 'azure-active-directory-access-token', options: { token } },
        options: { database, port: TDS_PORT, encrypt: true, connectTimeout: CONNECT_TIMEOUT_MS, requestTimeout: 0 },
      });
      conn.on('connect', e => (e ? reject(e) : resolve(conn)));
      conn.connect();
    });
  }

  // A connection to `database` on `host`, from the pool when one is idle; given back after.
  async function withConnection(host, database, fn) {
    const key = `${account() ?? ''}|${host}|${database}`.toLowerCase();
    const idle = pools.get(key) || [];
    pools.set(key, idle);
    let entry = idle.pop();
    if (entry) clearTimeout(entry.timer);
    else {
      let token = await sqlToken({ createIfNone: true });
      if (!token) throw new Error('No token for the SQL endpoint: the sign-in was cancelled or refused.');
      let conn;
      try { conn = await connect(host, database, token); }
      catch (e) {
        if (!/login failed|token/i.test(String(e && e.message))) throw e;
        token = await sqlToken({ fresh: true });
        conn = await connect(host, database, token);
      }
      entry = { conn, timer: null };
    }
    let healthy = true;
    try { return await fn(entry.conn, () => { healthy = false; }); }
    catch (e) { healthy = false; throw e; }
    finally {
      if (healthy && idle.length < POOL_MAX) {
        entry.timer = setTimeout(() => { const i = idle.indexOf(entry); if (i >= 0) idle.splice(i, 1); entry.conn.close(); }, IDLE_MS);
        entry.timer.unref?.();
        idle.push(entry);
      } else entry.conn.close();
    }
  }

  // A statement's rows, in batches of DuckDB's shape, past maxRows only counted; then { numRows }.
  // `owner`: whose Stop reaches it.
  // `rows`: how many rows are kept, past which they are only counted (an export keeps them all).
  async function stream(sql, emit, owner = null, { rows: keep = maxRows() } = {}) {
    assertTsqlRead(sql);
    const where = onEndpoint(sql);
    const { host, database } = await endpointOf(where.workspace, where.items);
    const { Request } = require('tedious');
    const cap = keep;
    const t0 = Date.now();
    const numRows = await withConnection(host, database, (conn, broken) => new Promise((resolve, reject) => {
      let fields = [], names = [], rows = [], kept = 0, counted = 0, total = 0, sentAny = false, stopped = false;
      const flush = () => {
        if (!rows.length && !counted) return;
        emit({ fields, rows, numRows: rows.length + counted });
        sentAny = true;
        rows = []; counted = 0;
      };
      const req = new Request(where.sql, e => {
        running.delete(job);
        if (stopped) { broken(); return reject(Object.assign(new Error('INTERRUPT Error: Interrupted!'), { cancelled: true })); }
        if (e) return reject(e);
        flush();
        if (!sentAny) emit({ fields, rows: [], numRows: 0 });
        resolve(total);
      });
      req.on('columnMetadata', cols => {
        names = dedupe(cols.map(c => c.colName));
        fields = cols.map((c, i) => ({ name: names[i], type: fieldType(c) }));
      });
      req.on('row', cols => {
        total++;
        if (kept >= cap) { counted++; } else {
          const o = {};
          cols.forEach((c, i) => { o[names[i]] = value(c.value, fields[i].type); });
          rows.push(o);
          kept++;
        }
        if (rows.length + counted >= BATCH_ROWS) flush();
      });
      const job = { owner, cancel: () => { stopped = true; conn.cancel(); } };
      running.add(job);
      conn.execSql(req);
    }));
    log(`sql endpoint: ${where.workspace}/${database} ${numRows} row(s) in ${Date.now() - t0} ms`);
    return { done: true, numRows, asOf: null };
  }

  // A statement's estimated plan, as the endpoint gives it (SET SHOWPLAN_XML: nothing runs): its
  // operators as a tree, [{ op, logical, rows, cost, table, children }]. Fabric has no actual one
  // (SET STATISTICS XML is not supported).
  async function plan(sql, owner = null) {
    assertTsqlRead(sql);
    const where = onEndpoint(sql);
    const { host, database } = await endpointOf(where.workspace, where.items);
    const { Request } = require('tedious');
    const exec = (conn, text, batch = false) => new Promise((resolve, reject) => {
      const out = [];
      const req = new Request(text, e => (e ? reject(e) : resolve(out)));
      req.on('row', cols => out.push(cols.map(c => c.value)));
      batch ? conn.execSqlBatch(req) : conn.execSql(req);
    });
    const xml = await withConnection(host, database, async (conn, broken) => {
      await exec(conn, 'SET SHOWPLAN_XML ON', true);
      try { return (await exec(conn, where.sql, true)).map(r => r[0]).join(''); }
      finally { await exec(conn, 'SET SHOWPLAN_XML OFF', true).catch(() => broken()); }
    });
    return planTree(xml);
  }

  // DuckDB's SUMMARIZE of a statement (Profile, in the panel), over every row it returns, in its
  // columns: each column's type, min and max, distinct values, average, spread, quartiles, count and
  // the share of blanks. The endpoint has no such statement, so it is worked out here.
  async function summarize(sql, owner = null) {
    let fields = [];
    const values = [];
    let total = 0;
    await stream(sql, b => {
      if (!values.length) { fields = b.fields; fields.forEach(() => values.push([])); }
      for (const r of b.rows) fields.forEach((f, i) => values[i].push(r[f.name]));
      total += b.rows.length;
    }, owner, { rows: Infinity });
    const NUMERIC = /^(BIGINT|INTEGER|SMALLINT|TINYINT|DOUBLE|FLOAT|DECIMAL)/;
    const text = v => (v == null ? null : String(v));
    const quantile = (sorted, q) => {
      if (!sorted.length) return null;
      const at = (sorted.length - 1) * q, lo = Math.floor(at);
      return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (at - lo);
    };
    const rows = fields.map((f, i) => {
      const all = values[i], set = all.filter(v => v != null);
      const numeric = NUMERIC.test(f.type);
      const nums = numeric ? set.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
      const cmp = numeric ? (a, b) => Number(a) - Number(b) : (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
      const sorted = numeric ? null : [...set].sort(cmp);
      const avg = nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
      const std = nums.length > 1 ? Math.sqrt(nums.reduce((s, v) => s + (v - avg) ** 2, 0) / (nums.length - 1)) : null;
      return {
        column_name: f.name, column_type: f.type,
        min: text(numeric ? (nums.length ? nums[0] : null) : sorted[0]),
        max: text(numeric ? (nums.length ? nums.at(-1) : null) : sorted.at(-1)),
        approx_unique: new Set(set.map(v => (typeof v === 'object' ? JSON.stringify(v) : v))).size,
        avg: text(avg), std: text(std),
        q25: text(quantile(nums, 0.25)), q50: text(quantile(nums, 0.5)), q75: text(quantile(nums, 0.75)),
        count: total, null_percentage: total ? Math.round(10000 * (all.length - set.length) / total) / 100 : 0,
      };
    });
    const T = { column_name: 'VARCHAR', column_type: 'VARCHAR', min: 'VARCHAR', max: 'VARCHAR', approx_unique: 'BIGINT', avg: 'VARCHAR',
      std: 'VARCHAR', q25: 'VARCHAR', q50: 'VARCHAR', q75: 'VARCHAR', count: 'BIGINT', null_percentage: 'DECIMAL(9,2)' };
    return { fields: Object.entries(T).map(([name, type]) => ({ name, type })), rows };
  }

  async function query(sql, owner = null) {
    const batches = [];
    await stream(sql, b => batches.push(b), owner);
    return { fields: batches[0].fields, rows: batches.flatMap(b => b.rows), numRows: batches.reduce((n, b) => n + b.numRows, 0), asOf: null };
  }

  // Stop: the statements of `owner` (a tab), or every one.
  function cancel(owner = null) {
    for (const job of [...running]) if (!owner || job.owner === owner) job.cancel();
    return true;
  }

  function close() {
    for (const idle of pools.values()) for (const e of idle) { clearTimeout(e.timer); e.conn.close(); }
    pools.clear();
    known.clear();
  }

  return { stream, query, plan, summarize, cancel, close, forget: () => known.clear() };
}

// A SHOWPLAN_XML's operators (its RelOp elements) as a tree, each with its own estimated cost:
// its subtree's less its inputs'. `table`: the first table it reads, when it scans one.
function planTree(xml) {
  const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? m[1] : null; };
  const unxml = s => String(s ?? '').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const roots = [], stack = [];
  for (const m of String(xml).matchAll(/<RelOp\b[^>]*>|<\/RelOp>|<Object\b[^>]*\/?>/g)) {
    const tag = m[0];
    if (tag.startsWith('</')) { stack.pop(); continue; }
    if (tag.startsWith('<Object')) {
      const top = stack.at(-1);
      if (top && !top.table) top.table = [attr(tag, 'Schema'), attr(tag, 'Table')].filter(Boolean).map(s => unxml(s).replace(/^\[|\]$/g, '')).join('.') || null;
      continue;
    }
    const node = { op: unxml(attr(tag, 'PhysicalOp')), logical: unxml(attr(tag, 'LogicalOp')), rows: Number(attr(tag, 'EstimateRows')) || 0,
      subtree: Number(attr(tag, 'EstimatedTotalSubtreeCost')) || 0, table: null, children: [] };
    (stack.length ? stack.at(-1).children : roots).push(node);
    if (!tag.endsWith('/>')) stack.push(node);
  }
  // Its children's subtrees first, before they lose theirs.
  const own = n => {
    n.cost = Math.max(0, n.subtree - n.children.reduce((s, k) => s + k.subtree, 0));
    n.children.forEach(own);
    delete n.subtree;
    return n;
  };
  return roots.map(own);
}

/**
 * Runs `sql` in `database` on `host`, logged in with `token`: the probe's one statement.
 * @returns {Promise<{ fields: {name: string, type: string}[], rows: unknown[][], truncated: boolean }>}
 */
function runTsql({ host, database, token, sql, maxRows = 10_000 }) {
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
    const done = (err, out) => {
      if (settled) return;
      settled = true;
      conn.close();
      err ? reject(err) : resolve(out);
    };
    conn.on('error', e => done(e));
    conn.connect(e => {
      if (e) return done(e);
      const req = new Request(sql, e2 => done(e2, { fields, rows, truncated }));
      req.on('columnMetadata', cols => { fields = cols.map(c => ({ name: c.colName, type: fieldType(c) })); });
      req.on('row', cols => {
        if (rows.length >= maxRows) { truncated = true; return; }
        rows.push(cols.map(c => c.value));
      });
      conn.execSql(req);
    });
  });
}

module.exports = { createTsql, runTsql, assertTsqlRead, onEndpoint, planTree, tokens, fieldType, value };
