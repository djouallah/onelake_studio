import { createHmac } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { createCompiler } from 'dax-sql';
import { tmslToModel } from 'dax-sql/formats/tmsl.js';
import { ossieToTmsl } from 'dax-sql/formats/ossie.js';
import { Connection, Request } from 'tedious';

import {
  UserDataFunctions,
  AudienceType,
  type RayfinContext,
} from '@microsoft/fabric-user-data-functions';

import type { BlankAppSchema } from '../../data/schema.js';

const udf = new UserDataFunctions();

/*
 * The browser never receives a token: openCatalog uses the app identity's storage token here,
 * server side, and hands back only
 *   - the semantic model, read in place from the lakehouse (MODEL_URL) when the page asks for
 *     no tables: the app ships no copy of it, so it is the model as the lakehouse holds it now,
 *   - where each table the page asked for is now: its current metadata.json, from the OneLake
 *     Iceberg REST catalog (loadTable), and
 *   - a OneLake user-delegation SAS for each of those tables, read-only, on its own folder: DuckDB
 *     in the browser reads the metadata, the manifests and the data files with them.
 * Only the model's tables: someone who can call this reads what the app shows, not the rest of the
 * lakehouse, whichever tables they ask for.
 *
 * CATALOG_URL (an app setting): the catalog the app reads,
 *   https://onelake.table.fabric.microsoft.com/iceberg/<workspace id>/<lakehouse id>
 * MODEL_URL (an app setting): the model file, an Apache Ossie .yaml or a TMSL .bim, in OneLake,
 *   https://onelake.dfs.fabric.microsoft.com/<workspace>/<item>/Files/<path>
 * Both are set by OneLake Studio's Export to Fabric, which deploys this app.
 * The workspace must allow "Authenticate with OneLake user-delegated SAS tokens".
 *
 * An app exported in SQL endpoint mode (OneLake Studio's onelakeStudio.sqlEngine) calls
 * sqlEndpoint instead, and nothing reads the tables in the browser: the page sends Explore's
 * query over the model, this function compiles it to T-SQL (dax-sql) and runs it on the
 * lakehouse's SQL endpoint, with the app identity's SQL token, and the page gets the rows. Only a
 * SELECT over the model is taken, never SQL of the browser's own, so a caller reads what the app
 * shows, through the model, and nothing else of the lakehouse.
 * SQL_ENDPOINT, SQL_DATABASE (app settings): the endpoint's host and the lakehouse's name there.
 */

type StorageCtx = RayfinContext<BlankAppSchema, AudienceType.Storage>;

const ONELAKE = 'onelake.dfs.fabric.microsoft.com';
const SAS_VERSION = '2022-11-02';
const SAS_LIFETIME_MS = 55 * 60 * 1000;   // OneLake caps SAS and delegation keys at 1 hour
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const TABLE = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;   // schema.table, the model's `source`

