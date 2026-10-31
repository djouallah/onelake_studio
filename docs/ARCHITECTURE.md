# OneLake Studio: architecture

## What this is

OneLake Studio is a VS Code extension that makes a whole Microsoft Fabric tenant act as one database,
queried with SQL.

- **One catalog.** Every table and semantic model in the tenant has one unique name, so any statement
  can join across items, workspaces and kinds with no setup. [NAMING.md](NAMING.md) is the contract
  for those names. Everything else here depends on it.
- **SQL for everything.** The SQL box, the panel, Explore, the command line and the agent skill
  all send the same SQL over the same names. A Power BI semantic model is one more table: `AGG("measure")`
  computes its measure, compiled from its DAX by [dax-sql](https://github.com/djouallah/dax-sql).
- **Runs on your machine.** DuckDB in the extension host reads OneLake directly, with your own token.
- **Works offline.** This is a must, not a fallback. Everything you have read keeps working with no
  internet and no sign-in: browsing, SQL, a model's Explore and its Pivot.
- **Agents get the same access.** An agent asks through the command line, on the same sign-in, cache
  and engine as a person in the editor.

```sql
SELECT * FROM lakehouse.aemo.data.dbo.dim_duid;
SELECT dim_region.Region, AGG("Registered MW") FROM semanticmodel.aemo.nem GROUP BY ALL;
SELECT * FROM 'abfss://aemo@onelake.dfs.fabric.microsoft.com/data.Lakehouse/Files/x.parquet';
SHOW ALL TABLES;
```

## Rules every change keeps

| Rule | What it means | Where it is held |
| --- | --- | --- |
| **One name per object** | A table has five parts and a model has three. A file is its `abfss://` URL. | [NAMING.md](NAMING.md), [`src/names.js`](../src/names.js) |
| **SQL only** | A model is read with `AGG("measure")` in SQL. There is no DAX query. | [`app/semantic.js`](../app/semantic.js) |
| **Read only** | Nothing is written to Fabric or OneLake. The host refuses any statement that could write. The one exception is Export to Fabric, after an OK in VS Code. | `assertReadOnly` in [`src/sql.js`](../src/sql.js) |
| **Cache first** | Every answer from OneLake or Fabric is kept on this machine and served from there first. It is trusted until using it fails, then read again once. | [`src/onelake.js`](../src/onelake.js), [`src/store.js`](../src/store.js) |
| **Works offline** | A feature that reads data works from what this machine holds, with no network. What isn't held says so at once, never on a timeout. Only writing to Fabric needs a connection: Export to Fabric. The exported Fabric app is online by design, and this rule doesn't apply to it. | [`src/connectivity.js`](../src/connectivity.js), [`src/http.js`](../src/http.js), `cache_httpfs_set_offline` in [`src/engine-host.js`](../src/engine-host.js) |
| **The host does the work** | Sign-in, every OneLake read and the engine are in the host. The panel is a view: it holds no token and makes no network request. | [`src/host.js`](../src/host.js), [`src/panel.js`](../src/panel.js) |
| **A table's Pivot is a SQL starter** | It builds a first SQL. Its only actions are Edit SQL and Close. | [`app/app.js`](../app/app.js) |

## Out of scope

- DAX queries (`EVALUATE`).
- Writing to OneLake, DDL, or editing data in the grid.
- `CREATE` and `DROP SEMANTIC VIEW`: a model exists because Fabric has it, not because SQL made it.
- A TDS connection to the SQL endpoint.
- ER diagrams for lakehouse tables: they declare no keys.
- vscode.dev: the engine is a native library, so this needs desktop VS Code.

Results computed from a semantic model are not guaranteed to match Power BI.

## How the parts fit

```
 Query editor    Panel and Explore       Command line, agent skill
 (VS Code)       (webview, app/)         (bin/cli.mjs)
      |                 |                        |
      |          one message channel       local pipe or socket
      |            (src/host.js)            (src/bridge.js, src/agent.js)
      v                 v                        v
 +-------------------------------------------------------------+
 |  Extension host (src/)                                      |
 |  sign-in  |  cache-first OneLake  |  native DuckDB engine   |
 +-------------------------------------------------------------+
      |                                          |
      v                                          v
 Fabric REST API                              OneLake
 (semantic models, apps)                      (tables, files)
```

The model compiler, dax-sql, is pinned in [`src/vendored.js`](../src/vendored.js). The panel loads it,
and the host loads the same code for the command line. To change the syntax, change dax-sql and move
the pin: the extension carries no copy of its own.

## What happens when a statement runs

The SQL box, the panel and the command line follow these steps. Explore compiles its own view
and joins at step 3.

1. **Open the models it names.** `unopenedModels` finds each `semanticmodel.<ws>.<model>` not open yet.
   The host opens it from its local copy, reading it from Fabric the first time.
2. **Compile.** `semantic.statement` has dax-sql rewrite a model query as plain SQL over five-part table
   names. A statement that names no model passes through unchanged.
3. **Check.** `assertReadOnly` in the host refuses more than one statement, and anything that could
   write.
4. **Prepare.** `withTables` in [`src/engine-host.js`](../src/engine-host.js) does three things:
   - A statement that reads the catalog (`SHOW ALL TABLES`, `information_schema`) gets the catalog
     synced from the cache first.
   - `withTables` makes a view for each five-part name: `tableRefs` finds the names,
     `resolve` ([`src/sqltables.js`](../src/sqltables.js)) looks them up in the cached listings, and the
     view is `iceberg_scan` on the table's metadata file.
   - `catalogStatement` rewrites `SHOW` statements so they report whole paths.
5. **Run.** The statement runs on its own connection, so Stop interrupts exactly that query. A result
   past `maxResultRows` (200,000 by default) is counted rather than carried into the panel.

## Sign-in

No app registration is needed. VS Code's Microsoft account provider is a first-party application, so
`getSession` returns the OneLake token directly. The Fabric API needs a second token, in its own
audience, which VS Code asks for only when *Semantic models* is first expanded.

The token lives only in the extension host, in a DuckDB storage secret. When VS Code hands back a new
one, the secret is reissued.

**Sign Out** is out of OneLake Studio, not out of VS Code: an extension cannot remove an account, so it
stops asking for it until you sign in again. To remove the account too, use VS Code's Accounts menu.
The decision outlives the window: the next VS Code start asks for no session, sends nothing to OneLake, and
prompts for nothing, until **Sign in to OneLake** or **Switch Microsoft Account** is chosen.

**The title says where this window reads from** ([`src/title.js`](../src/title.js)): the sidebar's header and
the panel's tab read OneLake Studio and then `offline` or the tenant in use. The tenant is the
`onelakeStudio.tenantId` setting when it is set, since a guest's own domain would name the wrong tenant, and
otherwise the account's domain. Group, Refresh and Open are in the view's "..." menu so it fits.

## Offline

Offline is a requirement for every feature of the extension that reads data, so a new one has to work here
too. The exported Fabric app is online by design.

Nothing turns this on. The extension is offline when there is no internet or no session, says which in
the status bar, and comes back by itself ([`src/connectivity.js`](../src/connectivity.js)).

- **Detecting it:** a request that gets no answer at all starts a probe of OneLake, and offline means the
  probe got none either. Any HTTP status is an answer, so a slow connection counts as online. Offline, the
  probe repeats every 30 seconds.
- **No request is sent.** `authedFetch` refuses first ([`src/http.js`](../src/http.js)), so nothing waits
  on a timeout. Export to Fabric is refused too.
- **What is kept is the answer,** however old ([`src/onelake.js`](../src/onelake.js)), with no background
  refresh or prefetch. Anything not held says so at once.
- **No session:** the tree and the panel open on the cache of the last account signed in on this machine,
  in the tenant the setting names, with no prompt. Another account signing in gets its own cache.

| Works offline, if cached | Needs OneLake |
| --- | --- |
| The tree, `SHOW ALL TABLES`, `information_schema`, completion, Go To | A column or a file never read |
| A table's Stats and History, and first rows already read | A wildcard over `abfss://` files |
| Semantic models: opening them, Explore's Model page, `SHOW SEMANTIC …` | A table whose metadata was never read |
| Table rows, a model's queries and its Pivot, for what was read | Export to Fabric |
| `Files/` objects read before | |

**How rows are read offline:** `cache_httpfs` keeps a file's bytes on disk, but opening a file asks OneLake
for its size and version first. So what an open answers is kept too, as one more cache entry for the file,
and offline (`cache_httpfs_set_offline`) an open builds its handle from that with no request. A block it
holds reads as usual. A block it doesn't is an error, and the engine says that part isn't cached. Bytes from
before this need one open online to be readable offline, and aren't downloaded again.

With the disk cache off, there is nothing to read, and a statement that reads OneLake is refused at once.

**Losing the internet during a read:** the read fails on DuckDB's own timeout, the engine checks the
internet once, and if it has gone the statement runs again from what is kept.

## The engine

The engine is **DuckDB 2.0 running natively in the extension host**
([`src/engine-host.js`](../src/engine-host.js)), not a WebAssembly build in the page.

- **When it starts:** once the explorer is visible or a query is open, if you are signed in. It boots
  in the background and lists the cached catalog, so a first statement does not wait for either. That
  statement still waits for the panel, the first time it opens. A window that does neither starts no
  engine.
- **What a statement waits for:** the panel defines every kept semantic model when it opens, which can
  ask Fabric for an item's name. Only a statement that can name a model waits for that: one with
  `semantic` in it.
- **Catalogs:** one attached `:memory:` catalog per kind (`lakehouse`, `warehouse`, `sqldatabase`,
  `mirroreddatabase`), and one for `semanticmodel`. The workspace, item and schema are nested schemas.
- **Reading OneLake:** through DuckDB's `iceberg` and `azure` extensions. A table is read with
  `iceberg_scan` on the metadata file the host's cache holds, so the catalog is never asked at query
  time. DuckDB does the Iceberg work itself: snapshots, manifest filtering, position and equality
  deletes, schema evolution.
- **Reading files:** `Files/` objects are read as `abfss://` URLs.
- **Lockdown:** file access is limited to the temp directory, `https://`, `abfss://` and `zip://` over a
  remote archive.
- **What the page may run:** one statement, a read, or the page's own views, schemas and `READ_ONLY`
  attaches. Never `COPY`, `INSERT`, `EXPORT` or anything else that writes.
- **What the page reaches:** the host, through one message channel, only by `query`, `stream`, `cancel`,
  `info` and the host's OneLake reads.

## The shared engine

Experimental, behind `onelakeStudio.sharedEngine`. DuckDB runs in a process of its own
([`src/engine-server.js`](../src/engine-server.js)), and every tab of every window is a client of it
over DuckDB's Quack protocol ([`src/engine-client.js`](../src/engine-client.js)).

- **One per account and build.** The first window that needs it starts it. A window that leaves cancels
  its statements, and with no window left the server waits a minute, so a reload finds it warm, then exits.
- **What is shared:** one memory budget, and the blocks read, in memory over the disk cache.
- **Several tabs:** each runs its own statements, and its Stop reaches only those. Whatever the tree opens
  gets a new tab, and so does **New Query**. A tab's `Files/` views carry a tag, so tabs can't read
  each other's.
- **The session token:** a new random one per server, kept in VS Code's secret storage, and reaching the
  server over its stdin. Without it the port on `127.0.0.1` runs nothing. In the client's DuckDB it is a
  named secret, since an `ATTACH`'s `TOKEN` option shows in `duckdb_databases()`.
- **What stays in the window:** the read-only guard, the sign-in, and naming and resolving tables. A
  window sends the server its OneLake token as the engine's secret.
- **How a statement goes:** `quack_query()`, which gives each statement a session of its own. One attach
  runs one statement at a time. Stop finds the statement by a tag in a comment and uses `quack_cancel`,
  since `interrupt()` doesn't reach the server.

- **What is remembered:** the store's entries (listings, table metadata, first rows) are a table in a state
  file, one per account, in a second DuckDB in the server on a Quack port of its own, so a page's SQL
  can't reach it ([`src/statestore.js`](../src/statestore.js)). The tree therefore waits for the server.
  The JSON files are imported once and left as they were.

Not done: a `Files/` object's bytes, saved queries, models and semantic-model pointers are still files, and a
server that dies closes its tabs.

## The cache

| What | Where it is kept | When it is read again |
| --- | --- | --- |
| Listings (workspaces, items, tables, `Files/`, semantic models), table metadata, first rows | On disk, [`src/onelake.js`](../src/onelake.js) | Served at once, refreshed in the background past its window |
| The name behind a Direct Lake model's item GUIDs | On disk, [`src/onelake.js`](../src/onelake.js) | Only when using it fails |
| The bytes of a `Files/` object the host reads (an image, a `.bim`, a SQLite copy, a saved file) | Under the etag its cached listing gave | Only when the file was rewritten |
| What DuckDB reads: table data and `Files/` objects | DuckDB's disk cache (`cache_httpfs`) | Only when the file was rewritten: a kept copy is checked against the file's version tag and modification time |
| That a table's rows were read, per snapshot | On disk, [`src/onelake.js`](../src/onelake.js) | Never: a new snapshot is a new entry |
| A semantic model's definition | `~/OneLakeStudio/semantic-models/<workspace>/<model>.yaml` | On **Download Again** |

- **A kept answer is trusted until using it fails.** Then it is read again once, and the work tried again
  only if the answer changed. Otherwise the first error stands, and so it does offline
  (`revalidate` in [`src/store.js`](../src/store.js)). A window's age only ever starts a refresh in the
  background.
  - **A name not in a kept listing:** the listing is read again before the name is called missing.
  - **A lakehouse renamed under a model:** the name its GUIDs gave no longer resolves, so Fabric is asked
    again. A compiled query goes on working, and the next one uses the new name.
  - **A table's read fails** (DuckDB's `IO Error`): the table's listing and metadata are read again. A
    statement's own mistake asks OneLake nothing.
  - **A model's local copy** is not covered: it changes only on **Download Again**.
