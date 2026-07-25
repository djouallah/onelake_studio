// =============================================================================
// data.js — OneLake Iceberg engine on DuckDB-WASM
// =============================================================================
// Given an AuthProvider (auth.js) and a lakehouse path, this module:
//   1. brings up DuckDB-WASM,
//   2. lists the lakehouse's tables over the OneLake DFS (ADLS Gen2) API by
//      friendly name (workspace/lakehouse.Lakehouse) — no GUIDs, storage token only,
//   3. for a chosen Iceberg table, resolves its current metadata.json -> snapshot
//      -> manifest-list, reads the Avro manifests with DuckDB's read_avro to get the
//      data-file (parquet) paths,
//   4. registers those parquet files as URLs so DuckDB range-reads them itself, and
//      exposes the table as a read-only VIEW you can run SQL against. Nothing is
//      downloaded whole: sw.js signs DuckDB's requests, so a query pulls only the
//      row groups and columns it touches.
//
// The Iceberg reading (read_avro manifests -> read_parquet data files) mirrors
// djouallah/dbt_fabric_python_iceberg's dashboard; the difference here is that the
// table is discovered by friendly name over DFS instead of a GUID REST-catalog call.
//
// DOM-free: progress is reported through the injected `onStatus` callback.
// =============================================================================

// @latest matches djouallah/dbt_fabric_python_iceberg's dashboard, which reads Iceberg
// Avro manifests with read_avro() in the browser — the avro extension autoloads on first
// use from the DuckDB extension repo (the service worker makes that cross-origin fetch
// COEP-compatible). Pin to a specific version once a known-good one is confirmed for you.
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@latest/+esm";

const DFS_HOST = "onelake.dfs.fabric.microsoft.com";