interface DelegationKey {
  oid: string; tid: string; start: string; expiry: string; service: string; version: string; value: string;
}

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// The model file, read with the storage token: JSON (a .bim) or YAML (an Ossie model).
async function readModel(ctx: StorageCtx, token: string): Promise<any> {
  const url = String(ctx.Secrets.MODEL_URL ?? '').trim();
  if (!/^https:\/\/onelake\.dfs\.fabric\.microsoft\.com\//.test(url)) throw new Error('MODEL_URL is not https://onelake.dfs.fabric.microsoft.com/<workspace>/<item>/<path>');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'x-ms-version': SAS_VERSION } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  const body = text.replace(/^﻿/, '');
  try { return JSON.parse(body); } catch { return parseYaml(body); }
}

// An Ossie dataset's table as schema.table, or null when it reads none. `source` is required
// by the spec, so a model from Power BI has one even for a calculation group or a calculated
// table: its partition, kept in the POWER_BI extension, says it has no entity. A bare name is
// in dbo, as in a TMSL partition; item.schema.table is its last two parts.
function ossieSource(d: any): string | null {
  const pbi = (d?.custom_extensions ?? []).find((e: any) => String(e.vendor_name).toUpperCase() === 'POWER_BI');
  let partition: any;
  try { partition = JSON.parse(pbi.data).partitions?.[0]; } catch { /* no extension: its source alone */ }
  if (!d?.source || (partition && !partition.source?.entityName)) return null;
  const s = String(d.source);
  // A table named <item>.<schema>.<table>, in the lakehouse the app reads: its schema.table.
  const parts = (s.match(/"(?:[^"]|"")*"|[^.]+/g) ?? []).map(p => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p));
  if (parts.length === 3) return `${parts[1]}.${parts[2]}`;
  return s.includes('.') ? s : `dbo.${s}`;
}

// The tables a model names, as the page reads them (site/storage/data.js, modelTables): an
// Ossie dataset's table, a TMSL table's Direct Lake partition (schema.table).
function modelSources(model: any): string[] {
  const out = new Set<string>();
  for (const d of model?.datasets ?? []) {
    const s = ossieSource(d);
    if (s) out.add(s);
  }
  for (const t of (model?.model ?? model)?.tables ?? []) {
    const s = t?.partitions?.[0]?.source;
    if (s?.entityName) out.add(`${s.schemaName ?? 'dbo'}.${s.entityName}`);
  }
  return [...out];
}

// CATALOG_URL: the catalog's REST endpoint, then its warehouse, <workspace id>/<lakehouse id>,
// which is also the Tables/ folder's parent.
function catalogUrl(ctx: StorageCtx): { endpoint: string; ws: string; lh: string } {
  // Only OneLake's own catalog: the app identity's token goes there.
  const m = ctx.Secrets.CATALOG_URL.trim().replace(/\/+$/, '').match(/^(https:\/\/[a-z0-9-]*onelake\.table\.fabric\.microsoft\.com\/.+)\/([^/]+)\/([^/]+)$/);
  if (!m) throw new Error('CATALOG_URL is not https://onelake.table.fabric.microsoft.com/<path>/<workspace id>/<lakehouse id>');
  return { endpoint: m[1], ws: m[2], lh: m[3] };
}

// A catalog GET. A throttled (429), failed (5xx) or dropped request is tried again, up to three
// times in all, half a second then a second apart; anything else is the answer.
async function getJson(url: string, token: string): Promise<{ status: number; body: any }> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise(r => setTimeout(r, 500 * attempt));
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await res.text().catch(() => '');
      await new Promise(r => setTimeout(r, 500 * attempt));
      continue;
    }
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = { error: { message: text.slice(0, 200) } }; }
    return { status: res.status, body };
  }
}

// fn over every item, at most `limit` at a time.
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
const CATALOG_CONCURRENCY = 8;   // a model's tables asked of the catalog at once

// The catalog's prefix for the warehouse (GET /v1/config), kept while this instance is warm.
const _prefixes = new Map<string, string>();
async function catalogPrefix(endpoint: string, ws: string, lh: string, token: string): Promise<string> {
  const key = `${ws}/${lh}`;
  const cached = _prefixes.get(key);
  if (cached) return cached;
  const { status, body } = await getJson(`${endpoint}/v1/config?warehouse=${encodeURIComponent(key)}`, token);
  const prefix = body?.overrides?.prefix ?? body?.defaults?.prefix;
  if (status !== 200 || !prefix) throw new Error(`HTTP ${status} ${body?.error?.message ?? 'no prefix in the config'}`);
  _prefixes.set(key, prefix);
  return prefix;
}

// Each table's current metadata.json, a few at a time. A table the catalog does not have is
// `missing`: the page shows no data where it reads it, as it does for a table not deployed.
async function loadTables(endpoint: string, prefix: string, tables: string[], token: string):
    Promise<{ metadata: Record<string, string>; missing: string[] }> {
  const metadata: Record<string, string> = {};
  const missing: string[] = [];
  await eachLimited(tables, CATALOG_CONCURRENCY, async t => {
    const [ns, name] = t.split('.');
    const { status, body } = await getJson(`${endpoint}/v1/${prefix}/namespaces/${ns}/tables/${name}`, token);
    if (status === 404) { missing.push(t); return; }
    const location = body?.['metadata-location'];
    if (status !== 200 || !location) throw new Error(`${t}: HTTP ${status} ${body?.error?.message ?? 'no metadata-location'}`);
    metadata[t] = location;
  });
  return { metadata, missing: missing.sort() };
}