- **Per Microsoft account:** switching accounts never serves one account's data to another.
- **Survives a sign-out:** signing back in finds it warm. Only **Clear Cached OneLake Data** deletes it.
- **The catalog is cached too:** `SHOW ALL TABLES` and `information_schema` list what the tree has seen
  with no request to OneLake.
- **The catalog is kept in one file** ([`src/catalogsnapshot.js`](../src/catalogsnapshot.js)): listing it walks a
  file per table, and on a machine that scans what it opens the first open of each is slow. A first listing
  answers from the kept list and walks behind the caller.
- **A patched build:** the vsix carries a `cache_httpfs` with a Windows fix not yet released upstream
  (without it, nothing is cached on disk on Windows) and the offline read above. DuckDB loads it as an
  unsigned extension. A build without it fails, rather than ship with no disk cache.

## The explorer

The tree ([`src/tree.js`](../src/tree.js)) lists workspaces, then lakehouses, warehouses, SQL and
mirrored databases, their tables and files, semantic models and apps. Workspaces can be pinned, and
the tree can group by type.

**A table's icon** says whether it is cached, as a model's does: a cloud until a statement has read its
rows at its current snapshot, a check after (`cached.rows` in [`src/onelake.js`](../src/onelake.js)). What is
kept is the part of each file that was read, so a check doesn't promise every column. A new snapshot goes
back to the cloud. A table nothing was ever written to has a check, since it reads no file.

