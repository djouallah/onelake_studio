# OneLake Studio web app — architecture

A static web app — a folder of HTML and JavaScript in [`app/`](app/), with no backend — so it runs from
anywhere that serves files: GitHub Pages, a blob container, a company intranet, or `npx serve` on your
own machine. [**studio.projectscontrols.com**](https://studio.projectscontrols.com/) is just a demo
instance to try it on; host your own and it behaves identically.

This app shares no code with the VS Code extension in [`../vscode/`](../vscode/): nothing here is
imported from outside `web/`.

## How it reads a table

This is the reader in [`app/data.js`](app/data.js).

```
sign in       → OneLake storage token from your Entra identity
pick workspace→ DFS "list filesystems" at the account root = your workspaces
pick item     → DFS list of the workspace root = its lakehouses and warehouses
list tables   → OneLake's Iceberg REST catalog (same token, 3 requests for a whole item)
select table  → metadata document from the catalog, inline → statistics only, no data read
              → snapshot → manifest list (Avro) → parquet data-file paths
              → register each as a URL; DuckDB range-reads it (sw.js adds the token)
preview/query → read-only SQL in your browser → results + CSV export
```

**Nothing is downloaded whole.** Data files are registered as URLs, so DuckDB issues HTTP range requests
and pulls only the row groups and columns a query touches — OneLake answers `206 Partial Content`, and
`SELECT … LIMIT 100` is roughly constant-time however big the table is. The service worker ([`app/sw.js`](app/sw.js)) attaches your token to those reads, because DuckDB's file APIs can't
set headers. It also supplies the COOP/COEP headers that GitHub Pages can't, which is why the first load
reloads itself once.

**Repeat reads come from a local cache.** Browsers refuse to HTTP-cache `206` responses, so the service
worker caches range reads itself (Cache Storage, 512 MB cap, oldest evicted first) — but only
Iceberg data files and manifests under `Tables/`, which are immutable by design: a new snapshot writes
new files, so a cached one can never be stale. Listings, metadata pointers and anything under `Files/`
are always fetched fresh. Signing out deletes the cache along with the token, so neither the credential
nor the data it fetched outlives the session on a shared machine.

**Iceberg is the read path for everything, and the catalog is the only way in.** OneLake publishes
lakehouse and warehouse tables through a read-only Iceberg REST catalog that takes the same storage
token: three requests list a whole item, and opening a table gets its metadata document inline. Nothing
walks `Tables/` over DFS. That walk cost one directory listing per table, never worked for warehouses
(they have no `metadata/` directory at all), and the only thing it ever added — measured across every
item kind this app opens — was an empty leftover directory shown as a table that could not be opened.
Fabric generates that metadata lazily, so a first request can in principle lose the race to its own
conversion; resolution retries with a backoff sized to the documented 5s–2min window, says so on the
status line, and Stop works throughout. If the catalog refuses, the app shows what it said rather than
guessing.

## Semantic models

**A `.bim` under `Files/` opens as its semantic model**, in place of the editor, on three pages:

- **Model**: its tables as a star, dimensions in the middle and facts around them, with its
  relationships. Click a table for its columns, measures (with their DAX) and relationships.
- **SQL**: SQL in which `SELECT … FROM <model>` asks the model. `AGG(m)` is measure `m`, computed
  with DAX's semantics by [dax-sql](https://github.com/djouallah/dax-sql), which compiles the
  query to plain SQL:

  ```sql
  SELECT dim_region.Region, AGG("Registered MW") AS mw FROM nem GROUP BY ALL
  ```

  A model query can also be a subquery or CTE inside SQL of your own. Preview, Show plan and
  Download CSV.
- **Explore**: drag the model's columns onto Rows, Columns and Filters, and its measures onto
  Values, to get a pivot table or a chart.

The model is named after its file (`nem.bim` is `nem`), and the main editor can query it too, as
can `DESCRIBE nem`. A Direct Lake table is read from the lakehouse its model names, through the
same Iceberg catalog, whichever item is selected, and only when a query actually reads it. The
model comes from the file: export it once with Fabric's `getDefinition` (TMSL) — the website itself
never calls the Fabric API.

There is no guarantee that DAX compiled to SQL here gives the same results as Power BI.

## Limitations

- **A lakehouse with no schemas of its own lists its tables under `dbo`.** That's the synthetic
  namespace OneLake's catalog reports for those items, so generated SQL reads `FROM "dbo"."sales"`.
- **An item its catalog can't serve shows an error rather than a table list.** There is no DFS
  fallback; re-picking the item tries again.
- **Merge-on-read equality deletes are not applied.** They're detected and the status line warns; Fabric's
  own conversions are copy-on-write, so this doesn't affect them. Position deletes *are* applied (and
  verified — deletes that match no data file raise a warning instead of silently returning dead rows).
- **Column renames aren't merged.** Iceberg renames are metadata-only, and this reader matches parquet
  columns by name, not field ID — a renamed column shows up as two half-NULL columns, with a warning.
  Added columns are handled (`union_by_name`).
- **No Iceberg-level pruning** — Fabric's conversion writes zeroed manifest statistics, so there'd be
  nothing to prune on. Pruning is whatever parquet row-group stats and column projection give you.
- **Only parquet, DuckDB databases and zip directories are read lazily.** A database file under `Files/` (`.duckdb`,
  `.ddb`, `.db`, `.sqlite`) is opened by sniffing its header, never its extension. A DuckDB file is
  ATTACHed read-only and block-read on demand — tables queryable as `<name>.<schema>.<table>`. A SQLite file is read by sql.js and **copied** into DuckDB tables (`<name>.<table>`, capped at
  200 MB, BLOBs come through as NULL) — DuckDB's own sqlite extension cannot open any browser-supplied
  file in WASM. CSV, JSON, avro, xlsx and plain text have no block structure either, so DuckDB pulls those
  whole; the status line says so rather than claiming "read on demand". A `.zip` under `Files/` is listed
  via its central directory (a range read at the tail — the archive is not downloaded) and every readable
  entry becomes a view; entries decompress when queried.
- **Results are capped at 200,000 materialised rows** (the status line says when a query hits it) — the
  browser tab is the database, and an uncapped `SELECT *` on a 50M-row table would take it down.

## Layout

```
app/index.html   UI shell + sign-in gate      app/data.js      Iceberg engine on DuckDB-WASM
app/app.js       DOM wiring                   app/paths.js     pure logic (paths, SQL, cache keys)
app/auth.js      MSAL provider                app/sw.js        COOP/COEP + token injection
app/config.js    clientId + authority         app/semantic.js  .bim models -> dax-sql
app/analyze/     a .bim's view: Model, SQL, Explore
build.mjs        app/ -> dist/, vendoring every pinned package
test/            node --test suite (npm test) and the browser runners
```
