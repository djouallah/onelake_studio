import { createHmac } from 'node:crypto';

import {
  UserDataFunctions,
  AudienceType,
  type RayfinContext,
} from '@microsoft/fabric-user-data-functions';

import type { BlankAppSchema } from '../../data/schema.js';

const udf = new UserDataFunctions();

/*
 * The browser never receives a token: openCatalog uses the app identity's storage token here,
 * server side, and hands back only (the app identity is the app item's owner, so whoever may open
 * the app reads these tables with the owner's rights)
 *   - where each table the page asked for is now: its current metadata.json, from the OneLake
 *     Iceberg REST catalog (loadTable), and
 *   - a OneLake user-delegation SAS for each of those tables, read-only, on its own folder: DuckDB
 *     in the browser reads the metadata, the manifests and the data files with them.
 * Only the model's tables (TABLES): someone who can call this reads what the app shows, not the rest of
 * the lakehouse, whichever tables they ask for. The model is the page's own, site/model.json, made at
 * export from the model.yaml the app's file holds: this function never reads it.
 *
 * CATALOG_URL (an app setting): the catalog the app reads,
 *   https://onelake.table.fabric.microsoft.com/iceberg/<workspace id>/<lakehouse id>
 * TABLES (an app setting): the tables the model names, schema.table, comma-separated.
 * Both are set by OneLake Studio's Export to Fabric, which deploys this app.
 * The workspace must allow "Authenticate with OneLake user-delegated SAS tokens".
 *
 * An app on a semantic model has no function of ours: its page turns Explore's query into DAX
 * (dax-sql) and runs it through the app's fabric-semanticmodel connector, as the person viewing it.
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

// TABLES: the tables the app may read, schema.table, comma-separated: the ones its model names, given by
// the export. The model itself is the page's own (site/model.json): this reads no model.
function appTables(ctx: StorageCtx): string[] {
  const out = [...new Set(String(ctx.Secrets.TABLES ?? '').split(',').map(s => s.trim()).filter(Boolean))];
  if (!out.length) throw new Error('TABLES is empty: export the app again');
  return out;
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

// What the page plans a table from: its current snapshot's manifest list and the size of its files. The
// catalog's answer holds the table's whole metadata, so the page need not fetch metadata.json for each table.
type Snapshot = { manifestList: string | null; bytes: number | null };
function snapshotOf(m: any): Snapshot | null {
  if (!m || typeof m !== 'object') return null;
  const current = m['current-snapshot-id'];
  // A table nothing was written to has no snapshot, and no files.
  if (current == null || current === -1) return { manifestList: null, bytes: 0 };
  const s = (Array.isArray(m.snapshots) ? m.snapshots : []).find((x: any) => String(x?.['snapshot-id']) === String(current));
  if (!s?.['manifest-list']) return null;
  const bytes = Number(s.summary?.['total-files-size']);
  return { manifestList: String(s['manifest-list']), bytes: Number.isFinite(bytes) ? bytes : null };
}

// Each table's current metadata.json, a few at a time. A table the catalog does not have is
// `missing`: the page shows no data where it reads it, as it does for a table not deployed.
async function loadTables(endpoint: string, prefix: string, tables: string[], token: string):
    Promise<{ metadata: Record<string, string>; snapshots: Record<string, Snapshot>; missing: string[] }> {
  const metadata: Record<string, string> = {};
  const snapshots: Record<string, Snapshot> = {};
  const missing: string[] = [];
  await eachLimited(tables, CATALOG_CONCURRENCY, async t => {
    const [ns, name] = t.split('.');
    const { status, body } = await getJson(`${endpoint}/v1/${prefix}/namespaces/${ns}/tables/${name}`, token);
    if (status === 404) { missing.push(t); return; }
    const location = body?.['metadata-location'];
    if (status !== 200 || !location) throw new Error(`${t}: HTTP ${status} ${body?.error?.message ?? 'no metadata-location'}`);
    metadata[t] = location;
    const snapshot = snapshotOf(body?.metadata);
    if (snapshot) snapshots[t] = snapshot;
  });
  return { metadata, snapshots, missing: missing.sort() };
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
 * The tables the page asks for (`schema.table`, comma-separated) — or, asked for none, every table
 * the model names (TABLES) — as they are in the catalog now, and a read-only SAS on each one's folder
 * to read it with. A table the model doesn't name is `missing`.
 * A failure is returned as { error }, naming the step: thrown, it reaches the browser as a bare
 * 500 that says nothing. The message never holds a token or a key.
 */
udf.func(
  'openCatalog',
  async (ctx: RayfinContext<BlankAppSchema, AudienceType.Storage>, tables: string): Promise<{
    metadata: Record<string, string>; snapshots: Record<string, Snapshot>; missing: string[];
    sas: Record<string, string>; expiresOn: string;
  } | { error: string }> => {
    let step = 'the table names';
    try {
      const asked = [...new Set(String(tables ?? '').split(',').map(s => s.trim()).filter(Boolean))];
      step = 'the storage token of the app identity';
      const token = ctx.Tokens.Storage;
      step = "the setting TABLES (the model's tables)";
      const inModel = appTables(ctx);
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
      return { metadata: catalog.metadata, snapshots: catalog.snapshots,
               missing: [...catalog.missing, ...bad].sort(), sas, expiresOn: iso(expiry) };
    } catch (e) {
      return { error: `${step}: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
  [],
);