**Clicking a table** shows it in the panel: Data, Stats, History and Pivot.
- **Stats and History** come from the table's metadata, with no data read. A table written as Delta
  also has its own log read for what Iceberg has no word for ([`src/deltalog.js`](../src/deltalog.js)).
- **Time travel:** on an Iceberg table, History's Query puts a snapshot's rows in the SQL box, and
  each snapshot says how its row count and columns differ from the table now.
- **Pivot** is the SQL starter described under the rules above.

**Clicking a file** opens it: Parquet, CSV, JSON, Excel, DuckDB, SQLite, and files inside a zip.
- **A database file** is recognised by its header, never its extension. A DuckDB file is attached
  read-only and block-read on demand. A SQLite file is copied by the host into the engine's temp
  directory and attached read-only, capped at 200 MB.
- **CSV, JSON, avro, xlsx and plain text** have no block structure, so DuckDB pulls them whole.
- **A `.zip`** is listed through its central directory, with a range read at the tail, so the archive
  is not downloaded. Every readable entry becomes a view, and it decompresses when queried.
- **A `.bim`, or an Ossie `.yaml`** opens in the model view (see [Semantic models](#semantic-models)).

**Each workspace's Apps node** lists its Fabric apps (`AppBackend` items), however they were made.
- Each shows its URL and when it was last deployed (`GET …/appBackends/<id>/__private/deploy/status`).
- Each shows whether its site is **public** or **protected**, from its runtime settings
  (`GET …/__private/projectRuntimeSettings`, `staticHosting.anonymousAccess`; nothing else from that
  answer is kept). Public means anyone with the URL loads the site without signing in, shown as an
  orange open lock. Protected means Fabric asks for a sign-in and permission on the app first, shown
  as a lock.
- That is two reads per app when *Apps* is expanded, then cached. A button copies the URL. Nothing is
  opened or changed.

## The SQL box and results

SQL is written in a box in the panel ([`app/app.js`](../app/app.js)), not in VS Code's editor. **A query
never opens a `.sql` file**, because opening one starts every SQL extension installed, on the extension
host every extension shares, and a click on Run then waits behind them with nothing on screen. A `.sql`
file you open yourself is left to those extensions. The box reacts by itself: a click says *Running…* at
once and counts, though the answer still comes through the host.

- **The box holds one query.** Its text comes back with the next panel and the next window.
- **New Query** (the **+** on *Queries*) puts `SHOW ALL TABLES` in the box. A saved query opens there too.
  **Save Query** (Ctrl+S) writes it back, or keeps a new one under *Queries* as `Query N`.
- **Run** (Ctrl+Enter) runs the statement under the cursor, or the selection. **Plan** shows where it
  spends its time.
- **Errors:** the status line says what DuckDB says, and the cursor goes where it says it is.
- **Variables:** `SET VARIABLE year = 2024` keeps a value for the session and `getvariable('year')`
  reads it. **Clear Query Variables** forgets them.
- **From the tree:** a table's right-click has Select Top Rows, Copy SQL Name and Copy Column List.
  **Go to a Table, Column or Measure** (Ctrl+Alt+O) searches everything the cache holds, and puts a name
  in the box.

Results show in the panel:

- **Grid** ([`app/grid.js`](../app/grid.js)): every row scrolls, cells select and copy, and a filter box
  keeps the rows that hold its text.
- **Chart** ([`app/chart.js`](../app/chart.js)): draws the rows on screen. Nothing is queried again.
- **Profile:** each column of the result, over every row the query returns (`SUMMARIZE`).
- **Export…** writes every row to a CSV, Parquet or Excel file. The engine writes it, through VS Code's
  save dialog. SQL typed by hand still cannot `COPY`.

## Semantic models

**A Power BI semantic model is a Fabric item.** It is not in OneLake: its list and its definition come
from the Fabric REST API ([`src/fabric.js`](../src/fabric.js)). In SQL it is a **semantic view**, named
`semanticmodel.<workspace>.<model>` and listed by `SHOW ALL TABLES` with the rest of the catalog. Every
workspace has one model of a name.

**Opening one**
- **From the tree:** a click reads its TMSL definition (the REST API's `getDefinition`) and keeps it as
  Apache Ossie (dax-sql's `tmslToOssie`) at `~/OneLakeStudio/semantic-models/<workspace>/<model>.yaml`,
  then opens that copy.
- **From a query:** a statement that names a model not open yet opens it first, in the same way.
- **Nothing is written to OneLake**, so someone who may only read the workspace can open and query it.
- **Only Direct Lake over OneLake.** Any other model is refused, and nothing is kept.
- **The local copy is the cache.** Later clicks open it without asking Fabric, and the tree marks the
  model with a check. The command line reads and writes the same copies. **Download Again** reads
  Fabric again and replaces the copy, after asking.
- **Every model opened is remembered** as a pointer (name, file path, when) in one file per Microsoft
  account ([`src/semviews.js`](../src/semviews.js)), so it survives a restart.
- **Permissions:** reading a definition needs Contributor or above on the workspace, or write on the
  model.

**Reading one.** A Direct Lake table is read from the lakehouse its model names, whichever item is
selected, and only when a query actually reads it. A model's query can be a subquery or CTE inside
SQL of your own.

```sql
SELECT dim_region.Region, AGG("Registered MW") AS mw FROM semanticmodel.aemo.nem GROUP BY ALL;
```

**Describing one.** These statements are dax-sql's (`createViews()`). Only those that read are taken.

```sql
SHOW SEMANTIC VIEWS;
SHOW SEMANTIC DIMENSIONS IN semanticmodel.ws.sales [FOR METRIC m];
SHOW SEMANTIC METRICS IN semanticmodel.ws.sales;
DESCRIBE semanticmodel.ws.sales;
SELECT * FROM (SHOW SEMANTIC METRICS IN semanticmodel.ws.sales) WHERE ...;
```

**A model file is a file.** A `.bim` under `Files/`, or an [Apache Ossie](https://github.com/apache/ossie)
`.yaml` or `.yml` whose top level has `version:` and `datasets:`, opens in the model view in place of
the editor. dax-sql's `formats/ossie.js` turns Ossie into the `.bim` it stands for, and from there the
two are one. These files can be stored anywhere and have no model name. A model created from one, for
Fabric or only for a Fabric app, must be named `semanticmodel.<workspace>.<model>`, and it overwrites
whatever we have under that name. See [NAMING.md](NAMING.md#files), whose known gaps say what the code does
today.

## Explore

A semantic model opens as **Explore** ([`app/explore/`](../app/explore/)), on three pages:

- **Model:** its tables as a star, dimensions in the middle and facts around them, with its
  relationships. Click a table for its columns, measures (with their DAX) and relationships.
- **Pivot:** drag columns onto Rows, Columns and Filters and measures onto Values, drawn as a pivot or
  a chart.
  - A column dropped on Values is summarised, as in Power BI: a number is summed and anything else
    counted, and its chip switches to average, min, max, count or distinct count.
  - Totals are off until you tick them, and a view cut at 5,000 rows leaves them out.
  - Every view is one `SELECT … FROM <model>` in dax-sql's SQL (`modelSql`): columns, `AGG("measure")`,
    summarised columns and `ROLLUP` totals.
  - **Show SQL** swaps the pivot for that SQL in a box you can edit and run.
  - **Show plan** profiles it (`profile.js`: DuckDB's `EXPLAIN ANALYZE` as totals, a timeline and the
    costly operators) next to its plan tree.
- **Logs:** what the session ran, with timings (`logs.js`, `perflog.js`).

`view.js` is host-neutral: the host passes in the compiler, how to run SQL, and where ECharts comes
from. **The panel** runs it on the native engine in the extension host. **The Fabric app** runs the
same files on DuckDB-WASM.

## Export to Fabric

The one write. Explore's **Export to Fabric** button, or the command line's `export`, publishes that
model's Explore and Logs, nothing else, as a Fabric app (item type `AppBackend`, named
`<model>-explore`). VS Code and the extension are all it needs: no CLI, no Node, no GitHub.

**What it writes**
- **The app**, in Fabric.
- **The model's file**, into the `Files/` of its lakehouse, when it was opened from its local copy:
  `<lakehouse>/Files/semantic_model/<model>.yaml` ([`src/onelakewrite.js`](../src/onelakewrite.js)). The
  app reads the model there. A different file of that name is replaced only when you say so.
- **A local copy of the app:** to the folder approved last time for that model, or else `<the folder VS
  Code has open>/<model>-explore/`, or else one you pick.

**What it needs**
- **It names exactly one lakehouse** in its Direct Lake expression. Without that, the button is not
  shown.
- **Every table names its source as `schema.table`**, with a table name of letters, digits and `_`.
- **The workspace allows OneLake user-delegated SAS tokens.**
- **Write access to the lakehouse.**

**How it behaves**
- **It asks first.** Before anything is written, it shows where and waits for *Export* or *Choose
  Another Folder…*. All the questions come before anything is written, locally or in Fabric.
- **Protected:** the site loads only for people who may open the app item.
- **The model is read in place:** the app never holds a copy. Its function reads the model file from
  the lakehouse at run time (its `MODEL_URL` secret), so the app shows the model as it is there.
- **No silent takeover:** a re-export updates the item the last export created (its id is kept in the
  local copy). If an app of that name exists and no export created it, the export stops and asks.
- **Local edits are never overwritten unasked.** The local copy's marker keeps a hash of each of its
  files as last published (`site/`, `rayfin/`, `AGENTS.md`, `.gitignore`, without `node_modules` or
  `dist/`). If any changed, the export asks: *Overwrite Local Changes*, *Publish Folder As Is*, or
  cancel.
- **A newer deploy is never overwritten unasked.** The marker keeps the app's last deploy time, by
  Fabric's clock. If the app was deployed again since, the export asks.
- **A folder the export did not write** is refused.

**The template** ([`fabric_app/`](../fabric_app/))
- **`site/`:** the page, black always. Its data source (`storage/`) signs in with Rayfin's Fabric SSO,
  takes the model and the tables' locations from the app's function with a read-only SAS, and downloads
  the tables' files into the browser, where DuckDB-WASM 1.5 (from jsDelivr) reads them as `v_<table>`
  views.
- **`rayfin/`:** `rayfin.yml` and the function (`openCatalog`).

[`src/exportapp.js`](../src/exportapp.js) writes the local copy from `fabric_app/`, Studio's
`app/explore/` and dax-sql. Its `dist/` is `site/` stamped with the build, plus `rayfin.config.json`,
zipped in-process.

**Publishing** ([`src/fabricapp.js`](../src/fabricapp.js)) is the REST sequence that `rayfin up` runs,
in the same order, with the user's Fabric-audience token:

1. Find the item, or create it.
2. Wait for its backend, then fetch the publishable key.
3. Apply the runtime settings.
4. Set the `CATALOG_URL` and `MODEL_URL` secrets.
5. Upload the site.
6. Deploy the function and poll it until it is done.
7. Add the hosting URL to the sign-in redirects.

The function's deploy package (an esbuild bundle plus its metadata) is built once, at package time, by
[`scripts/function-bundle.mjs`](../scripts/function-bundle.mjs) with Rayfin's own packager, from
`fabric_app/rayfin`. It ships in the vsix under `fabric-function/`.

## The command line and the agent skill

**[`bin/cli.mjs`](../bin/cli.mjs) is a doorbell.** It hands its arguments to the running extension over a
local pipe or socket ([`src/bridge.js`](../src/bridge.js)). The extension answers
([`src/agent.js`](../src/agent.js)) with its own sign-in, cache, engine and compiler, so VS Code must be
open and signed in. `--help` and a wrong call do not need it.

**The skill** is [`claude-skill/SKILL.md`](../claude-skill/SKILL.md). **Install Agent Skill** writes it to
`~/.claude/skills/onelake/`, where Claude Code and GitHub Copilot in VS Code (agent mode) look for
personal skills, and it follows the extension through updates.

`node bin/cli.mjs --help` is the full reference for commands and options. An agent should branch on:

| Exit code | Meaning |
| --- | --- |
| 0 | Answered. With `--json`, `complete` and `truncated` say how much. |
| 1 | Failed. |
| 2 | Wrong call. |
| 3 | VS Code is not open, or not signed in. |
| 4 | Not cached. `--fresh` asks OneLake or Fabric now, unless offline, when it fails the same way. |
| 5 | You declined an export. |
| 6 | Timed out. |

- **Output:** the answer alone goes to stdout and notes go to stderr.
- **`--json`** prints `{ ok, columns, rows, total, truncated, complete, cachedAt, notes }`, or
  `{ ok: false, error: { code, message, retry }, notes }`.
- **`sql -`** reads SQL from stdin. Prefer it for anything with quotes in it: `AGG("Total Sales")` does
  not survive every shell.
- **`--show-sql`** prints the SQL a model query compiles to.
- **`export`** is the one write: the same code path as Explore's button, with the same questions asked
  in VS Code.

## Commands

| Command | What it does |
| --- | --- |
| **Open OneLake Studio** | Opens the panel, signing in if needed. |
| **Sign in to OneLake** | Signs in and fills the explorer, without opening the panel. |
| **Sign in to the Fabric API** | Asks for the second token, for semantic models and apps. |
| **Switch Microsoft Account** | Asks which account to use and reopens the panel, so the previous account's tables do not survive the switch. |
| **Sign Out** | Signs out of OneLake Studio and closes the panel and the engine. What is cached stays on show. In the explorer's "..." menu. |
| **Settings** | Opens VS Code's Settings page, filtered to this extension. In the explorer's "..." menu. |
| **Refresh** | Re-reads a workspace, item or folder from OneLake in the foreground. |
| **Group by Type** / **Group by Workspace** | A toggle in the explorer's "..." menu. Remembered. |
| **Pin to Favorites** / **Unpin from Favorites** | Moves a workspace in or out of the tree's favorites group. |
| **Show Read Log** | Every OneLake request the extension made, with sizes and timings. |
| **Clear Cached OneLake Data** | Empties the on-disk cache and reports what it freed. In the explorer's "..." menu. |
| **Install Agent Skill (Claude Code, GitHub Copilot)** | Installs the skill above. |
| **New Query**, **Open Query**, **Rename Query…**, **Delete Query**, **Show Queries Folder** | Saved queries, under *Queries* in the tree. |
| **OneLake Run** (Ctrl+Enter), **OneLake Plan**, **OneLake Save Query** (Ctrl+S) | In a query's editor. |
| **Go to a Table, Column or Measure…** (Ctrl+Alt+O) | Searches everything the cache holds. |
| **Clear Query Variables** | Forgets values from `SET VARIABLE`. |
| **Select Top Rows**, **Copy SQL Name**, **Copy Column List** | A table's right-click. |
| **Download Again (from Fabric)** | Replaces a semantic model's local copy. |
| **Copy App URL** | An app's button. |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `onelakeStudio.tenantId` | empty | Directory (tenant) GUID to sign in against. Empty is your home tenant. Set it to reach a tenant you are a guest in. |
| `onelakeStudio.catalogTtlMinutes` | 5 | How old a listing may be before it is refreshed. The last known answer is always served from disk first. |
| `onelakeStudio.tableMetadataTtlHours` | 24 | How old a table's Iceberg metadata may be before it is refreshed. **Refresh** on its lakehouse re-reads it at once. |
| `onelakeStudio.prefetchMetadata` | on | Reads every table's metadata in the background once a lakehouse's Tables node is opened, so the first click is a disk read. |
| `onelakeStudio.diskCacheMaxGB` | 64 | How much of what DuckDB reads from OneLake, tables and `Files/`, is kept on disk, per account. `0` turns the disk cache off. |
| `onelakeStudio.cacheDirectory` | empty | Where the disk cache is kept, as a full path. Empty is VS Code's storage for this extension. A new folder starts empty. |
| `onelakeStudio.metadataCacheMaxMB` | 256 | How much of the listings, table metadata and first rows is kept on disk, per account. |
| `onelakeStudio.engineMemoryLimit` | empty | Most memory DuckDB may use, e.g. `4GB`. Empty is a quarter of the machine's RAM. |
| `onelakeStudio.engineThreads` | 0 | How many threads DuckDB may use. `0` is every core. |
| `onelakeStudio.engineSpillMaxGB` | 0 | How much a query bigger than memory may spill to the temp folder. `0` is DuckDB's default. |
| `onelakeStudio.sharedEngine` | off | Experimental: one engine in a process of its own for every tab and window of an account, and several tabs. See [The shared engine](#the-shared-engine). |
| `onelakeStudio.selectTopRows` | 1000 | How many rows **Select Top Rows** asks for. |
| `onelakeStudio.maxResultRows` | 200,000 | The most rows of one result the panel and the command line keep, from 1,000 to 1,000,000. Past it, rows are only counted. |
| `onelakeStudio.tableOpensOn` | `stats` | What clicking a table shows first: `stats` or `data`. |
| `onelakeStudio.gridThousandsSeparator` | off | Shows numbers in the grid with thousands separators. A copy still gets the raw value. |

The engine locks its configuration after it boots. Disk cache size, cache folder, memory, threads,
spill limit and the result row limit therefore apply when it restarts, which closes the panel. The rest
apply at once.

## Limitations

- **A lakehouse with no schemas of its own lists its tables under `dbo`**, the namespace OneLake's catalog
  reports for those items.
- **An item its catalog cannot serve shows an error rather than a table list.** There is no DFS fallback.
  Re-picking the item tries again.
- **A result past `maxResultRows` is counted rather than carried into the panel.**
- **Requires desktop VS Code 1.90+** on x64 or arm64 Windows, macOS or Linux.

## Where the code is

| Folder or file | What it holds |
| --- | --- |
| [`src/`](../src/) | The extension host. Ships bundled, with `@duckdb/node-api`, as `dist/extension.js`. |
| `src/extension.js` | Activation and commands. |
| `src/names.js` | What items hold tables, and how a table or model is named. |
| `src/sql.js` | The read-only guard, `tableRefs`, and `SHOW` rewriting. |
| `src/engine-host.js` | The native DuckDB engine. |
| `src/catalog.js`, `src/onelake.js`, `src/store.js` | OneLake requests, cache first, and the store on disk. |
| `src/sqltables.js` | A table's SQL name found in OneLake, and a model's GUIDs named. |
| `src/connectivity.js` | Whether this window is offline, and why. |
| `src/http.js` | How the host asks OneLake and the Fabric API for anything. |
| `src/deltalog.js` | A Delta table's own log, for Stats and History. |
| `src/fabric.js` | A workspace's semantic models and apps, and a model's definition. |
| `src/semviews.js` | The models opened, per account. |
| `src/tree.js` | The explorer. |
| `app/querytext.js` | The SQL box's statements, error positions and variables. |
| `src/panel.js`, `src/host.js`, `src/html.js`, `src/webview.js` | The panel's webview, its channel, and its page. |
| `src/agent.js`, `src/bridge.js`, `bin/cli.mjs` | The command line. |
| `src/exportapp.js`, `src/fabricapp.js`, `src/onelakewrite.js` | Export to Fabric. |
| `src/vendored.js` | The one list of pinned third-party code the webview runs, dax-sql included. |
| [`app/`](../app/) | The panel: `app.js`, `data.js`, `grid.js`, `chart.js`, `docview.js`, `paths.js`, `semantic.js`. |
| [`app/explore/`](../app/explore/) | Explore, shared with the Fabric app. |
| [`fabric_app/`](../fabric_app/) | The template for an exported app. |
| [`claude-skill/`](../claude-skill/) | The agent skill. |
| [`test/`](../test/) | `js/`: the `node --test` suite and browser runners. `sql/`: SQL statements and their answers (sqllogictest), run through the agent's `sql`. `cli*.test.mjs` run `bin/cli.mjs` as a process. |
| [`scripts/`](../scripts/) | Packaging: bundle, stage-webview, vendor, fetch-extensions, check-binding, fetch-binding, make-icon. |
| [`media/`](../media/) | Icons. |
| `docs/` | This file, the naming contract, the changelog, the missing-features review and a screenshot. |

`dist/`, `webview/`, `vendor/`, `duckdb-extensions/`, `fabric-function/` and `blog/` are ignored by git.
The first five are build output or fetched at package time, so do not edit them.