// Window for both the delegation key and the SAS: now-skew .. +55 min. OneLake caps the key window
// (start..expiry) at 60 min; it does NOT cap it at the requesting token's expiry (tested), so a
// nearly-expired storage token must not shorten the SAS.
function sasWindow(): { start: Date; expiry: Date } {
  const now = Date.now();
  return { start: new Date(now - CLOCK_SKEW_MS), expiry: new Date(now + SAS_LIFETIME_MS) };
}

async function getDelegationKey(token: string, start: Date, expiry: Date): Promise<DelegationKey> {
  const host = ONELAKE.replace('.dfs.', '.blob.');
  const res = await fetch(`https://${host}/?restype=service&comp=userdelegationkey`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-ms-version': SAS_VERSION, 'Content-Type': 'application/xml' },
    body: `<?xml version="1.0" encoding="utf-8"?><KeyInfo><Start>${iso(start)}</Start><Expiry>${iso(expiry)}</Expiry></KeyInfo>`,
  });
  const xml = await res.text();
  const find = (name: string): string | undefined => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
  // OneLake's own error code and message (an error body carries no key).
  if (!res.ok) throw new Error(`HTTP ${res.status} ${find('Code') ?? ''} ${(find('Message') ?? '').slice(0, 200)}`.trim());
  const tag = (name: string): string => {
    const v = find(name);
    if (v === undefined) throw new Error(`no ${name} in the answer (HTTP ${res.status})`);
    return v;
  };
  return {
    oid: tag('SignedOid'), tid: tag('SignedTid'), start: tag('SignedStart'), expiry: tag('SignedExpiry'),
    service: tag('SignedService'), version: tag('SignedVersion'), value: tag('Value'),
  };
}

// A table's folder under Tables/, from where its metadata.json is: dbo/t, or t with no schemas.
function tableFolder(location: string): string {
  const m = String(location).match(/\/Tables\/(.+?)\/metadata\/[^/]+$/);
  if (!m) throw new Error(`no table folder in ${String(location).slice(0, 200)}`);
  return m[1];
}

// User-delegation SAS query string for one folder (sr=d): /<ws>/<lh>/Tables/<schema>/<table>.
function signFolderSas(blobPath: string, permissions: string, key: DelegationKey, start: Date, expiry: Date): string {
  const st = iso(start);
  const se = iso(expiry);
  const stringToSign = [
    permissions, st, se, `/blob/onelake${blobPath}`,
    key.oid, key.tid, key.start, key.expiry, key.service, key.version,
    '', '', '', '',          // saoid, suoid, scid, sip (unsupported by OneLake)
    'https', SAS_VERSION, 'd',
    '', '',                  // snapshot time, encryption scope
    '', '', '', '', '',      // rscc, rscd, rsce, rscl, rsct
  ].join('\n');
  const sig = createHmac('sha256', Buffer.from(key.value, 'base64')).update(stringToSign, 'utf8').digest('base64');
  const query = new URLSearchParams({
    sp: permissions, st, se, skoid: key.oid, sktid: key.tid, skt: key.start, ske: key.expiry,
    sks: key.service, skv: key.version, spr: 'https', sv: SAS_VERSION, sr: 'd',
    // Depth = folders below the workspace (container): <lh>/Tables/dbo/t -> 4
    sdd: String(blobPath.split('/').filter(Boolean).length - 1),
    sig,
  });
  return query.toString();
}

/**
 * The tables the page asks for (`schema.table`, comma-separated) — or, asked for none, the
 * model (MODEL_URL) and the tables it names — as they are in the catalog now, and a read-only
 * SAS on each one's folder to read it with. A table the model doesn't name is `missing`.
 * A failure is returned as { error }, naming the step: thrown, it reaches the browser as a bare
 * 500 that says nothing. The message never holds a token or a key.
 */
