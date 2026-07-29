'use strict';
// =============================================================================
// catalog.js — listing OneLake from the extension host, for the tree
// =============================================================================
// The same four calls site/data.js makes, reimplemented here because data.js cannot be
// loaded in Node: its first statement imports duckdb-wasm from a CDN, and this side has
// no business booting an engine to draw a tree.
//
// What is NOT reimplemented is the classification — which item names hold tables, what
// kind a name means, which items have a Files/ area. Those rules are about Fabric's
// internal type names rather than the portal's, they have cost real bugs, and they live
// in site/paths.js under test. This module imports them from there; if that file and this
// one ever disagree about what a `.SQLDbNative` is, the tree and the panel disagree about
// what a workspace contains.
//
// Listing goes straight to OneLake with the VS Code token attached. The loopback proxy
// exists for DuckDB's range reads — code running here can set an Authorization header
// itself, and routing through the proxy would only add a hop and a second failure mode.
// =============================================================================

const { pathToFileURL } = require('node:url');

const DFS_ORIGIN = 'https://onelake.dfs.fabric.microsoft.com';
const TABLE_ORIGIN = 'https://onelake.table.fabric.microsoft.com';
const MAX_PARALLEL = 8;

// paths.js is ESM and this file is CJS, so it arrives through a dynamic import — resolved
// from the site directory the caller found, which differs between a packaged extension and
// F5 from a checkout. Loaded once.
let pathsP = null;
function loadPaths(siteFsPath) {
  if (!pathsP) pathsP = import(pathToFileURL(`${siteFsPath}/paths.js`).href);
  return pathsP;
}

const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });

async function mapPool(items, fn, limit = MAX_PARALLEL) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// OneLake says why it refused, in the body. Dropping that turns "this shortcut's auth type
// is not supported" into a bare 400 and sends whoever reads it looking in the wrong place.
async function oneLakeMessage(r) {
  try {
    const j = JSON.parse(await r.text());
    return (j && j.error && j.error.message) || '';
  } catch (_) { return ''; }
}

/**
 * @param {object} opts
 * @param {() => Promise<string|null>} opts.getToken  current access token, or null
 * @param {string} opts.siteFsPath                    directory holding paths.js
 */
function createCatalog({ getToken, siteFsPath, dfsOrigin = DFS_ORIGIN, tableOrigin = TABLE_ORIGIN }) {
  // Same bargain as data.js's authedFetch: retry once on 401 and only on 401. A 403 means
  // this identity may not read that path, and a fresh token will not change its mind.
  async function authedFetch(url) {
    let token = await getToken();
    if (!token) {
      const e = new Error('Not signed in to a Microsoft account.');
      e.status = 401;
      throw e;
    }
    let r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (r.status === 401) {
      const fresh = await getToken();
      if (fresh && fresh !== token) {
        r = await fetch(url, { headers: { authorization: `Bearer ${fresh}` } });
      }
    }
    return r;
  }

  async function getJson(url, what) {
    const r = await authedFetch(url);
    if (!r.ok) {
      const said = await oneLakeMessage(r);
      const e = new Error(`${what} failed (HTTP ${r.status})` + (said ? ` — ${said}` : ''));
      e.status = r.status;
      throw e;
    }
    return { json: await r.json().catch(() => ({})), cont: r.headers.get('x-ms-continuation') || '' };
  }

  // Each filesystem at the account root is a workspace, so the whole catalog comes from
  // the storage token the data reads already use — no Fabric REST API, no second scope.
  async function listWorkspaces() {
    const out = [];
    let cont = '';
    do {
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
    const { strip } = await loadPaths(siteFsPath);
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
        const e = new Error(`list HTTP ${r.status} for ${strip(directory) || ws}` + (said ? ` — ${said}` : ''));
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
        });
      }
      cont = r.headers.get('x-ms-continuation') || '';
      page++;
    } while (cont);
    return out;
  }

  async function listItems(ws) {
    const { basename, holdsTables, itemKind } = await loadPaths(siteFsPath);
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

  async function ircPrefixFor(lh) {
    const warehouse = `${lh.workspace}/${lh.item}`;
    if (ircPrefixes.has(warehouse)) return ircPrefixes.get(warehouse);
    const { json } = await getJson(
      `${tableOrigin}/iceberg/v1/config?warehouse=${encodeURIComponent(warehouse)}`,
      `Iceberg catalog config for ${warehouse}`);
    // A PATH prefix: its slashes are separators and must survive into the next URL, which
    // is why it is spliced in raw and only the segments after it are encoded.
    const prefix = (json.overrides && json.overrides.prefix) || warehouse;
    ircPrefixes.set(warehouse, prefix);
    return prefix;
  }

  // Returns [{ schema, table }] — the same shape the panel's own listing produces. A
  // namespace is an array of levels; OneLake returns exactly one, and a synthetic "dbo"
  // for items that have no schemas of their own.
  //
  // Memoised per item, and deliberately by promise: the tree asks for this once to decide
  // whether an item has schemas and again for each schema it draws, and without the cache
  // opening a five-schema warehouse would cost six full catalog listings. Refresh is what
  // clears it, which is also the only thing that should.
  const tablesC = new Map();
  function listTables(lh) {
    const key = `${lh.workspace}/${lh.item}`;
    if (!tablesC.has(key)) {
      tablesC.set(key, listTablesUncached(lh).catch(e => { tablesC.delete(key); throw e; }));
    }
    return tablesC.get(key);
  }

  async function listTablesUncached(lh) {
    const prefix = await ircPrefixFor(lh);
    const { json: ns } = await getJson(`${tableOrigin}/iceberg/v1/${prefix}/namespaces`,
      `Listing schemas in ${lh.item}`);
    const names = (ns.namespaces || []).map(n => (Array.isArray(n) ? n.join('.') : String(n)));
    if (!names.length) return [];

    const lists = await mapPool(names, n => getJson(
      `${tableOrigin}/iceberg/v1/${prefix}/namespaces/${ircSeg(n)}/tables`,
      `Listing tables in ${n}`));

    const tables = [];
    names.forEach((schema, i) => {
      for (const id of (lists[i].json.identifiers || [])) tables.push({ schema, table: id.name });
    });
    return tables.sort((a, b) =>
      (a.schema || '').localeCompare(b.schema || '') || a.table.localeCompare(b.table));
  }

  // One level of Files/. `dir` is relative to Files/. Unlike the panel's version this
  // carries no `queryable` flag: whether a file can be opened depends on which DuckDB
  // extensions loaded, which is the webview's business and not knowable from here.
  async function listFiles({ workspace, item }, dir = '') {
    const { basename, strip } = await loadPaths(siteFsPath);
    const entries = await listPaths(workspace, `${item}/Files${dir ? '/' + strip(dir) : ''}`);
    return entries.map(e => ({
      name: basename(e.name),
      path: e.name,           // workspace-relative, the form the panel expects
      isDir: e.isDir,
      bytes: e.bytes,
    })).sort((a, b) => (b.isDir - a.isDir) || byName(a.name, b.name));
  }

  // A refresh, or a change of identity, invalidates everything held across calls.
  function reset() { ircPrefixes.clear(); tablesC.clear(); }

  // The classification rules, for callers that need to render with them (a Files/ area,
  // an item kind's label, a byte count). Same module instance this file uses, so the tree
  // and the listing can never disagree about what an item is.
  const paths = () => loadPaths(siteFsPath);

  return { listWorkspaces, listItems, listTables, listFiles, reset, paths };
}

module.exports = { createCatalog, DFS_ORIGIN, TABLE_ORIGIN };
