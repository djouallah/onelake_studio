'use strict';
// =============================================================================
// catalog.js — every OneLake request the extension makes
// =============================================================================
// Workspaces, items, Iceberg tables, Files/ listings, a table's metadata, a file's bytes:
// straight to OneLake with the VS Code token, at most four requests in flight, one retry
// after a 401 and backoff on Fabric's lazy conversion. What the names mean (which items
// hold tables, what a kind is called) is names.js; caching the answers is onelake.js.
// =============================================================================

const { strip, basename, displayName, holdsTables, itemKind, DFS_ORIGIN, dfsFileUrl } = require('./names');
const { authedFetch: send, limiter, mapPool, oneLakeMessage } = require('./http');

const TABLE_ORIGIN = 'https://onelake.table.fabric.microsoft.com';
const MAX_PARALLEL = 8;
// A hung listing left the tree's spinner up forever — there is no cancel path through
// getChildren — and a server that re-echoes its own continuation token would page for
// ever. Both bounds are far past anything a real tenant produces.
const FETCH_TIMEOUT_MS = 60_000;
const MAX_PAGES = 500;
// The timeout covers the body too, and a file's bytes (a SQLite copy, a saved file) can be
// hundreds of megabytes on a slow link — a listing's 60s would abort them part way.
const READ_TIMEOUT_MS = 10 * 60_000;

const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });

// How many OneLake requests this window has in flight at once, across the tree, the
// prefetch and the panel. OneLake answers a burst with 429s and seconds of backoff, so a
// queue here is faster than a stampede there.
const MAX_IN_FLIGHT = 4;

// Fabric writes a table's Iceberg metadata lazily, so the very call that triggers the
// conversion can lose the race to it: a 400/404 for a table the catalog just LISTED means
// "not yet", and the schedule spans Microsoft's documented 5s-2min window. 429/5xx is the
// catalog being busy. Anything else is a real answer and is not sat on.
const RESOLVE_BACKOFF_MS = [500, 1500, 3000, 6000, 10000, 15000, 20000, 30000];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// OneLake Studio reads OneLake from outside Fabric, which a tenant admin can switch off
// for every app at once. A 403 then looks exactly like one missing permission, so the
// setting is named wherever a 403 is reported — it is the one cause the user cannot see.
const EXTERNAL_ACCESS_HINT = ' If this happens for every workspace, the tenant setting ' +
  '"Users can access data stored in OneLake with apps external to Fabric" is probably off: ' +
  'a Fabric admin turns it on in the Admin portal, under Tenant settings > OneLake settings.';
// OneLake's message, as the end of a sentence: it brings its own full stop, or gets one.
const sentence = said => (said ? ` — ${said}${/[.!?]$/.test(said) ? '' : '.'}` : '.');
const forbidden = status => (status === 403 ? EXTERNAL_ACCESS_HINT : '');

// Where a table's folder can be: a lakehouse without schemas keeps it directly under Tables/.
const tableDirs = (lh, t) => [t.schema ? `${lh.item}/Tables/${t.schema}/${t.table}` : null, `${lh.item}/Tables/${t.table}`]
  .filter(Boolean);

/**
 * @param {object} opts
 * @param {() => Promise<string|null>} opts.getToken  current access token, or null
 */