udf.func(
  'openCatalog',
  async (ctx: RayfinContext<BlankAppSchema, AudienceType.Storage>, tables: string): Promise<{
    model?: any; metadata: Record<string, string>; missing: string[]; sas: Record<string, string>; expiresOn: string;
  } | { error: string }> => {
    let step = 'the table names';
    try {
      const asked = [...new Set(String(tables ?? '').split(',').map(s => s.trim()).filter(Boolean))];
      step = 'the storage token of the app identity';
      const token = ctx.Tokens.Storage;
      step = 'the setting MODEL_URL (the model)';
      const read = await readModel(ctx, token);
      step = "the model's tables";
      const inModel = modelSources(read);
      const model = asked.length ? undefined : read;
      let names = asked.length ? asked.filter(t => inModel.includes(t)) : inModel;
      // A name that is not schema.table cannot be in the catalog, and one the model doesn't name is
      // not this app's: each is listed as missing, and the rest are still answered.
      const bad = [...asked.filter(t => !inModel.includes(t)), ...names.filter(t => !TABLE.test(t))];
      names = names.filter(t => TABLE.test(t));
      if (!names.length && !bad.length) throw new Error('expected schema.table, comma-separated; got none');
      step = 'the setting CATALOG_URL';
      const { endpoint, ws, lh } = catalogUrl(ctx);
      const { start, expiry } = sasWindow();
      step = 'the catalog and the OneLake user delegation key';
      const [catalog, key] = await Promise.all([
        catalogPrefix(endpoint, ws, lh, token).then(prefix => loadTables(endpoint, prefix, names, token)),
        getDelegationKey(token, start, expiry),
      ]);
      step = 'signing the SAS';
      // By the table's folder: what the page reads names its file, and the file its folder.
      const sas: Record<string, string> = {};
      for (const location of Object.values(catalog.metadata)) {
        const folder = tableFolder(location);
        sas[folder] = signFolderSas(`/${ws}/${lh}/Tables/${folder}`, 'r', key, start, expiry);
      }
      return { ...(model ? { model } : {}), metadata: catalog.metadata,
               missing: [...catalog.missing, ...bad].sort(), sas, expiresOn: iso(expiry) };
    } catch (e) {
      return { error: `${step}: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
  [],
);

// --- SQL endpoint mode --------------------------------------------------------------------

type SqlCtx = RayfinContext<BlankAppSchema, AudienceType.Storage | AudienceType.Sql>;

// What the compiled query gives Explore: a number as a number, a date as 2024-01-31, as the
// extension's Explore in SQL endpoint mode (app/explore/query.js EXPLORE_CASTS_TSQL, kept the same).
const CASTS = {
  int: (s: string) => `CAST(${s} AS BIGINT)`,
  double: (s: string) => `CAST(${s} AS FLOAT)`,
  decimal: (s: string) => `CAST(${s} AS FLOAT)`,
  datetime: (s: string) => `CONVERT(VARCHAR(10), CAST(${s} AS DATE), 23)`,
};
const MAX_ROWS = 100_000;          // the most rows one answer holds; past it they are only counted
const MODEL_KEPT_MS = 60_000;      // the model (and its compiler) kept this long by a warm instance
const SQL_TIMEOUT_MS = 230_000;    // a statement's longest run, under the function's own limit

const tsqlName = (s: string): string => `"${String(s).replace(/"/g, '""')}"`;

// The model's tables by name, each its schema.table: what the compiler reads them as.
function sourcesByTable(model: any): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of model?.datasets ?? []) {
    const s = ossieSource(d);
    if (s) out.set(String(d.name), s);
  }
  for (const t of (model?.model ?? model)?.tables ?? []) {
    const s = t?.partitions?.[0]?.source;
    if (s?.entityName) out.set(String(t.name), `${s.schemaName ?? 'dbo'}.${s.entityName}`);
  }
  return out;
}

// The model as read (the page's), and dax-sql's T-SQL compiler over it, each table by its
// three-part name on the endpoint: kept a minute, so a page's queries don't each read the file.
let _kept: { at: number; url: string; db: string; doc: any; compiler: any } | null = null;
async function modelAndCompiler(ctx: SqlCtx, db: string): Promise<{ doc: any; compiler: any }> {
  const url = String(ctx.Secrets.MODEL_URL ?? '').trim();
  if (_kept && _kept.url === url && _kept.db === db && Date.now() - _kept.at < MODEL_KEPT_MS) return _kept;
  const doc = await readModel(ctx as unknown as StorageCtx, ctx.Tokens.Storage);
  const bim = Array.isArray(doc?.datasets) ? ossieToTmsl(doc) : doc;
  const sources = sourcesByTable(doc);
  const compiler = createCompiler(tmslToModel(bim), {
    dialect: 'tsql',
    castOutput: CASTS,
    tableSource: (t: any) => {
      const s = sources.get(String(t.name));
      if (!s) throw new Error(`table ${t.name}: the model names no source for it`);
      const [schema, table] = s.split('.');
      return `${tsqlName(db)}.${tsqlName(schema)}.${tsqlName(table)}`;
    },
  });
  _kept = { at: Date.now(), url, db, doc, compiler };
  return _kept;
}

