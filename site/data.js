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
// Pinned, not @latest: this is a CDN import with no lockfile behind it, so an unpinned
// URL means every user's browser can pick up a new DuckDB the moment one is published —
// including a build without the 'excel' extension, or with different SQL behaviour. This
// version ships DuckDB v1.5.4 and has avro + excel; it is a dev tag by choice, since the
// stable line lags. Bump it deliberately and re-run the format probe when you do.
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/+esm";

const DFS_HOST = "onelake.dfs.fabric.microsoft.com";

export function createEngine(auth, { onStatus = () => {} } = {}) {
  let db = null, conn = null, worker = null;
  let _seq = 0;
  let canXlsx = false;        // set by init(); see the 'excel' preload there
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
    // Never throws: an optional extension that won't load costs one file format, which is
    // not a reason to refuse to start. LOAD alone succeeds when the wasm build already has
    // the extension; INSTALL+LOAD is the fetch-from-the-repo fallback.
    const tryLoadExt = async ext => {
      try { await conn.query(`LOAD ${ext};`); return true; }
      catch (_) {
        try { await conn.query(`INSTALL ${ext}; LOAD ${ext};`); return true; }
        catch (e) { console.warn(`[engine] ${ext} extension unavailable:`, e.message); return false; }
      }
    };
    // read_avro() (used to parse Iceberg manifests) comes from the 'avro' extension.
    // duckdb-wasm autoloads it on first use; preloading up front just makes the first
    // manifest read fast — the autoload on the first read_avro() call is the real mechanism.
    await tryLoadExt("avro");
    // read_xlsx() comes from 'excel'. Unlike avro this answer is remembered: the extension
    // is fetched over the network, so it can fail for reasons the pinned version doesn't
    // control, and offering an .xlsx that then fails to open is worse than not offering it.
    canXlsx = await tryLoadExt("excel");
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
    if (!r.ok) {
      const e = new Error(`HTTP ${r.status} for …${String(url).slice(-72)}`);
      e.status = r.status;          // callers retry on this (see resolveIcebergRetrying)
      throw e;
    }
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
      if (!r.ok) {
        const e = new Error(`list HTTP ${r.status} for ${strip(directory)}`);
        e.status = r.status;
        throw e;
      }
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
  // Catalog — workspaces and their data items, from the storage token alone.
  // ---------------------------------------------------------------------------
  // OneLake answers the ADLS Gen2 "List Filesystems" call at the account root, and each
  // filesystem is a workspace. That means the whole catalog comes from the same
  // storage.azure.com token the data reads use — no Fabric REST API, no extra Entra scope
  // and no second consent prompt.
  async function listWorkspaces() {
    const out = [];
    let cont = "";
    do {
      const u = new URL(`https://${DFS_HOST}/`);
      u.searchParams.set("resource", "account");
      if (cont) u.searchParams.set("continuation", cont);
      const r = await authedFetch(u.toString());
      if (!r.ok) throw new Error(`Could not list workspaces (HTTP ${r.status})`);
      const j = await r.json().catch(() => ({}));
      for (const f of (j.fileSystems || [])) out.push(f.name);
      cont = r.headers.get("x-ms-continuation") || "";
    } while (cont);
    return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }

  // Items that can hold OneLake tables. A workspace root is mostly notebooks, pipelines
  // and environments; only these have a Tables/ directory worth browsing.
  const TABLE_ITEMS = new Set(["Lakehouse", "Warehouse", "MirroredDatabase", "SQLDatabase"]);

  async function listItems(ws) {
    const entries = await listPaths(ws, "", false);
    const items = [];
    for (const e of entries) {
      if (!e.isDir) continue;
      const name = basename(e.name);
      const kind = name.includes(".") ? name.split(".").pop() : "";
      if (TABLE_ITEMS.has(kind)) items.push({ name, kind });
    }
    return items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  // ---------------------------------------------------------------------------
  // Files/ browsing — the unmanaged half of a lakehouse.
  // ---------------------------------------------------------------------------
  // Nothing Iceberg here: Files/ is just a directory tree, so it is listed one level at a
  // time (lazily, on expand) and a recognised data file is opened as a view the same way
  // table data files are — registerFileURL, then whichever reader the extension names.
  const FILE_READERS = {
    parquet: n => `read_parquet([${n}])`,
    parq:    n => `read_parquet([${n}])`,
    pq:      n => `read_parquet([${n}])`,
    csv:     n => `read_csv_auto(${n})`,
    tsv:     n => `read_csv_auto(${n}, delim='\\t')`,
    txt:     n => `read_csv_auto(${n})`,
    json:    n => `read_json_auto(${n})`,
    jsonl:   n => `read_json_auto(${n}, format='newline_delimited')`,
    ndjson:  n => `read_json_auto(${n}, format='newline_delimited')`,
    avro:    n => `read_avro(${n})`,
    xlsx:    n => `read_xlsx(${n})`,
  };

  // Plain text that isn't tabular — a dbt model, a schema.yml, a log — is still worth
  // opening, so read it one row per line instead of leaving it dead in the tree. The CSV
  // reader does that with splitting disabled: no delimiter that occurs in text, no quote
  // or escape character, so every byte of a line lands in the single declared column.
  const textLines = n =>
    `(SELECT rtrim(line, chr(13)) AS line FROM read_csv(${n}, ` +
    `columns={'line': 'VARCHAR'}, delim='\\x1F', quote='', escape='', ` +
    `header=false, auto_detect=false))`;
  const TEXT_EXTS = ["sql", "yml", "yaml", "md", "toml", "ini", "cfg", "conf",
                     "properties", "log", "sh", "py", "html", "xml", "css", "js"];
  for (const ext of TEXT_EXTS) FILE_READERS[ext] = textLines;
  const isTextExt = ext => TEXT_EXTS.includes(ext.replace(/\.(gz|zst)$/, ""));

  // Compressed text files need no reader of their own: DuckDB picks the codec off the file
  // NAME, and loadFile() registers them under a name that keeps both halves of the
  // extension (file_7.csv.gz), so the plain reader decompresses transparently.
  for (const base of ["csv", "tsv", "json", "jsonl", "ndjson", ...TEXT_EXTS])
    for (const codec of ["gz", "zst"])
      FILE_READERS[`${base}.${codec}`] = FILE_READERS[base];

  // The only formats with a footer and row groups, i.e. the only ones actually range-read.
  const PARQUET_EXTS = new Set(["parquet", "parq", "pq"]);

  // A codec suffix is part of the extension — "csv.gz", not "gz" — because it selects both
  // the reader and the decompression. Anything else (a .tar.gz) falls through to the
  // one-segment form and simply won't be in FILE_READERS.
  const COMPRESSED_EXT = /\.([A-Za-z0-9]+)\.(gz|zst)$/i;
  const fileExt = name => {
    const b = basename(name);
    const two = COMPRESSED_EXT.exec(b);
    if (two) return `${two[1].toLowerCase()}.${two[2].toLowerCase()}`;
    const m = /\.([A-Za-z0-9]+)$/.exec(b);
    return m ? m[1].toLowerCase() : "";
  };
  const isQueryable = name => {
    const ext = fileExt(name);
    if (!Object.prototype.hasOwnProperty.call(FILE_READERS, ext)) return false;
    return ext === "xlsx" ? canXlsx : true;
  };

  // One level of Files/ (or a subdirectory of it). `dir` is relative to Files/.
  async function listFiles({ workspace, item }, dir = "") {
    const base = `${item}/Files${dir ? "/" + strip(dir) : ""}`;
    const entries = await listPaths(workspace, base, false);
    return entries.map(e => ({
      name: basename(e.name),
      path: e.name,                       // workspace-relative, ready for dfsUrl()
      isDir: e.isDir,
      bytes: e.bytes,
      queryable: !e.isDir && isQueryable(e.name),
    })).sort((a, b) =>
      (b.isDir - a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  // Open one file under Files/ as a read-only view.
  //
  // Only parquet gets the lazy treatment — DuckDB range-reads its footer and row groups.
  // CSV/JSON have no such structure, avro is a linear container and xlsx is a zip whose
  // parts have to be inflated, so DuckDB pulls those whole however big they are; that is
  // inherent to the formats, not a shortcut taken here.
  async function loadFile(lh, file) {
    const label = file.name;
    if (loaded.has(label)) return loaded.get(label);
    const ext = fileExt(file.name);
    const reader = FILE_READERS[ext];
    if (ext === "xlsx" && !canXlsx)
      throw new Error(`${file.name}: this DuckDB-WASM build has no 'excel' extension, so .xlsx can't be read.`);
    if (!reader)
      throw new Error(`${file.name}: unsupported file type — parquet, csv/tsv/txt, json/jsonl/ndjson, ` +
                      `avro, xlsx and plain text (sql, yml, md, log, …) are readable; ` +
                      `text formats also read as .gz/.zst.`);

    const reg = `file_${++_seq}.${ext}`;
    await db.registerFileURL(reg, dfsUrl(lh.workspace, file.path), duckdb.DuckDBDataProtocol.HTTP, false);

    // Views are identified by the file's own name, so two files called data.parquet in
    // different folders don't collide.
    const view = file.path.replace(/^.*?\/Files\//, "").replace(/[^A-Za-z0-9_]/g, "_");
    const ident = `"${view}"`;
    try {
      await conn.query(`CREATE OR REPLACE VIEW ${ident} AS SELECT * FROM ${reader(sqlStr(reg))}`);
      const columns = await describe(ident);
      const info = { label, ident, columns, fileCount: 1, posDeletes: 0, eqDeletes: 0,
                     file: true, bytes: file.bytes, ext };
      loaded.set(label, info);
      onStatus(describeLoad(info));
      return info;
    } catch (e) {
      try { await db.dropFile(reg); } catch (_) {}
      throw new Error(`Could not read ${file.name}: ${e.message}`);
    }
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
  // Fabric generates a table's Iceberg metadata lazily, on access. The first request
  // triggers generation and loses the race — you get an HTTP 400 for a metadata.json that
  // the directory listing just told us exists — and a moment later the same table reads
  // fine. So retry the WHOLE resolution rather than refetching the same URL: the second
  // pass re-lists metadata/, which may by then expose a newer version-hint and a different
  // vN.metadata.json than the one that failed.
  const RESOLVE_BACKOFF_MS = [400, 1200, 3000];

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function resolveIcebergRetrying(ws, root, label) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await resolveIceberg(ws, root);
      } catch (e) {
        // 400/404 here means "not materialized yet", not "wrong". A missing metadata.json
        // in a directory that exists is the same story.
        const transient = e.status === 400 || e.status === 404 || /No \S*metadata\.json/.test(e.message);
        if (!transient || attempt >= RESOLVE_BACKOFF_MS.length) throw e;
        onStatus(`Waiting for Fabric to generate Iceberg metadata for ${label}… ` +
                 `(attempt ${attempt + 2}/${RESOLVE_BACKOFF_MS.length + 1})`);
        await sleep(RESOLVE_BACKOFF_MS[attempt]);
      }
    }
  }

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
    };
  }

  // ---------------------------------------------------------------------------
  // Manifest layer — read Avro manifest-list + manifests with DuckDB's read_avro.
  // Manifests are fetched to local buffers (WASM httpfs truncates larger avro files)
  // and each live entry (status != 2 DELETED) with content = 0 yields a parquet path.
  // ---------------------------------------------------------------------------
  async function readAvroRows(ws, url, columnsSql) {
    const name = `meta_${++_seq}.avro`;
    await db.registerFileBuffer(name, await fetchAuthed(toHttps(ws, url)));
    try {
      const t = await conn.query(`SELECT ${columnsSql} FROM read_avro('${name}')`);
      return t.toArray().map(r => r.toJSON());
    } finally { try { await db.dropFile(name); } catch (_) {} }
  }

  // Returns { dataFiles, deletes } for one manifest.
  //
  // `content` distinguishes what a manifest entry points at: 0 = data, 1 = position
  // deletes, 2 = equality deletes. Filtering on it is not cosmetic — a delete file is a
  // parquet whose schema is nothing like the table's (position deletes are file_path +
  // pos), so feeding its path to read_parquet() alongside the data files either fails
  // schema unification or yields junk rows. Format-version 1 manifests have no `content`
  // field at all and are data-only, hence the fallback query.
  async function readManifest(ws, url) {
    const name = `meta_${++_seq}.avro`;
    await db.registerFileBuffer(name, await fetchAuthed(toHttps(ws, url)));
    try {
      let rows;
      try {
        rows = (await conn.query(
          `SELECT status, data_file.content AS content, data_file.file_path AS fp
           FROM read_avro('${name}')`)).toArray().map(r => r.toJSON());
      } catch (_) {
        rows = (await conn.query(
          `SELECT status, 0 AS content, data_file.file_path AS fp
           FROM read_avro('${name}')`)).toArray().map(r => r.toJSON());
      }
      const live = rows.filter(r => Number(r.status) !== 2);   // drop DELETED entries
      // String() is defensive normalization: these paths become registerFileURL() keys that
      // have to compare equal to the SQL literals built from them, so don't let an Arrow
      // value type reach either side.
      const of = k => live.filter(r => Number(r.content || 0) === k).map(r => String(r.fp));
      return { dataFiles: of(0), posDeletes: of(1), eqDeletes: of(2) };
    } finally { try { await db.dropFile(name); } catch (_) {} }
  }

  async function listDataFiles(ws, manifestList) {
    const manifests = (await readAvroRows(ws, manifestList, "manifest_path")).map(r => r.manifest_path);
    const files = [], posDeletes = [], eqDeletes = [];
    for (const m of manifests) {
      const r = await readManifest(ws, m);
      files.push(...r.dataFiles);
      posDeletes.push(...r.posDeletes);
      eqDeletes.push(...r.eqDeletes);
    }
    return { files, posDeletes, eqDeletes };
  }

  // ---------------------------------------------------------------------------
  // Load a table -> read-only VIEW.
  // ---------------------------------------------------------------------------
  // One reader: walk the manifests, then let DuckDB range-read the parquet files. Nothing
  // is downloaded whole — waiting minutes for a table to transfer isn't a usable product,
  // so if range reads fail the app says so rather than quietly grinding.
  //
  // DuckDB's own `iceberg` extension was tried and rejected. It loads in WASM, and its
  // paths can be bridged by registering each abfs:// path as a file NAME aliased to the
  // https URL (`allow_moved_paths` cannot — it refuses absolute URIs). Measured in the
  // browser against a real Fabric table, iceberg_scan then returns the right rows... but
  // `SELECT count(*)` answers 0, because it trusts the manifest statistics and Fabric's
  // conversion writes record_count = 0. Silently wrong counts on the most common query in
  // this app is a worse trade than the pruning it would buy — pruning those same zeroed
  // statistics would not deliver anyway.
  //
  // The one thing the extension gave us for free, delete files, is handled here instead:
  // position deletes via an anti-join in createView().
  //
  // Idempotent: a table already loaded is returned from cache.
  // ---------------------------------------------------------------------------
  const labelFor = t => t.schema ? `${t.schema}.${t.table}` : t.table;

  const sqlStr = v => "'" + String(v).replace(/'/g, "''") + "'";

  async function describe(ident) {
    return (await conn.query(`DESCRIBE ${ident}`)).toArray().map(r => {
      const j = r.toJSON();
      return { name: j.column_name, type: j.column_type };
    });
  }

  // Data files are registered under generated `data_N.parquet` names, so read_parquet's
  // `filename` is that generated name — not the path an Iceberg delete file refers to.
  // `mapTable` bridges the two (reg -> original path).
  //
  // Registering them under their original abfs:// path instead would remove the need for
  // that mapping, and DuckDB-WASM's file registry does resolve such aliases — but only
  // sometimes: it works in isolation and fails inside this engine's real sequence, after
  // the Avro manifests have been read through registered buffers. Generated names have no
  // such problem, so the mapping table is the cheap price of a reader that always works.
  async function createView(ident, regs, delTable, mapTable) {
    const list = regs.map(sqlStr).join(", ");
    if (!delTable) {
      await conn.query(`CREATE OR REPLACE VIEW ${ident} AS SELECT * FROM read_parquet([${list}])`);
      return;
    }
    // EXCLUDE keeps the two bookkeeping columns out of the table's visible schema.
    await conn.query(
      `CREATE OR REPLACE VIEW ${ident} AS
       SELECT * EXCLUDE (filename, file_row_number)
       FROM read_parquet([${list}], filename = true, file_row_number = true) x
       WHERE NOT EXISTS (
         SELECT 1 FROM ${delTable} d JOIN ${mapTable} m ON m.orig = d.file_path
         WHERE m.reg = x.filename AND d.pos = x.file_row_number)`);
  }

  // reg name -> original manifest path, so the anti-join can match a delete file's
  // `file_path` against read_parquet's `filename`.
  async function createMap(pairs) {
    const name = `__map_${++_seq}`;
    const values = pairs.map(([reg, orig]) => `(${sqlStr(reg)}, ${sqlStr(orig)})`).join(", ");
    await conn.query(
      `CREATE OR REPLACE TABLE ${name} AS SELECT * FROM (VALUES ${values}) v(reg, orig)`);
    return name;
  }

  // Materialize the position-delete files (file_path, pos) into one small table.
  async function loadPositionDeletes(ws, paths) {
    const regs = [];
    for (const p of paths) {
      const reg = `del_${++_seq}.parquet`;
      await db.registerFileURL(reg, toHttps(ws, p), duckdb.DuckDBDataProtocol.HTTP, false);
      regs.push(reg);
    }
    const name = `__del_${++_seq}`;
    await conn.query(
      `CREATE OR REPLACE TABLE ${name} AS
       SELECT file_path, pos FROM read_parquet([${regs.map(sqlStr).join(", ")}])`);
    return name;
  }

  async function dropAll(regs) {
    for (const n of regs) { try { await db.dropFile(n); } catch (_) {} }
  }

  async function loadTable(lh, t) {
    const label = labelFor(t);
    if (loaded.has(label)) return loaded.get(label);
    if (t.kind === "delta")
      throw new Error(`${label} isn't queryable yet — OneLake hasn't published metadata for it.`);

    const ws = lh.workspace;
    onStatus(`Resolving ${label}…`);
    const { manifestList } = await resolveIcebergRetrying(ws, t.root, label);

    let ident;
    if (t.schema) {
      await conn.query(`CREATE SCHEMA IF NOT EXISTS "${t.schema}"`);
      ident = `"${t.schema}"."${t.table}"`;
    } else {
      ident = `"${t.table}"`;
    }

    onStatus(`Reading manifests for ${label}…`);
    const { files: paths, posDeletes, eqDeletes } = await listDataFiles(ws, manifestList);
    if (!paths.length) throw new Error(`${label}: current snapshot has no data files`);

    // Map each data file to a generated name pointing at its https URL, so DuckDB
    // range-reads it instead of us downloading it whole.
    const regs = [], pairs = [];
    let columns;
    onStatus(`Opening ${label} — ${paths.length} file(s)…`);
    try {
      for (const p of paths) {
        const reg = `data_${++_seq}.parquet`;
        await db.registerFileURL(reg, toHttps(ws, p), duckdb.DuckDBDataProtocol.HTTP, false);
        regs.push(reg);
        pairs.push([reg, p]);
      }
      const delTable = posDeletes.length ? await loadPositionDeletes(ws, posDeletes) : null;
      const mapTable = delTable ? await createMap(pairs) : null;
      await createView(ident, regs, delTable, mapTable);
      columns = await describe(ident);   // forces a real footer read — this is the probe
    } catch (e) {
      await dropAll(regs);
      // Deliberately no whole-file download tier: on a big table that means minutes of
      // waiting and the table in browser memory. Fail with the cause instead.
      throw new Error(
        `Could not read ${label} over HTTP range requests: ${e.message}. ` +
        `This usually means the service worker isn't controlling the page (reload once) ` +
        `or it has no OneLake token yet.`);
    }

    const info = { label, ident, columns, fileCount: paths.length,
                   posDeletes: posDeletes.length, eqDeletes: eqDeletes.length };

    loaded.set(label, info);
    onStatus(describeLoad(info));
    return info;
  }

  // One sentence about how the table was opened. Position deletes are applied silently —
  // that is just correctness, not news. Equality deletes are NOT applied, so those get a
  // warning; saying nothing would mean quietly returning rows the table no longer has.
  function describeLoad({ label, fileCount, posDeletes, eqDeletes, file, ext, bytes }) {
    if (file) {
      if (PARQUET_EXTS.has(ext)) return `${label} — read on demand`;
      if (isTextExt(ext)) return `${label} — read in full as text (${fmtBytes(bytes)}), one row per line`;
      return `${label} — ${ext.toUpperCase()} is read in full (${fmtBytes(bytes)}); no range reads for this format`;
    }
    let s = `${label} — ${fileCount} file(s), read on demand`;
    if (posDeletes) s += `, ${posDeletes} delete file(s) applied`;
    if (eqDeletes) s += `. WARNING: ${eqDeletes} equality-delete file(s) NOT applied — ` +
                        `deleted rows may still appear`;
    return s;
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
    const types = res.schema.fields.map(f => arrowTypeName(f.type));
    const rows = res.toArray().map(r => normalizeRow(r.toJSON(), fields));
    return { fields, types, rows, numRows: Number(res.numRows) };
  }

  // Results come back as Arrow, so the column types are Arrow's, not DuckDB's. Name them
  // the way DuckDB does — those are the names the user wrote the query against, and the
  // ones DESCRIBE would have shown.
  const ARROW_NAME = { 1: "NULL", 4: "BLOB", 5: "VARCHAR", 6: "BOOLEAN", 8: "DATE",
                       11: "INTERVAL", 13: "STRUCT", 14: "UNION", 15: "BLOB",
                       17: "MAP", 19: "BLOB", 20: "VARCHAR" };
  const INT_NAME = { 8: "TINYINT", 16: "SMALLINT", 32: "INTEGER", 64: "BIGINT", 128: "HUGEINT" };

  function arrowTypeName(t) {
    if (!t) return "";
    switch (t.typeId) {
      case 2: {   // Int — width and signedness live on the type
        const n = INT_NAME[t.bitWidth] || "INTEGER";
        return t.isSigned === false ? "U" + n : n;
      }
      case 3: return t.precision === 2 ? "DOUBLE" : "FLOAT";   // Precision: HALF/SINGLE/DOUBLE
      case 7: return `DECIMAL(${t.precision},${t.scale})`;
      case 9: return "TIME";
      case 10: return t.timezone ? "TIMESTAMPTZ" : "TIMESTAMP";
      case 12: case 16: return arrowTypeName(t.children && t.children[0] && t.children[0].type) + "[]";
      case 18: return "INTERVAL";
      default: return ARROW_NAME[t.typeId] || String(t).toUpperCase();
    }
  }

  // ---------------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------------
  function fmtBytes(n) {
    if (!(n > 0)) return "unknown size";
    if (n < 1e3) return `${n} B`;
    if (n < 1e6) return `${Math.round(n / 1e3)} KB`;
    if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
    return `${(n / 1e9).toFixed(2)} GB`;
  }

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

  return { init, parseLakehouse, listWorkspaces, listItems, listTables, loadTable,
           listFiles, loadFile, runSql, describeLoad, fmtBytes };
}