function createCatalog({ getToken, dfsOrigin = DFS_ORIGIN, tableOrigin = TABLE_ORIGIN,
                         backoffMs = RESOLVE_BACKOFF_MS, onRequest = () => {} }) {
  const gate = limiter(MAX_IN_FLIGHT);

  // Every request, for the read log: how long OneLake took, what it said, how much came
  // back. The path only — the origin is always OneLake and the query string is noise.
  const report = (url, r, t0, error) => {
    let path = String(url);
    try { const u = new URL(url); path = decodeURIComponent(u.pathname) + (u.searchParams.get('directory') ? `?dir=${u.searchParams.get('directory')}` : ''); } catch (_) {}
    try {
      onRequest({ cache: 'miss', ms: Date.now() - t0, status: r ? r.status : 0, path,
                  bytes: r ? Number(r.headers.get('content-length')) || 0 : 0, error });
    } catch (_) {}
  };
  // One request (http.js): a fresh token once on a 401, each send through the gate and into
  // the read log. OneLake's answer, whatever it is, is the caller's to read.
  function authedFetch(url, headers = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    return send(url, { getToken, headers, timeoutMs, through: async go => {
      const t0 = Date.now();
      try {
        const r = await gate(go);
        report(url, r, t0);
        return r;
      } catch (e) { report(url, null, t0, (e && e.message) || String(e)); throw e; }
    } });
  }

  async function getJson(url, what) {
    const r = await authedFetch(url);
    if (!r.ok) {
      const said = await oneLakeMessage(r);
      const e = new Error(`${what} failed (HTTP ${r.status})` + sentence(said) + forbidden(r.status));
      e.status = r.status;
      throw e;
    }
    return { json: await r.json().catch(() => ({})), cont: r.headers.get('x-ms-continuation') || '' };
  }

  // Each filesystem at the account root is a workspace, so the whole catalog comes from
  // the storage token the data reads already use — no Fabric REST API, no second scope.
  async function listWorkspaces() {
    const out = [];
    let cont = '', pages = 0;
    do {
      if (++pages > MAX_PAGES) throw new Error(
        `Listing workspaces did not finish after ${MAX_PAGES} pages — giving up`);
      const u = new URL(`${dfsOrigin}/`);
      u.searchParams.set('resource', 'account');
      if (cont) u.searchParams.set('continuation', cont);
      const r = await getJson(u.toString(), 'Listing workspaces');
      for (const f of (r.json.fileSystems || [])) out.push(f.name);
      cont = r.cont;
    } while (cont);
    return out.sort(byName);
  }

  // ADLS Gen2 "List Path", one level. Mirrors data.js listPaths, including its 404 rule:
  // absent on the first page is a normal empty answer; absent part way through pagination
  // means the directory changed under us, and returning what was gathered so far would
  // report a truncated listing as a complete one.
  async function listPaths(ws, directory) {
    const out = [];
    let cont = '', page = 0;
    do {
      const u = new URL(`${dfsOrigin}/${encodeURIComponent(ws)}`);
      u.searchParams.set('resource', 'filesystem');
      u.searchParams.set('recursive', 'false');
      u.searchParams.set('directory', strip(directory));
      if (cont) u.searchParams.set('continuation', cont);
      const r = await authedFetch(u.toString());
      if (r.status === 404) {
        if (page === 0) return out;
        throw new Error(`Listing of ${strip(directory)} was interrupted — it changed while being read`);
      }
      if (!r.ok) {
        const said = await oneLakeMessage(r);
        const e = new Error(`list HTTP ${r.status} for ${strip(directory) || ws}` + sentence(said) + forbidden(r.status));
        e.status = r.status;
        throw e;
      }
      const j = await r.json().catch(() => ({}));
      for (const p of (j.paths || [])) {
        out.push({
          name: p.name,
          // OneLake sends this as the string "true", not a boolean.
          isDir: p.isDirectory === true || p.isDirectory === 'true',
          bytes: Number(p.contentLength || 0),
          lastModified: p.lastModified ? Date.parse(p.lastModified) || null : null,
          // Which version of the file this is: its etag, or failing that when it was last
          // written and how big it is. A file's bytes are cached under it (onelake.js), so
          // a rewritten file is a new key and is read again.
          version: p.etag ? String(p.etag)
                 : p.lastModified ? `${p.lastModified}|${p.contentLength || 0}` : '',
        });
      }
      cont = r.headers.get('x-ms-continuation') || '';
      page++;
      if (page > MAX_PAGES) throw new Error(
        `Listing of ${strip(directory) || ws} did not finish after ${MAX_PAGES} pages — giving up`);
    } while (cont);
    return out;
  }

  // Whether a directory is there. listPaths can't say: to it, a 404 is an empty listing.
  async function dirExists(ws, directory) {
    const u = new URL(`${dfsOrigin}/${encodeURIComponent(ws)}`);
    u.searchParams.set('resource', 'filesystem');
    u.searchParams.set('recursive', 'false');
    u.searchParams.set('directory', strip(directory));
    u.searchParams.set('maxResults', '1');
    return (await authedFetch(u.toString())).status !== 404;
  }

  async function listItems(ws) {
    const entries = await listPaths(ws, '');
    const items = [];
    for (const e of entries) {
      if (!e.isDir) continue;
      const name = basename(e.name);
      if (holdsTables(name)) items.push({ name, kind: itemKind(name) });
    }
    return items.sort((a, b) => byName(a.name, b.name));
  }

  // The Iceberg REST catalog is the only table path — there is no DFS walk to fall back to,
  // by design (a warehouse has no metadata/ directory at all, so the walk never worked for
  // one). A failure here is fatal and says so.
  const ircPrefixes = new Map();
  const ircSeg = s => String(s).split('/').map(encodeURIComponent).join('/');

  // The config call costs seconds and its answer — the item's GUIDs — lasts as long as the
  // item, so it is also kept on disk (onelake.js hands over the account's store), and a
  // restart does not pay it again. `kept` holds the warehouses whose prefix came from there.
  let prefixStore = null;   // { get(warehouse), set(warehouse, prefix) }
  const kept = new Set();
  function usePrefixStore(s) { prefixStore = s; ircPrefixes.clear(); kept.clear(); }

  async function ircPrefixFor(lh, { pastDisk = false } = {}) {
    const warehouse = `${lh.workspace}/${lh.item}`;
    if (ircPrefixes.has(warehouse)) return ircPrefixes.get(warehouse);
    const onDisk = !pastDisk && prefixStore && await Promise.resolve(prefixStore.get(warehouse)).catch(() => undefined);
    if (onDisk) {
      ircPrefixes.set(warehouse, onDisk);
      kept.add(warehouse);
      return onDisk;
    }
    const { json } = await getJson(
      `${tableOrigin}/iceberg/v1/config?warehouse=${encodeURIComponent(warehouse)}`,
      `Iceberg catalog config for ${warehouse}`);
    // A PATH prefix: its slashes are separators and must survive into the next URL, which
    // is why it is spliced in raw and only the segments after it are encoded.
    const prefix = (json.overrides && json.overrides.prefix) || warehouse;
    ircPrefixes.set(warehouse, prefix);
    kept.delete(warehouse);
    if (prefixStore) Promise.resolve(prefixStore.set(warehouse, prefix)).catch(() => {});
    return prefix;
  }

  // A prefix from disk may be an item's that was deleted and made again under the same
  // name. A 400 or 404 on one asks the config again before anything is concluded; true
  // when that gave a different prefix, i.e. the call is worth making again.
  async function stalePrefix(lh, e) {
    const warehouse = `${lh.workspace}/${lh.item}`;
    if (!(e.status === 400 || e.status === 404) || !kept.has(warehouse)) return false;
    const was = ircPrefixes.get(warehouse);
    kept.delete(warehouse);
    ircPrefixes.delete(warehouse);
    return (await ircPrefixFor(lh, { pastDisk: true })) !== was;
  }

  // Returns [{ schema, table }] — the same shape the panel's own listing produces. A
  // namespace is an array of levels; OneLake returns exactly one, and a synthetic "dbo"
  // for items that have no schemas of their own.
  //
  // Not memoised here: the store (onelake.js) already holds the answer, in memory and on
  // disk, and single-flights the request — a memo here only meant the store's refresh after
  // its TTL got the session's first answer back, so a new table never showed up.
  async function listTables(lh) {
    let prefix = await ircPrefixFor(lh);
    const listSchemas = () => getJson(`${tableOrigin}/iceberg/v1/${prefix}/namespaces`,
      `Listing schemas in ${lh.item}`);
    let ns;
    try { ({ json: ns } = await listSchemas()); }
    catch (e) {
      if (!await stalePrefix(lh, e)) throw e;
      prefix = await ircPrefixFor(lh);
      ({ json: ns } = await listSchemas());
    }
    const names = (ns.namespaces || []).map(n => (Array.isArray(n) ? n.join('.') : String(n)));
    if (!names.length) return [];

    const lists = await mapPool(names, n => getJson(
      `${tableOrigin}/iceberg/v1/${prefix}/namespaces/${ircSeg(n)}/tables`,
      `Listing tables in ${n}`), MAX_PARALLEL);

    const tables = [];
    names.forEach((schema, i) => {
      for (const id of (lists[i].json.identifiers || [])) tables.push({ schema, table: id.name });
    });
    return tables.sort((a, b) =>
      (a.schema || '').localeCompare(b.schema || '') || a.table.localeCompare(b.table));
  }

  // One table's Iceberg metadata: the catalog's loadTable, which hands back the document
  // inline along with metadata-location — the file the engine reads with iceberg_scan.
  // `onWait` hears why a call is taking long (conversion pending, catalog busy), so the
  // panel can say so instead of showing a spinner with no story.
  async function loadTable(lh, t, { onWait = () => {} } = {}) {
    const label = t.schema ? `${t.schema}.${t.table}` : t.table;
    const urlOf = prefix => `${tableOrigin}/iceberg/v1/${prefix}/namespaces/${ircSeg(t.schema || 'dbo')}/tables/${ircSeg(t.table)}`;
    let url = urlOf(await ircPrefixFor(lh));
    for (let attempt = 0; ; attempt++) {
      try {
        const { json } = await getJson(url, `Reading ${label} from the Iceberg catalog`);
        if (!json || !json.metadata) throw new Error(`${label}: the catalog returned no metadata document`);
        return { metadataLocation: json['metadata-location'] || null, metadata: json.metadata };
      } catch (e) {
        // A prefix from disk that no longer holds: asked again at once, not waited out as a
        // conversion in progress.
        if (await stalePrefix(lh, e)) { url = urlOf(await ircPrefixFor(lh)); attempt--; continue; }
        const notYet = e.status === 400 || e.status === 404;
        // A table waiting for its conversion has its folder. With none there is nothing to wait for.
        if (notYet && attempt === 0 && await folderGone(lh, t)) {
          throw Object.assign(new Error(`no table ${label} in ${lh.workspace}/${displayName(lh.item)}`),
            { status: 404, noTable: true });
        }
        const busy = e.status === 429 || e.status >= 500;
        if (!(notYet || busy) || attempt >= backoffMs.length) {
          if (notYet) e.message += await conversionStory(lh, t);
          throw e;
        }
        const waited = Math.round(backoffMs.slice(0, attempt + 1).reduce((a, b) => a + b, 0) / 1000);
        onWait(notYet
          ? `Waiting for Fabric to generate Iceberg metadata for ${label}… (${waited}s so far)`
          : `The Iceberg catalog answered HTTP ${e.status} for ${label}; retrying… (${waited}s so far)`);
        await sleep(backoffMs[attempt]);
      }
    }
  }

  // True only when OneLake says neither folder is there. A check that can't tell (a 403, no
  // connection) leaves the table waited on, as it would be with no check.
  async function folderGone(lh, t) {
    try {
      for (const dir of tableDirs(lh, t)) if (await dirExists(lh.workspace, dir)) return false;
      return true;
    } catch (_) { return false; }
  }

  // Why a table has no Iceberg metadata, in Fabric's own words where it left any: the
  // conversion writes latest_conversion_log.txt into the table's metadata/ and says there
  // whether it failed, and why (a type it cannot convert, more than 5,000 commits…). No log
  // at all means it never tried.
  async function conversionStory(lh, t) {
    for (const dir of tableDirs(lh, t)) {
      let text;
      try { text = new TextDecoder().decode(await readBytes(lh.workspace, `${dir}/metadata/latest_conversion_log.txt`)); }
      catch (_) { continue; }
      // "Error Details:      <message>" — one field per line, padded to a column.
      const field = name => {
        const line = text.split(/\r?\n/).find(l => l.toLowerCase().startsWith(name.toLowerCase() + ':'));
        return line ? line.slice(name.length + 1).trim() : '';
      };
      if (/^failed$/i.test(field('Status'))) {
        return ` Fabric could not convert this table to Iceberg (conversion log, ${field('Timestamp (UTC)') || 'undated'}): ` +
          `${field('Error Details') || field('Error Code') || 'no details given'}` +
          (/^user$/i.test(field('Error Category')) ? ' — the table itself has to change before it converts.' : '.');
      }
      return ' Fabric converted this table before, but has not written Iceberg metadata for its ' +
        'latest version yet; conversion runs after each commit and can take up to two minutes.';
    }
    return ' Fabric has not converted this table to Iceberg: there is no conversion log beside it. ' +
      'Conversion runs after a commit to the table, so writing to it once usually starts it.';
  }

  // One level of Files/. `dir` is relative to Files/. Unlike the panel's version this
  // carries no `queryable` flag: whether a file can be opened depends on which DuckDB
  // extensions loaded, which is the webview's business and not knowable from here.
  async function listFiles({ workspace, item }, dir = '') {
    const entries = await listPaths(workspace, `${item}/Files${dir ? '/' + strip(dir) : ''}`);
    return entries.map(e => ({
      name: basename(e.name),
      path: e.name,           // workspace-relative, the form the panel expects
      isDir: e.isDir,
      bytes: e.bytes,
      version: e.version,
    })).sort((a, b) => (b.isDir - a.isDir) || byName(a.name, b.name));
  }

  // A change of identity, or a refresh of the whole tree, forgets every item's catalog
  // prefix held in memory; a refresh of one node only the prefixes under it.
  function reset(scope) {
    if (!scope || !scope.workspace) { ircPrefixes.clear(); return; }
    const under = scope.item ? k => k === `${scope.workspace}/${scope.item}`
                             : k => k.startsWith(`${scope.workspace}/`);
    for (const k of [...ircPrefixes.keys()]) if (under(k)) ircPrefixes.delete(k);
  }


  // A file's bytes — whole, or the `range` asked for (`bytes=0-15` to sniff a header).
  // For the panel's image and .bim previews, its SQLite copies, and anything else that
  // needs the bytes rather than a query.
  async function readBytes(ws, path, { range } = {}) {
    const r = await authedFetch(dfsFileUrl(ws, path, dfsOrigin),
      range ? { range } : {}, READ_TIMEOUT_MS);
    if (!r.ok) {
      const said = await oneLakeMessage(r);
      const e = new Error(`Reading ${path} failed (HTTP ${r.status})` + sentence(said) + forbidden(r.status));
      e.status = r.status;
      throw e;
    }
    return new Uint8Array(await r.arrayBuffer());
  }

  // One level of any directory under an item, workspace-relative: a table's _delta_log.
  const listDir = (ws, dir) => listPaths(ws, dir);

  return { listWorkspaces, listItems, listTables, listFiles, listDir, loadTable, readBytes, reset, usePrefixStore };
}

module.exports = { createCatalog, TABLE_ORIGIN };