export function createEngine(auth, { onStatus = () => {} } = {}) {
  let db = null, conn = null, worker = null;
  let _seq = 0;
  let icebergExt = false;     // did the 'iceberg' extension load? (set in init)
  const loaded = new Map();   // "schema.table" -> { label, ident, columns, fileCount, bytes }

  // ---------------------------------------------------------------------------
  // DuckDB bootstrap
  // ---------------------------------------------------------------------------
  async function init() {
    onStatus("Loading DuckDB-WASM…");
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
    );
    worker = new Worker(workerUrl);
    db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    conn = await db.connect();
    await conn.query("SET preserve_insertion_order = false;");
    // read_avro() (used to parse Iceberg manifests) comes from the 'avro' extension.
    // duckdb-wasm autoloads it on first use; try to preload it up front so the first
    // manifest read is fast, but don't fail init if preloading isn't supported —
    // the autoload on the first read_avro() call is the real mechanism.
    try { await conn.query("LOAD avro;"); }
    catch (_) {
      try { await conn.query("INSTALL avro; LOAD avro;"); }
      catch (e) { console.warn("[engine] avro preload skipped; relying on autoload:", e.message); }
    }
    // The 'iceberg' extension is the preferred reader (see loadTable): it applies
    // merge-on-read delete files and prunes by partition/column stats, neither of
    // which the hand-rolled manifest walk does. It has its own Avro reader, so it
    // doesn't need the extension above. If it can't be loaded we fall back.
    try { await conn.query("LOAD iceberg;"); icebergExt = true; }
    catch (_) {
      try { await conn.query("INSTALL iceberg; LOAD iceberg;"); icebergExt = true; }
      catch (e) { console.warn("[engine] iceberg extension unavailable; using manifest walk:", e.message); }
    }
    console.log(`[engine] DuckDB ready — crossOriginIsolated=${self.crossOriginIsolated}`);
    return { db, conn };
  }

  // ---------------------------------------------------------------------------
  // Path helpers
  // ---------------------------------------------------------------------------
  const strip = s => String(s).replace(/^\/+|\/+$/g, "");
  const basename = p => strip(p).split("/").pop();
  const encPath = p => strip(p).split("/").map(encodeURIComponent).join("/");
  const dfsBase = ws => `https://${DFS_HOST}/${encodeURIComponent(ws)}`;
  // A DFS "list" entry .name is already relative to the filesystem (workspace) root.
  const dfsUrl = (ws, name) => `${dfsBase(ws)}/${encPath(name)}`;

  // "workspace/lakehouse.Lakehouse" (or a full https/abfss URL) -> { workspace, item }.
  function parseLakehouse(input) {
    let s = String(input || "").trim();
    if (!s) throw new Error("Enter a lakehouse path, e.g.  myworkspace/mylakehouse.Lakehouse");
    s = s.replace(/^https?:\/\/[^/]+\//i, "").replace(/^abfss:\/\/[^@]+@[^/]+\//i, "");
    const parts = strip(s).split("/").filter(Boolean);
    if (parts.length < 2) throw new Error(`Path must be  workspace/lakehouse.Lakehouse  (got "${input}")`);
    const workspace = parts[0];
    let item = parts[1];
    if (!/\.lakehouse$/i.test(item)) item += ".Lakehouse";
    return { workspace, item };
  }

  // Normalize an Iceberg path (abfs(s)://…, absolute https, or relative) to an authed https URL.
  // Fabric writes `abfs://<workspace-guid>@onelake.dfs.fabric.microsoft.com/<item-guid>/Tables/…`
  // — note the SINGLE s, and GUIDs rather than the friendly names the user typed. The filesystem
  // component becomes the first path segment: https://onelake.dfs…/<workspace-guid>/<item-guid>/…
  function toHttps(ws, u) {
    u = String(u);
    const ab = u.match(/^abfss?:\/\/([^@]+)@[^/]+\/(.*)$/i);
    if (ab) return `https://${DFS_HOST}/${encodeURIComponent(decodeURIComponent(ab[1]))}/${encPath(ab[2])}`;
    if (/^https?:\/\//i.test(u)) return u;
    return `${dfsBase(ws)}/${encPath(u)}`;
  }

  // ---------------------------------------------------------------------------
  // Authed fetch (+ one 401/403 retry through a silent token refresh)
  // ---------------------------------------------------------------------------
  // The one place the retry policy lives. OneLake answers 401/403 once the token
  // expires (~1h); auth.refresh() invalidates it and renews silently, then we replay
  // the request once. If renewal fails, the original response is returned so the
  // caller reports the real status.
  async function authedFetch(url) {
    const go = () => fetch(url, { headers: auth.getHeaders() });
    const r = await go();
    if (r.status !== 401 && r.status !== 403) return r;
    return (await auth.refresh()) ? go() : r;
  }

  async function fetchAuthed(url) {
    const r = await authedFetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} for …${String(url).slice(-72)}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  const fetchText = async u => new TextDecoder().decode(await fetchAuthed(u));
  const fetchJson = async u => JSON.parse(await fetchText(u));

  // ADLS Gen2 "List Path" over the workspace filesystem. Returns [{name,isDir,bytes,mtime}].
  // recursive=false lists only the immediate children of `directory` (no data-file walk).
  async function listPaths(ws, directory, recursive = false) {
    const out = [];
    let cont = "";
    do {
      const u = new URL(dfsBase(ws));
      u.searchParams.set("resource", "filesystem");
      u.searchParams.set("recursive", String(recursive));
      u.searchParams.set("directory", strip(directory));
      if (cont) u.searchParams.set("continuation", cont);
      const r = await authedFetch(u.toString());
      if (r.status === 404) return out;           // directory doesn't exist
      if (!r.ok) throw new Error(`list HTTP ${r.status} for ${strip(directory)}`);
      const j = await r.json().catch(() => ({}));
      for (const p of (j.paths || [])) {
        out.push({
          name: p.name,
          isDir: p.isDirectory === true || p.isDirectory === "true",
          bytes: Number(p.contentLength || 0),
          mtime: Date.parse(p.lastModified || "") || 0,
        });
      }
      cont = r.headers.get("x-ms-continuation") || "";
    } while (cont);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Table discovery — browse Tables/ by name, classify iceberg vs delta.
  // Handles both schema-enabled (Tables/<schema>/<table>) and flat (Tables/<table>).
  // ---------------------------------------------------------------------------
  function classifyChildren(kids) {
    const hasIceberg = kids.some(k => k.isDir && basename(k.name) === "metadata");
    const hasDelta = kids.some(k => k.isDir && basename(k.name) === "_delta_log");
    return hasIceberg ? "iceberg" : hasDelta ? "delta" : null;
  }

  async function listTables({ workspace, item }) {
    const level1 = (await listPaths(workspace, `${item}/Tables`, false)).filter(e => e.isDir);
    const tables = [];
    for (const l1 of level1) {
      const kids = await listPaths(workspace, l1.name, false);
      const kind = classifyChildren(kids);
      if (kind) {
        // Table directly under Tables/ (flat, non-schema lakehouse).
        tables.push({ schema: null, table: basename(l1.name), root: l1.name, kind });
      } else {
        // Treat l1 as a schema; its child dirs are tables.
        const schema = basename(l1.name);
        for (const t of kids.filter(k => k.isDir)) {
          const tkids = await listPaths(workspace, t.name, false);
          tables.push({ schema, table: basename(t.name), root: t.name, kind: classifyChildren(tkids) });
        }
      }
    }
    return tables.sort((a, b) =>
      (a.schema || "").localeCompare(b.schema || "") || a.table.localeCompare(b.table));
  }

  // ---------------------------------------------------------------------------
  // Iceberg metadata resolution — DFS-by-name (no REST catalog / GUIDs).
  // ---------------------------------------------------------------------------
  async function resolveIceberg(ws, root) {
    const entries = await listPaths(ws, `${root}/metadata`, false);
    if (!entries.length)
      throw new Error(`No metadata/ under ${root} — is this an Iceberg table?`);
    const jsons = entries.filter(e => /\.metadata\.json$/i.test(basename(e.name)));
    if (!jsons.length) throw new Error(`No *.metadata.json under ${root}/metadata`);

    // Prefer the version-hint pointer; otherwise take the newest metadata.json.
    let current = null;
    const hint = entries.find(e => basename(e.name).toLowerCase() === "version-hint.text");
    if (hint) {
      try {
        const v = (await fetchText(dfsUrl(ws, hint.name))).trim();
        current = jsons.find(j => {
          const b = basename(j.name);
          return b === `v${v}.metadata.json` || b === `${v}.metadata.json` || new RegExp(`^0*${v}-`).test(b);
        });
      } catch (_) { /* fall back to newest */ }
    }
    if (!current) current = jsons.slice().sort((a, b) => a.mtime - b.mtime).pop();

    const meta = await fetchJson(dfsUrl(ws, current.name));
    const curId = String(meta["current-snapshot-id"]);
    const snap = (meta.snapshots || []).find(s => String(s["snapshot-id"]) === curId)
              || (meta.snapshots || []).slice().pop();
    if (!snap || !snap["manifest-list"])
      throw new Error("Iceberg metadata has no current snapshot / manifest-list");
    return {
      manifestList: snap["manifest-list"],
      metadataFile: basename(current.name),
      metadataUrl: dfsUrl(ws, current.name),
      // Fabric records absolute abfs:// URIs; tables written by other engines often use
      // paths relative to the table root. Only the latter can be handed to iceberg_scan.
      absolutePaths: /^abfss?:\/\//i.test(String(meta.location || "")),
    };
  }

  // ---------------------------------------------------------------------------
  // Manifest layer — read Avro manifest-list + manifests with DuckDB's read_avro.
  // Manifests are fetched to local buffers (WASM httpfs truncates larger avro files)
  // and each live data-file (status != 2 DELETED) yields a parquet path.
  // ---------------------------------------------------------------------------
  async function readAvroRows(ws, url, columnsSql) {
    const name = `meta_${++_seq}.avro`;
    await db.registerFileBuffer(name, await fetchAuthed(toHttps(ws, url)));
    try {
      const t = await conn.query(`SELECT ${columnsSql} FROM read_avro('${name}')`);
      return t.toArray().map(r => r.toJSON());
    } finally { try { await db.dropFile(name); } catch (_) {} }
  }

  async function readManifest(ws, url) {
    const name = `meta_${++_seq}.avro`;
    await db.registerFileBuffer(name, await fetchAuthed(toHttps(ws, url)));
    try {
      const t = await conn.query(
        `SELECT status, data_file.file_path AS fp FROM read_avro('${name}')`);
      return t.toArray().map(r => r.toJSON())
        .filter(r => Number(r.status) !== 2)   // drop DELETED entries
        .map(r => r.fp);
    } finally { try { await db.dropFile(name); } catch (_) {} }
  }

  async function listDataFiles(ws, manifestList) {
    const manifests = (await readAvroRows(ws, manifestList, "manifest_path")).map(r => r.manifest_path);
    const files = [];
    for (const m of manifests) files.push(...await readManifest(ws, m));
    return files;
  }

  // ---------------------------------------------------------------------------
  // Load a table -> read-only VIEW.
  // ---------------------------------------------------------------------------
  // Two strategies, best first. Everything is read over HTTP range requests — whole-file
  // downloads are not a tier. Waiting minutes for a table to transfer isn't a usable
  // product, so if range reads don't work the app says so rather than quietly grinding.
  //
  //   iceberg   iceberg_scan(<url>, allow_moved_paths = true). DuckDB's own Iceberg
  //             reader: applies merge-on-read DELETE files (the manifest walk below
  //             ignores them, i.e. returns rows that were deleted), prunes files by
  //             partition and column statistics, and handles schema evolution.
  //             allow_moved_paths is the key: Fabric records absolute abfss:// URIs
  //             inside the metadata, DuckDB-WASM has no abfss filesystem, and this
  //             option re-resolves every manifest and data file relative to the https://
  //             root we hand it instead. sw.js signs the reads.
  //   streamed  hand-rolled manifest walk, then registerFileURL(HTTP) per data file so
  //             DuckDB still range-reads them. No delete-file handling, no pruning; only
  //             needs read_avro. Used when the iceberg extension is unavailable or its
  //             scan errors — `info.fallbackReason` carries why.
  //
  // Idempotent: a table already loaded is returned from cache.
  // ---------------------------------------------------------------------------
  const labelFor = t => t.schema ? `${t.schema}.${t.table}` : t.table;

  async function describe(ident) {
    return (await conn.query(`DESCRIBE ${ident}`)).toArray().map(r => {
      const j = r.toJSON();
      return { name: j.column_name, type: j.column_type };
    });
  }

  async function createView(ident, regs) {
    await conn.query(
      `CREATE OR REPLACE VIEW ${ident} AS SELECT * FROM read_parquet([${regs.map(n => `'${n}'`).join(", ")}])`);
  }

  async function dropAll(regs) {
    for (const n of regs) { try { await db.dropFile(n); } catch (_) {} }
  }

  async function loadTable(lh, t) {
    const label = labelFor(t);
    if (loaded.has(label)) return loaded.get(label);
    if (t.kind === "delta")
      throw new Error(`${label} is a Delta table — this viewer supports Iceberg tables only (for now).`);

    const ws = lh.workspace;
    onStatus(`Resolving ${label}…`);
    const { manifestList, absolutePaths } = await resolveIceberg(ws, t.root);

    let ident;
    if (t.schema) {
      await conn.query(`CREATE SCHEMA IF NOT EXISTS "${t.schema}"`);
      ident = `"${t.schema}"."${t.table}"`;
    } else {
      ident = `"${t.table}"`;
    }

    let columns = null;
    let mode = null;
    let fileCount = null;
    let fallbackReason = null;

    // --- iceberg ---
    // Only attempted when the metadata uses paths relative to the table root. Measured
    // against a real Fabric table (DuckDB 1.5.2, iceberg extension):
    //
    //   iceberg_scan('<table root>', allow_moved_paths = true)
    //     -> Invalid Configuration Error: Could not create full path from Iceberg Path
    //        (https://onelake.dfs…/Tables/CH01/nation) and the relative path
    //        (abfs://…@onelake.dfs…/Tables/CH01/nation/ducklake-….parquet)
    //
    // allow_moved_paths only rebases paths it considers RELATIVE; it refuses an absolute
    // abfs:// URI outright, so it cannot bridge abfs -> https. Passing the metadata.json
    // instead is worse: the option treats its argument as a directory and appends
    // /metadata/snap-….avro to it (404). There is no third spelling. Hence the gate:
    // absolute-path tables go straight to the manifest walk rather than burning a query
    // on a failure we can predict.
    if (icebergExt && !absolutePaths) {
      const tableRoot = `${dfsBase(ws)}/${encPath(t.root)}`;
      onStatus(`Opening ${label} with the Iceberg reader…`);
      try {
        await conn.query(
          `CREATE OR REPLACE VIEW ${ident} AS ` +
          `SELECT * FROM iceberg_scan('${tableRoot}', allow_moved_paths = true)`);
        columns = await describe(ident);   // forces a real metadata + footer read
        mode = "iceberg";
      } catch (e) {
        fallbackReason = e.message;
        console.warn(`[engine] iceberg_scan('${tableRoot}') failed for ${label}:`, e.message);
        columns = null;
      }
    } else if (absolutePaths) {
      fallbackReason = "the table records absolute abfs:// paths, which iceberg_scan cannot resolve";
    } else {
      fallbackReason = "the iceberg extension did not load";
    }

    // --- streamed: hand-rolled manifest walk, range-read per data file ---
    if (!columns) {
      onStatus(`Reading manifests for ${label}…`);
      const paths = await listDataFiles(ws, manifestList);
      if (!paths.length) throw new Error(`${label}: current snapshot has no data files`);
      const urls = paths.map(p => toHttps(ws, p));
      fileCount = paths.length;

      const regs = [];
      onStatus(`Opening ${label} — ${urls.length} file(s)…`);
      try {
        for (const u of urls) {
          const reg = `data_${++_seq}.parquet`;
          await db.registerFileURL(reg, u, duckdb.DuckDBDataProtocol.HTTP, false);
          regs.push(reg);
        }
        await createView(ident, regs);
        columns = await describe(ident);   // forces a real footer read — this is the probe
        mode = "streamed";
      } catch (e) {
        await dropAll(regs);
        // Deliberately no whole-file download tier: on a big table that means minutes of
        // waiting and the whole thing in browser memory. Fail with the cause instead.
        throw new Error(
          `Could not read ${label} over HTTP range requests: ${e.message}. ` +
          `This usually means the service worker isn't controlling the page (reload once) ` +
          `or it has no OneLake token yet.`);
      }
    }

    const info = { label, ident, columns, mode, fileCount, fallbackReason };
    loaded.set(label, info);
    onStatus(describeLoad(info));
    if (fallbackReason) console.warn(`[engine] ${label} fell back to the manifest walk: ${fallbackReason}`);
    return info;
  }

  // One sentence about how the table was actually opened. The manifest walk ignores
  // merge-on-read DELETE files; Fabric's converted tables are copy-on-write so they have
  // none, but a table written by Spark might, hence the caveat rather than silence.
  function describeLoad({ label, mode, fileCount }) {
    if (mode === "iceberg") return `${label} — Iceberg reader, read on demand`;
    return `${label} — ${fileCount} file(s), read on demand (copy-on-write only)`;
  }

  // ---------------------------------------------------------------------------
  // Read-only SQL. One statement, must start with a read keyword.
  // ---------------------------------------------------------------------------
  const READ_START = /^\s*(with|select|describe|show|explain|summarize|pragma|values|from|table|pivot|unpivot)\b/i;

  function stripComments(sql) {
    return String(sql)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ")
      .trim()
      .replace(/;+\s*$/, "");
  }

  async function runSql(sql) {
    const clean = stripComments(sql);
    if (!clean) throw new Error("Empty query.");
    if (clean.includes(";"))
      throw new Error("Run one statement at a time (no ';').");
    if (!READ_START.test(clean))
      throw new Error("Read-only: only SELECT / WITH / DESCRIBE / SHOW / EXPLAIN / SUMMARIZE queries are allowed.");
    const res = await conn.query(clean);
    const fields = res.schema.fields.map(f => f.name);
    const rows = res.toArray().map(r => normalizeRow(r.toJSON(), fields));
    return { fields, rows, numRows: Number(res.numRows) };
  }

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------
  function normalizeRow(obj, fields) {
    const out = {};
    for (const f of fields) {
      let v = obj[f];
      if (typeof v === "bigint") v = Number(v);
      else if (v != null && typeof v === "object" && typeof v.toJSON === "function") v = v.toJSON();
      out[f] = v;
    }
    return out;
  }

  return { init, parseLakehouse, listTables, loadTable, runSql, describeLoad };
}