// One connection to the endpoint, kept while this instance is warm and not in use.
let _idle: Connection | null = null;
function connect(host: string, db: string, token: string): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const conn = new Connection({
      server: host.replace(/,\d+$/, ''),
      authentication: { type: 'azure-active-directory-access-token', options: { token } },
      options: { database: db, port: 1433, encrypt: true, connectTimeout: 30_000, requestTimeout: SQL_TIMEOUT_MS },
    });
    conn.on('error', () => { if (_idle === conn) _idle = null; });
    conn.on('end', () => { if (_idle === conn) _idle = null; });
    conn.on('connect', (e?: Error) => {
      if (e) return reject(e);
      // The endpoint starts a session at TEXTSIZE 4096 bytes, which cuts a plan's XML.
      conn.execSqlBatch(new Request('SET TEXTSIZE 2147483647', (err?: Error | null) => {
        if (!err) return resolve(conn);
        conn.close();
        reject(err);
      }));
    });
    conn.connect();
  });
}
async function withConnection<T>(host: string, db: string, token: string, fn: (c: Connection) => Promise<T>): Promise<T> {
  let conn = _idle;
  _idle = null;
  if (!conn) conn = await connect(host, db, token);
  let healthy = true;
  try { return await fn(conn); }
  catch (e) { healthy = false; throw e; }
  finally { if (healthy && !_idle) _idle = conn; else conn.close(); }
}

// A statement's rows: up to `keep` of them, each an array, and how many there were.
function run(conn: Connection, sql: string, keep: number): Promise<{ fields: { name: string; type: string }[]; rows: unknown[][]; numRows: number }> {
  return new Promise((resolve, reject) => {
    let fields: { name: string; type: string }[] = [];
    const rows: unknown[][] = [];
    let numRows = 0;
    const req = new Request(sql, (e?: Error | null) => (e ? reject(e) : resolve({ fields, rows, numRows })));
    req.on('columnMetadata', (cols: any) => {
      fields = (Array.isArray(cols) ? cols : Object.values(cols)).map((c: any) => ({ name: String(c.colName), type: String(c.type?.name ?? '') }));
    });
    req.on('row', (cols: any[]) => {
      numRows++;
      if (rows.length < keep) rows.push(cols.map((c, i) => value(c.value, fields[i]?.type)));
    });
    conn.execSqlBatch(req);
  });
}

// A value as JSON carries it, and as Explore shows it: a BIGINT a number while it is exact, a
// date as 2024-01-31, a time stamp as 2024-01-31 10:05:06.
function value(v: unknown, type = ''): unknown {
  if (v == null) return null;
  if (typeof v === 'string' && /^Int/.test(type) && /^-?\d+$/.test(v) && Number.isSafeInteger(Number(v))) return Number(v);
  if (v instanceof Date) {
    const s = v.toISOString().replace('T', ' ').replace(/Z$/, '').replace(/\.000$/, '').replace(/(\.\d*?)0+$/, '$1');
    return /^DateN?$/.test(type) ? s.slice(0, 10) : s;
  }
  if (Buffer.isBuffer(v)) return v.toString('hex');
  return v;
}

// A SHOWPLAN_XML's operators as a tree, each with its own estimated cost (its subtree's less its
// inputs'): what OneLake Studio's SQL endpoint mode shows (src/tsql.js planTree, kept the same).
interface PlanNode { op: string; logical: string; rows: number; cost: number; table: string | null; children: PlanNode[]; subtree?: number }
function planTree(xml: string): PlanNode[] {
  const attr = (tag: string, name: string): string | null => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
  const unxml = (s: string | null) => String(s ?? '').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const roots: PlanNode[] = [], stack: PlanNode[] = [];
  for (const m of String(xml).matchAll(/<RelOp\b[^>]*>|<\/RelOp>|<Object\b[^>]*\/?>/g)) {
    const tag = m[0];
    if (tag.startsWith('</')) { stack.pop(); continue; }
    if (tag.startsWith('<Object')) {
      const top = stack[stack.length - 1];
      if (top && !top.table) top.table = [attr(tag, 'Schema'), attr(tag, 'Table')].filter(Boolean).map(s => unxml(s).replace(/^\[|\]$/g, '')).join('.') || null;
      continue;
    }
    const node: PlanNode = { op: unxml(attr(tag, 'PhysicalOp')), logical: unxml(attr(tag, 'LogicalOp')), rows: Number(attr(tag, 'EstimateRows')) || 0,
      subtree: Number(attr(tag, 'EstimatedTotalSubtreeCost')) || 0, cost: 0, table: null, children: [] };
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    if (!tag.endsWith('/>')) stack.push(node);
  }
  const own = (n: PlanNode): PlanNode => {
    n.cost = Math.max(0, (n.subtree ?? 0) - n.children.reduce((s, k) => s + (k.subtree ?? 0), 0));
    n.children.forEach(own);
    delete n.subtree;
    return n;
  };
  return roots.map(own);
}

/**
 * SQL endpoint mode. `request` is JSON:
 *   { mode: 'model' }                    the model, read in place (MODEL_URL)
 *   { mode: 'rows', query, rows? }       a SELECT over the model, run: { fields, rows, numRows, truncated }
 *                                        (`rows`: the most kept, MAX_ROWS at most; 0 only counts them)
 *   { mode: 'plan', query }              its estimated plan: { plan }
 *   { mode: 'sql', query }               its T-SQL: { sql }
 * A failure is returned as { error }, naming the step.
 */
udf.func(
  'sqlEndpoint',
  async (ctx: RayfinContext<BlankAppSchema, AudienceType.Storage | AudienceType.Sql>, request: string): Promise<any> => {
    let step = 'the request';
    try {
      const r = JSON.parse(String(request ?? '{}'));
      const mode = String(r.mode ?? '');
      step = 'the settings SQL_ENDPOINT and SQL_DATABASE';
      const host = String(ctx.Secrets.SQL_ENDPOINT ?? '').trim();
      const db = String(ctx.Secrets.SQL_DATABASE ?? '').trim();
      if (!/^[a-z0-9-]+\.datawarehouse\.fabric\.microsoft\.com(,\d+)?$/i.test(host)) throw new Error('SQL_ENDPOINT is not <name>.datawarehouse.fabric.microsoft.com');
      if (!db) throw new Error('SQL_DATABASE is empty');
      step = 'the setting MODEL_URL (the model)';
      const { doc, compiler } = await modelAndCompiler(ctx, db);
      if (mode === 'model') return { model: doc };
      step = 'the query';
      const query = String(r.query ?? '');
      // A SELECT over the model, whole: nothing of the caller's own reaches the endpoint.
      if (!compiler.isSql(query)) throw new Error('the app runs SELECT … FROM the model, and nothing else');
      const sql: string = compiler.compile(query).sql;
      if (mode === 'sql') return { sql };
      step = 'the SQL endpoint';
      const token = ctx.Tokens.Sql;
      if (mode === 'plan') {
        const xml = await withConnection(host, db, token, async conn => {
          await run(conn, 'SET SHOWPLAN_XML ON', 0);
          try { return (await run(conn, sql, Number.MAX_SAFE_INTEGER)).rows.map(x => String(x[0])).join(''); }
          finally { await run(conn, 'SET SHOWPLAN_XML OFF', 0); }
        });
        return { plan: planTree(xml) };
      }
      if (mode !== 'rows') throw new Error(`no mode ${mode}`);
      const keep = Math.max(0, Math.min(MAX_ROWS, r.rows == null ? MAX_ROWS : Number(r.rows) || 0));
      const res = await withConnection(host, db, token, conn => run(conn, sql, keep));
      return { fields: res.fields.map(f => f.name), rows: res.rows, numRows: res.numRows, truncated: res.numRows > res.rows.length };
    } catch (e) {
      return { error: `${step}: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
  [],
);
