# OneLake Studio: architecture

## What this is

OneLake Studio is a VS Code extension that makes a whole Microsoft Fabric tenant act as one database,
queried with SQL.

- **One catalog.** Every table and semantic model in the tenant has one unique name, so any statement
  can join across items, workspaces and kinds with no setup. [NAMING.md](NAMING.md) is the contract
  for those names. Everything else here depends on it.
- **SQL for everything.** The SQL box, Explore, the command line and the agent skill
  all send the same SQL over the same names. A Power BI semantic model is one more table: `AGG("measure")`
  computes its measure, compiled from its DAX by [dax-sql](https://github.com/djouallah/dax-sql).
- **Runs on your machine.** DuckDB in a process of its own reads OneLake directly, with your own token.
- **Works offline.** This is a must, not a fallback. Everything you have read keeps working with no
  internet and no sign-in: browsing, SQL, a model's Explore and its Pivot.
- **Agents get the same access.** An agent asks through the command line, on the same sign-in, cache
  and engine as a person in the editor.

```sql
SELECT * FROM lakehouse.aemo.data.dbo.dim_duid;
SELECT dim_region.Region, AGG("Registered MW") FROM semanticmodel.aemo.nem GROUP BY ALL;
SELECT * FROM 'lakehouse.aemo.data/Files/x.parquet';
SHOW ALL TABLES;
```

## Rules every change keeps

| Rule | What it means | Where it is held |
| --- | --- | --- |
| **One name per object** | A table has five parts and a model has three. A file is `'lakehouse.<workspace>.<item>/Files/<path>'`. | [NAMING.md](NAMING.md), [`src/names.js`](../src/names.js) |
| **SQL only** | A model is read with `AGG("measure")` in SQL. There is no DAX query. Excel's MDX is a second way in, and is compiled to that same SQL. | [`app/semantic.js`](../app/semantic.js), [`src/xmla/`](../src/xmla/) |
| **Read only** | Nothing is written to Fabric or OneLake. The host takes one read per statement, from a tab or the command line, and DuckDB's own parser checks it (on the SQL endpoint, a SELECT and nothing that writes: `assertTsqlRead`). The one exception is Export to Fabric, after an OK in VS Code. | `assertReads` and `checkedRead` in [`src/sql.js`](../src/sql.js), [`src/tsql.js`](../src/tsql.js) |
| **Cache first** | Every answer from OneLake or Fabric is kept on this machine and served from there first. It is trusted until using it fails, then read again once. | [`src/onelake.js`](../src/onelake.js), [`src/store.js`](../src/store.js) |
| **Works offline** | A feature that reads data works from what this machine holds, with no network. What isn't held says so at once, never on a timeout. Only writing to Fabric needs a connection: Export to Fabric. SQL endpoint mode runs on DuckDB offline. The exported Fabric app is online by design, and this rule doesn't apply to it. | [`src/connectivity.js`](../src/connectivity.js), [`src/http.js`](../src/http.js), `cache_httpfs_set_offline` in [`src/engine-host.js`](../src/engine-host.js) |
| **The host does the work** | Sign-in, the read-only guard and OneLake's listings, metadata and `Files/` bytes are in the host, and DuckDB's reads are in the server it starts. A tab is a view: it holds no token and makes no network request. | [`src/host.js`](../src/host.js), [`src/panel.js`](../src/panel.js), [`src/engine-client.js`](../src/engine-client.js) |
| **A table's Pivot is a SQL starter** | It builds a first SQL. Its only actions are Edit SQL and Close. | [`app/app.js`](../app/app.js) |

## Out of scope

- DAX queries (`EVALUATE`).
- Writing to OneLake, DDL, or editing data in the grid.
- `CREATE` and `DROP SEMANTIC VIEW`: a model exists because Fabric has it, not because SQL made it.
- ER diagrams for lakehouse tables: they declare no keys.
- vscode.dev: the engine is a native library, so this needs desktop VS Code.

Results computed from a semantic model are not guaranteed to match Power BI.

## How the parts fit

```
 Tree            Tabs, Explore           Command line, agent skill     Excel
 (VS Code)       (webview, app/)         (bin/cli.mjs)                 (PivotTable)
      |                 |                        |                         |
      |          one message channel       local pipe or socket      XMLA on 127.0.0.1
      |            (src/host.js)            (src/bridge.js, src/agent.js)  (src/xmla/)
      v                 v                        v                         v
 +-------------------------------------------------------------+
 |  Extension host (src/), one per window                      |
 |  sign-in  |  cache-first OneLake  |  the read-only guard    |
 +-------------------------------------------------------------+
      |                  |  Quack, control pipe
      |                  v
      |     +---------------------------------------------+
      |     |  The server (src/engine-server.js)          |
      |     |  one per account: DuckDB, its caches, state |
      |     +---------------------------------------------+
      v                  v
 Fabric REST API      OneLake
 (semantic models,    (tables, files)
  apps)
```

The model compiler, dax-sql, is pinned in [`src/vendored.js`](../src/vendored.js). Each tab loads it,
and the host loads the same code for the command line. To change the syntax, change dax-sql and move
the pin: the extension carries no copy of its own.

## What happens when a statement runs

The SQL box and the command line follow these steps. Explore compiles its own view
and joins at step 3.

1. **Open the models it names.** `unopenedModels` finds each `semanticmodel.<ws>.<model>` not open yet.
   The host opens it from its local copy, reading it from Fabric the first time.
2. **Compile.** `semantic.statement` has dax-sql rewrite a model query as plain SQL over five-part table
   names. A statement that names no model passes through unchanged.
3. **Check.** `assertReads` in the host refuses more than one statement, and anything that isn't a read.
   `checkedRead` then asks DuckDB's parser, in this window's own empty DuckDB, what the statement is, so that
   misreading SQL's lexing isn't enough to write. `PIVOT` is the one read the parser can't speak for, and runs with
   its comments gone. A statement that doesn't parse goes on, for DuckDB's own error and where it is.
4. **Prepare.** `withTables` in [`src/engine-host.js`](../src/engine-host.js) does three things:
   - A statement that reads the catalog (`SHOW ALL TABLES`, `information_schema`) gets the catalog
     synced from the cache first.
   - `withTables` makes a view for each five-part name: `tableRefs` finds the names,
     `resolve` ([`src/sqltables.js`](../src/sqltables.js)) looks them up in the cached listings. The view
     is `delta_scan` on a Delta table's folder, and `iceberg_scan` on an Iceberg table's metadata file.
   - `withFileUrls` gives DuckDB each file's `abfss://` URL in place of its name: `fileRefs` finds the names, and
     `resolveFile` looks them up as `resolve` does. A name that can't be found fails here.
   - `catalogStatement` rewrites `SHOW` statements so they report whole paths.
5. **Run.** The statement goes to the server, and its tab's Stop reaches only that tab's statements
   ([The server](#the-server)). A result past `maxResultRows` (200,000 by default) is counted rather than
   carried into the tab.

## Sign-in

No app registration is needed. VS Code's Microsoft account provider is a first-party application, so
`getSession` returns the OneLake token directly. The Fabric API needs a second token, in its own
audience. Expanding *Semantic models* doesn't ask for it: the tree shows a sign-in node, and VS Code asks when that is
clicked.

The token lives only in the extension host and, as a DuckDB storage secret, in the server. When VS Code hands back a new
one, the secret is reissued.

**Sign Out** is out of OneLake Studio, not out of VS Code: an extension cannot remove an account, so it
stops asking for it until you sign in again. To remove the account too, use VS Code's Accounts menu.
The decision outlives the window: the next VS Code start asks for no session, sends nothing to OneLake, and
prompts for nothing, until **Sign in to OneLake** or **Switch Microsoft Account** is chosen.

**The title says where this window reads from** ([`src/title.js`](../src/title.js)): the sidebar's header and
the title of a tab with a SQL box read OneLake Studio and then `offline` or the tenant in use. The tenant is the
`onelakeStudio.tenantId` setting when it is set, since a guest's own domain would name the wrong tenant, and
otherwise the account's domain. Only its first 4 letters are shown (`fabr…`), so a screenshot doesn't give it away.
Refresh and Open are in the view's "..." menu so it fits. A tab opened on a table, file,
semantic model or saved query is named after it instead, as a file's tab is in an editor.

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
- **No session:** the tree and the tabs open on the cache of the last account signed in on this machine,
  in the tenant the setting names, with no prompt. Another account signing in gets its own cache.

| Works offline, if cached | Needs OneLake |
| --- | --- |
| The tree, `SHOW ALL TABLES`, `information_schema`, Go To | A column or a file never read |
| A table's Stats and History, and first rows already read | A wildcard over files |
| Semantic models: opening them, Explore's Model page, `SHOW SEMANTIC …` | A table whose metadata was never read |
| Table rows, a model's queries and its Pivot, for what was read | Export to Fabric |
| `Files/` objects read before | |

**How rows are read offline:** `cache_httpfs` keeps a file's bytes on disk, but opening a file asks OneLake
for its size and version first. So what an open answers is kept too, as one more cache entry for the file,
and offline (`cache_httpfs_set_offline`) an open builds its handle from that with no request. A block it
holds reads as usual. A block it doesn't is an error, and the engine says that part isn't cached. Bytes with
no such entry need one open online to be readable offline, and aren't downloaded again.

With the disk cache off, there is nothing to read, and a statement that reads OneLake is refused at once.

**Losing the internet during a read:** the read fails on DuckDB's own timeout, the engine checks the
internet once, and if it has gone the statement runs again from what is kept.

## The engine

The engine is **DuckDB 2.0 running natively in a process of its own** ([The server](#the-server),
[`src/engine-host.js`](../src/engine-host.js)), not a WebAssembly build in the page.

- **When it starts:** behind the tree, once it has drawn and the session is known, if the tree is on screen. The window
  joins it in the background and lists the cached catalog, so a first statement does not wait for either. That statement
  still waits for its tab to open.
- **What the tree waits for:** nothing here. It draws from the catalog file before sign-in, with no server running and
  no DuckDB loaded, and the log says how long that took (`tree drawn`). A sign-in then moves it, if the account differs
  from the last one.
- **What a statement waits for:** each tab defines every kept semantic model when it opens, which can
  ask Fabric for an item's name. Only a statement that can name a model waits for that: one with
  `semantic` in it.
- **Catalogs:** one attached `:memory:` catalog per kind (`lakehouse`, `warehouse`, `sqldatabase`,
  `mirroreddatabase`), and one for `semanticmodel`. The workspace, item and schema are nested schemas.
- **Reading OneLake:** through DuckDB's `delta`, `iceberg` and `azure` extensions. A Delta table is read with
  `delta_scan` on a local copy of its log ([`src/deltamirror.js`](../src/deltamirror.js)), with the Parquet files served from OneLake through
  the disk cache by a mount in our `cache_httpfs`, and never through Fabric's Iceberg conversion, whose column ids can
  disagree with the files'. An Iceberg table is read with `iceberg_scan` on the metadata file the host's cache holds.
  Which it is, and where, comes from the cache, so the catalog is never asked at query time. DuckDB does the work itself:
  snapshots, deletes, schema evolution.
- **Reading files:** `Files/` objects are named as in [NAMING.md](NAMING.md#files), and DuckDB reads them as `abfss://` URLs.
- **Lockdown:** file access is limited to the temp directory, `https://`, `abfss://` and `zip://` over a
  remote archive. Nothing loads after it: every extension is loaded before, and autoload is off.
- **What a statement may be:** from a tab or the command line, one read, or an `EXPLAIN` of one. Never `COPY`,
  `INSERT`, `EXPORT`, `PRAGMA`, anything that creates, drops or attaches, a Quack function, the disk cache's or
  the log's own switches, `query()`, a function that writes, or an Azure URL whose host isn't OneLake's.
- **How a tab sets up a file:** by host methods, `fileView`, `attachFile` and `releaseFiles`, not by SQL. A tab takes
  away only what it made, and what it made goes when it closes. A view's source is one read too, and an attach is
  always `READ_ONLY`, from OneLake or a copy the host made.
- **What the page reaches:** the host, through one message channel, only by those, `query`, `stream`, `cancel`,
  `info` and the methods in [`src/host.js`](../src/host.js).

## The server

DuckDB runs in a process of its own ([`src/engine-server.js`](../src/engine-server.js)), and every tab of
every window is a client of it over DuckDB's Quack protocol ([`src/engine-client.js`](../src/engine-client.js)).

- **One per account and install.** The first window that needs it starts it. A rebuild replaces it. A window
  that leaves cancels its statements, and with no window left the server waits a minute, so a reload finds
  it warm, then exits. If it dies, its tabs close and the next click starts it again. **Sign Out**, **Switch
  Microsoft Account**, a restart and **Clear Cached OneLake Data** stop it for every window, and their tabs close.
- **What is shared:** one memory budget, and the blocks read, in memory over the disk cache.
- **Tabs:** each runs its own statements, and its Stop reaches only those, including one still opening its tables:
  that one answers at once and never runs. Whatever the tree opens gets a new tab, and so does **New Query**. A tab's `Files/` views carry a tag, so two tabs' views never share a name.
- **The session token:** a new random one per server, kept in VS Code's secret storage, and reaching the
  server over its stdin. Without it the port on `127.0.0.1` runs nothing. In the client's DuckDB it is a
  named secret, since an `ATTACH`'s `TOKEN` option shows in `duckdb_databases()`.
- **UTC:** the server runs in UTC whatever this machine's zone, as OneLake stores its timestamps in UTC and DAX has
  none. In a local zone a `DATE` is local midnight, so a date table's timestamp never equals a fact table's date,
  and a model joining them reads blank. So `current_date` and `now()` are UTC's too.
- **What stays in the window:** the read-only guard, the sign-in, and naming and resolving tables.
- **How a statement goes:** through a pool of attaches, up to eight a window, since one runs one statement at
  a time and its socket stays open. With all of them busy it goes by `quack_query()`, which costs a new socket:
  about 10ms, and at hundreds a second Windows runs out of ports. Stop finds the statement by a tag in a
  comment and uses `quack_cancel`, since `interrupt()` doesn't reach the server. A stopped statement's attach
  isn't used again: its reads take time to wind down, and the next statement on it waited about 80s, then failed.
- **The control pipe:** an OS pipe, signed in with the session token, that says a window is alive. The OneLake
  token, the offline switch and what Logs and Performance ask for go this way rather than over Quack, which logs
  what it is sent.
  A Quack listener can stop while the process lives on: a statement that can't connect asks over this pipe, the
  server starts it again on the same port and tells every window to attach again, and the statement goes once more.
- **What is remembered:** a SQLite file, `engine-server\catalog-<id>.sqlite` in the extension's storage
  ([`src/catalogfile.js`](../src/catalogfile.js)). All metadata is real tables there: listings, table metadata, Delta state
  and commits, the models opened, and what has been read ([`src/catalogtables.js`](../src/catalogtables.js)). A `listing`
  table says what was read and when, so an empty listing is an answer. A table's first rows are here too, with a limit of 256 MB, oldest first. Nothing else is
  evicted, as offline depends on it. Each window
  opens the file itself with Node's `node:sqlite`, so it needs no server and no DuckDB, and a page's SQL can't reach it, as
  it is outside the folders DuckDB may open. WAL lets a window read while another writes, and another window's Clear is
  noticed within a few seconds. A file that isn't a database is set aside as `.bad` and started again. It is named after
  the account, not the install, so an update keeps it, and F5 has its own.
  What an older version kept, in a DuckDB state file or a JSON store, comes across once, behind the tree, and those files
  go. That is the one time a window loads DuckDB with nothing to run.
- **The log** is a SQLite file of its own, `engine-server\logs-<id>.sqlite` ([`src/logfile.js`](../src/logfile.js)), as it
  isn't metadata: **Clear Cached OneLake Data** leaves it. The server writes it. It is named after the account, and F5 has
  its own.
- **A window's own log** is the OneLake Studio Output channel: what the extension did, with the time on each line, under
  `start:`, `session:`, `move:`, `catalog:` and `sync:`. `start:` is in ms since the extension host started, and VS Code asking for
  the tree and the tree's answer are two lines, which says whose time it was. While starting up it also says when the host's one thread was frozen, by anyone. The command line's `status` and `log` answer from
  it, signed in or not, with no request to OneLake ([`src/diaglog.js`](../src/diaglog.js)).
- **The server's own log is `logs-<id>.log`,** a plain text file beside it, so it can be read when nothing else can. Its last
  1 MB is kept.

Outside those files there is **one cache folder**, `file-cache-v1`: what DuckDB reads and, under `<account>\host\`, the bytes
of a `Files/` object the host reads, and a semantic model's `.yaml` copy under `models\`. Saved queries are yours, under
`~/OneLakeStudio/queries`.

**Logs** ([`src/logs.js`](../src/logs.js)), a node in the tree, with one tab per window. The record is DuckDB's own: its `Quack` log has a row per
statement with the time to its first rows and any error, for every tab, window and the command line. A large
result's later rows aren't in that time, since DuckDB doesn't log them. It is kept in memory
(file storage can't be read back on Windows, since DuckDB locks its own file), and the server moves it to the log
file every two seconds ([`src/enginelog.js`](../src/enginelog.js)), up to `onelakeStudio.logMaxGB`, the oldest going first.
It holds your SQL and its errors in plain text, and never the OneLake token. A row reopens its SQL in a new tab, not run.
A semantic model's query runs as the SQL dax-sql compiles it to, with the query as written in a comment in front
([`app/semantic.js`](../app/semantic.js)), so its row shows what was asked and, opened, what it compiled to. It reopens
as what was asked.
`SELECT * FROM duckdb_logs` answers in a SQL box for what is still in memory.

**Performance** ([`src/performance.js`](../src/performance.js)), a node in the tree, with one tab per window. Live charts of
memory, cores in use, queries per second and the disk cache, while the tab is on screen. Nothing is stored. It has no
SQL box, no Stop and no Restart.

## The cache

| What | Where it is kept | When it is read again |
| --- | --- | --- |
| Listings (workspaces, items, tables, `Files/`, semantic models), table metadata, first rows | The catalog file, [`src/catalogfile.js`](../src/catalogfile.js) | Served at once, refreshed in the background past its window |
| The name behind a Direct Lake model's item GUIDs | The catalog file | Only when using it fails |
| The bytes of a `Files/` object the host reads (an image, a `.bim`, a SQLite copy, a saved file) | The cache folder, under the etag its cached listing gave | Only when the file was rewritten |
| What DuckDB reads: table data and `Files/` objects | DuckDB's disk cache (`cache_httpfs`) | Only when the file was rewritten: a kept copy is checked against the file's version tag and modification time |
| That a table's rows were read, per snapshot | The catalog file | Never: a new snapshot is a new entry |
| A semantic model's definition | The cache folder, `models/<account>/<workspace>/<model>.yaml` | On **Download Again** |

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
  - **A table kept as empty** can't fail, so it is read again past `catalogTtlMinutes`, before a statement uses it.
- **An answer that was cut off is a failure, not an empty listing:** what was kept stays, and shows *refresh failed*.
- **The disk cache's limit** is held when the server starts and every hour after, so one long scan can pass it for a while.
- **Clearing reaches every window:** each one notices it in the catalog file within a few seconds, and what it holds in
  memory goes too.
- **The catalog keeps itself current** ([`src/syncworker.js`](../src/syncworker.js)), behind everything, in a window's
  extension host, where VS Code's sign-in, proxy and certificates are. Each window refreshes what it has open and pinned
  workspaces past `catalogTtlMinutes`. One window, holding a lease in the catalog file, reads the rest of the tenant's
  listings every 12 hours: workspaces, items, table lists, and models if a Fabric token is already there. That is five
  listings every 15 seconds, one at a time, and a 429 or no answer stops it for a minute. It reads no table's metadata, and
  offline it asks nothing. A listing that can't be read shows *refresh failed* beside the last good answer. A window hears
  what another wrote from the file within a few seconds, and its tree redraws.
- **A table statements keep reading is looked after** ([CATALOG.md](CATALOG.md#tables-in-use)). Read 3 times in 14 days, it is
  *in use*. Its metadata is read every hour, and when nobody is running anything each new snapshot is read whole, through
  the engine, under `onelakeStudio.keepUsedTablesGB`. Anyone's statement stops that, and what it read stays. It works offline
  from then on, every column. A table over the limit isn't downloaded, and says so in its tooltip.
- **Per Microsoft account:** switching accounts never serves one account's data to another.
- **Survives a sign-out:** signing back in finds it warm. Only **Clear Cached OneLake Data** deletes it.
- **The catalog is cached too:** `SHOW ALL TABLES` and `information_schema` list every table the catalog file knows with
  no request to OneLake. A table whose columns were never read is listed with none, and a statement that names it reads
  them first. In `information_schema.columns` it has one placeholder, `(columns not read yet)`, as a DuckDB view must have
  a column.
- **A patched build:** the vsix carries a `cache_httpfs` with a Windows fix not yet released upstream
  (without it, nothing is cached on disk on Windows), the offline read above, and a refusal of any Azure URL whose host
  isn't OneLake's, so the OneLake token can't be sent elsewhere. With the disk cache off, only the guard's text check says that. DuckDB loads it as an
  unsigned extension. A build without it fails, rather than ship with no disk cache.
- **What a build downloads is held to its hash:** the libraries and DuckDB's extensions, against
  `scripts/downloads.sha256.json`, and DuckDB's native binding against the lockfile. The community extensions `h3` and
  `zipfs` ship in the vsix too, so nothing is downloaded at run time unless the disk cache is off.

## The explorer

The tree ([`src/tree.js`](../src/tree.js)) lists workspaces, then lakehouses, warehouses, SQL and
mirrored databases, their tables and files, semantic models and apps. *Queries*, **Logs** and
**Performance** come after them, and stay there when a listing fails or finds nothing. Workspaces can be pinned, and the tree can be filtered to one type.

**A table's icon** says whether it is cached, as a model's does: a cloud until a statement has read its
rows at its current snapshot, a check after (`cached.rows` in [`src/onelake.js`](../src/onelake.js)). What is
kept is the part of each file that was read, so a check doesn't promise every column, unless its tooltip says it was read
whole. A new snapshot goes
back to the cloud. A table nothing was ever written to has a check, since it reads no file. **A file's icon** says the
same, per version of the file (`cached.file`): a statement or a tab read it, or the host kept it whole, and a file
rewritten in OneLake goes back to the cloud. A wildcard marks no one file. **A folder under `Tables/`** with neither a
Delta log nor Iceberg metadata has a warning and says *not a valid table*. That is kept like any table's metadata, so it
shows offline, and it is asked again when the table is opened or its Tables node is, so a folder that becomes a table stops saying so.

**Clicking a table** opens it in a new tab: Data, Stats, History and Pivot. The SQL box gets
`SELECT * FROM <its name> LIMIT 100` to start from, not run. A file does the same with what its preview runs.
- **Data** is hidden offline on a table with none of its rows read here, since all it could show is an error. The status
  line says why. It comes back with the connection.
- **Stats and History** come from the table's metadata, with no data read. A table written as Delta
  also has its own log read for what Iceberg has no word for ([`src/deltalog.js`](../src/deltalog.js)).
- **Time travel:** on an Iceberg table, History's Query puts a snapshot's rows in the SQL box, and
  each snapshot says how its row count and columns differ from the table now.
- **Pivot** is the SQL starter described under the rules above.

**Clicking a file** opens it in a new tab: Parquet, CSV, JSON, Excel, DuckDB, SQLite, and files inside a zip.
- **A database file** is recognised by its header, never its extension. A DuckDB file is attached
  read-only and block-read on demand. A SQLite file is copied by the host into the engine's temp
  directory and attached read-only, capped at 200 MB.
  - **It opens on what it holds** ([`app/dbview.js`](../app/dbview.js)): a tree of its schemas, tables, views and
    columns beside the SQL box, with a filter, and an overview of the file. This comes from DuckDB's catalog, so no
    table's rows are read. The tree stays while queries run in that tab.
  - **A table or view** opens as a table in OneLake does: Stats (columns, keys, indexes, its definition), Data and
    Pivot. It has no History.
  - **Row counts:** a DuckDB file's are its own estimate, which still counts deleted rows, and say so. A SQLite file's
    are counted from its copy, for up to 200 tables, since its estimate means nothing.
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
- That is two reads per app when *Apps* is expanded, then cached. A button copies the URL, and a click opens it in
  the browser. Nothing is changed.

## The SQL box and results

SQL is written in a box in each tab ([`app/app.js`](../app/app.js)), not in VS Code's editor. **A query
never opens a `.sql` file**, because opening one starts every SQL extension installed, on the extension
host every extension shares, and a click on Run then waits behind them with nothing on screen. A `.sql`
file you open yourself is left to those extensions. The box reacts by itself: a click says *Running…* at
once and counts, though the answer still comes through the host.

- **The box holds one query.** The text last written comes back when **Open OneLake Studio** opens a tab with
  none open, in the next window too.
- **New Query** (the **+** on *Queries*) opens a new tab with `SHOW ALL TABLES` in its box, not run. A saved query
  opens in a new tab too. **Save Query** (Ctrl+S) writes it back, or keeps a new one under *Queries* as `Query N`.
- **Run** (Ctrl+Enter) runs the statement under the cursor, or the selection. **Plan** shows where it
  spends its time.
- **Errors:** the status line says what DuckDB says, and the cursor goes where it says it is.
- **Variables:** `SET VARIABLE year = 2024` keeps a value in that tab and `getvariable('year')`
  reads it. **Clear Query Variables** forgets them, in every tab of the window.
- **From the tree:** a table's right-click has Select Top Rows, Copy SQL Name and Copy Column List. Files, folders
  and semantic models have no right-click: their actions are icons on the row, shown on hover.
  - **A file:** Download File… and Copy SQL Name. A semantic model: Download File… (its YAML, read from Fabric first
    when there is no local copy yet), Copy SQL Name and Download Again. A file is read from OneLake after the save
    dialog, so a cancel reads nothing.
  - **A folder** (Files/ itself, or one under it): **Upload Files…**, Copy SQL Name and Refresh. Upload picks files on
    this computer and writes each into that folder ([`src/onelakewrite.js`](../src/onelakewrite.js)): a name already
    there asks Replace or Skip, each file is written beside the target in 32 MB pieces and renamed into place, so a
    cancel or a failure leaves what was there, and the folder is listed again. It needs a connection, as Export does,
    and OneLake's own refusal is shown when the lakehouse is read-only to you.
  **Go to a Table, Column or Measure** (Ctrl+Alt+O) searches everything the cache holds. A pick opens it in a
  new tab, and its button puts its name in the box, or copies it with no tab open.

Results show in the tab:

- **Grid** ([`app/grid.js`](../app/grid.js)): every row scrolls, cells select and copy, and a filter box
  keeps the rows that hold its text.
- **Chart** ([`app/chart.js`](../app/chart.js)): draws the rows on screen. Nothing is queried again.
- **Profile:** each column of the result, over every row the query returns (`SUMMARIZE`).
- **Export…** writes every row to a CSV, Parquet or Excel file. The engine writes it, through VS Code's
  save dialog. SQL typed by hand still cannot `COPY`.

## SQL endpoint mode

`onelakeStudio.sqlEngine` is `duckdb` by default. With `sqlEndpoint`, what a person writes and runs goes to the
Fabric SQL endpoint of the workspace it names, in T-SQL, and nothing on screen changes: the SQL box, a model's
queries (Explore, a table's Pivot, Open in Excel, the command line), Plan, Profile and Export. What the tab reads
for itself stays DuckDB's: a table's Stats, Data and History, files, SHOW and DESCRIBE.

- **Names are the same** ([NAMING.md](NAMING.md#on-the-sql-endpoint)): a statement writes
  `lakehouse.<workspace>.<item>.<schema>.<table>`, and the host makes it `"item"."schema"."table"` on that
  workspace's endpoint, which holds every lakehouse and warehouse of it as a database. One workspace a statement.
- **A model's queries are T-SQL:** every view is in a second dax-sql registry, `dialect: 'tsql'`
  ([`app/semantic.js`](../app/semantic.js)); what dax-sql can't write in T-SQL is in its DESIGN.md.
- **The host runs it** ([`src/tsql.js`](../src/tsql.js)): tedious, with the SQL audience's token for the same
  account (`signin.js sqlToken`), a few connections kept per endpoint and account, and Stop for a tab's own
  statements. The answer is in the engine's shape, so the grid, Explore, the command line and Excel read it as
  DuckDB's.
- **Plan** is the endpoint's estimated plan (`SET SHOWPLAN_XML`; it has no actual one), and its Profile runs the
  query once more, its time shared out by the operators' estimated costs. **Profile** of a result and
  **Export…** read every row from the endpoint: the profile is worked out in the host, in SUMMARIZE's columns, and
  DuckDB writes the export.
- **Offline,** everything runs on DuckDB, as in `duckdb` mode: the tab compiles for the dialect that runs now
  (`core.js sqlDialect`, posted with the settings).
- **Which statements go there:** one that names a lakehouse or warehouse table by its five parts, or a semantic
  model (`dialectOf` in [`app/app.js`](../app/app.js)). A file is a string, not a table, so its preview, and a
  database file's tables, are DuckDB's in either mode. A table clicked in the tree starts the box at
  `SELECT TOP 100 *`: the endpoint has no `LIMIT`.
- **Export to Fabric** makes an app that runs no DuckDB ([Export to Fabric](#export-to-fabric), SQL endpoint mode).

## Semantic models

**A Power BI semantic model is a Fabric item.** It is not in OneLake: its list and its definition come
from the Fabric REST API ([`src/fabric.js`](../src/fabric.js)). In SQL it is a **semantic view**, named
`semanticmodel.<workspace>.<model>` and listed by `SHOW ALL TABLES` with the rest of the catalog. Every
workspace has one model of a name.

**Opening one**
- **From the tree:** a click reads its TMSL definition (the REST API's `getDefinition`) and keeps it as
  Apache Ossie (dax-sql's `tmslToOssie`) in the cache folder, at `models/<account>/<workspace>/<model>.yaml`,
  then opens that copy. It is under its account because a workspace's name is unique in one tenant only.
- **What the copy says:** a measure is a metric in Ossie's portable SQL when it means the same there, and DAX
  when not. When every table is in one lakehouse of the model's workspace, each dataset's `source` is
  `<lakehouse>.<schema>.<table>` and the file holds no Direct Lake expression; that lakehouse is found by name
  in the tree's listing, so it opens offline. A model over several lakehouses keeps its expression. The
  `POWER_BI` extension holds only what Ossie has no field for and something needs: what changes an answer
  (a relationship's filter direction, a date table, ...) and what a user sees (format strings, hidden, ...).
- **From a query:** a statement that names a model not open yet opens it first, in the same way.
- **Nothing is written to OneLake**, so someone who may only read the workspace can open and query it.
- **Only Direct Lake.** Any other model is refused, and nothing is kept.
- **A model over a SQL endpoint is read from OneLake too** ([`src/sqlendpoint.js`](../src/sqlendpoint.js)). Its
  expression names the endpoint, and the local copy holds the OneLake URL of the item behind it instead, so nothing
  connects to the endpoint and it works offline as any model does. The endpoint's workspace is in its host name, and a
  lakehouse or mirrored database says which endpoint is its own.
- **An endpoint Fabric doesn't show** is deleted or isn't yours to see, which look alike. If it is in the model's own
  workspace, its tables are read from there when exactly one item holds them all, and a message says so. Otherwise it is
  refused: tables of the same name in another workspace are other tables.
- **The local copy is the cache.** Later clicks open it without asking Fabric, and the tree marks the
  model with a check. The command line reads and writes the same copies. **Download Again** reads
  Fabric again and replaces the copy, after asking.
- **Every model opened is remembered** as a pointer (name, file path, when) in the account's catalog file
  ([`src/semviews.js`](../src/semviews.js)), so it survives a restart. **Clear Cached OneLake Data** takes it, with the
  local copy.
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
the SQL box. dax-sql's `formats/ossie.js` turns Ossie into the `.bim` it stands for, metrics in DAX or in
Ossie's SQL alike, and from there the two are one. These files can be stored anywhere and have no model name. A model created from one, for
Fabric or only for a Fabric app, must be named `semanticmodel.<workspace>.<model>`, and it overwrites
whatever we have under that name. See [NAMING.md](NAMING.md#files).

**`serve <file>`** reads a model file on this computer ([`src/models.js`](../src/models.js) `modelFile`). Its
tables are OneLake's. A Direct Lake expression says their workspace. Tables named `<lakehouse>.<schema>.<table>` are
in the model's workspace, which the file doesn't say: the one it was served in before, while that workspace still
holds those lakehouses, else `--workspace`, and the error names the workspaces whose kept listing holds them.

## Explore

A semantic model opens as **Explore** ([`app/explore/`](../app/explore/)), on two pages:

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

`view.js` is host-neutral: the host passes in the compiler, how to run SQL, and where ECharts comes
from. **A tab** runs it on the native engine. **The Fabric app** runs the
same files on DuckDB-WASM.

## Export to Fabric

One of two writes, with Upload (above). Explore's **Export to Fabric** button, or the command line's `export`, publishes that
model's Explore, nothing else, as a Fabric app (item type `AppBackend`, named
`<model>-explore`). VS Code and the extension are all it needs: no CLI, no Node, no GitHub.

**What it writes**
- **The app**, in Fabric.
- **The model's file**, into the `Files/` of its lakehouse, when it was opened from its local copy:
  `<lakehouse>/Files/semantic_model/<model>.yaml` ([`src/onelakewrite.js`](../src/onelakewrite.js)). The
  app reads the model there. A different file of that name is replaced only when you say so, and not being able
  to tell what is there stops the export. It is written beside the file and renamed into place, so a failure part way
  leaves what was there.
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
- **The app reads the model's tables, not the lakehouse:** its function signs a read-only SAS for each table the model
  names, and refuses any other.
- **No silent takeover:** a re-export updates the item the last export created (its id is kept in the
  local copy, as soon as the item exists). If an app of that name exists and no export created it, the export asks.
- **Local edits are never overwritten unasked.** The local copy's marker keeps a hash of each of its
  files as last published (`site/`, `rayfin/`, `AGENTS.md`, `.gitignore`, without `node_modules` or
  `dist/`). If any changed, the export asks: *Overwrite Local Changes*, *Publish Folder As Is*, or
  cancel.
- **A newer deploy is never overwritten unasked.** The marker keeps the app's last deploy time, by
  Fabric's clock. If the app was deployed again since, the export asks.
- **A folder the export did not write** is refused.

**In SQL endpoint mode** (`onelakeStudio.sqlEngine` `sqlEndpoint`) the app runs no DuckDB, in the browser or anywhere.
- **The function runs the queries:** Explore's query over the model goes to its `sqlEndpoint` call
  ([`function_app.ts`](../fabric_app/rayfin/functions/src/function_app.ts)), which compiles it to T-SQL with dax-sql
  (the page's own pinned copy, put in the bundle by [`scripts/function-bundle.mjs`](../scripts/function-bundle.mjs))
  and runs it on the lakehouse's SQL endpoint with tedious and the app identity's SQL token (Rayfin's
  `AudienceType.Sql`). Its settings `SQL_ENDPOINT` and `SQL_DATABASE` say where; the export finds them.
- **Only a SELECT over the model is taken**, never SQL of the browser's own: whoever can call it reads what the app
  shows, through the model, and nothing else of the lakehouse.
- **The page** ([`storage/sqldata.js`](../fabric_app/site/storage/sqldata.js), chosen by `site/engine.json`) sends
  the query and draws the rows; its Show plan is the endpoint's estimated plan, and its SQL tab the T-SQL. `site/`
  holds no DuckDB, extensions, Arrow or browser data source, and no SAS is signed: the workspace setting for
  user-delegated SAS tokens isn't needed.

**The template** ([`fabric_app/`](../fabric_app/))
- **`site/`:** the page, black always. Its data source (`storage/`) signs in with Rayfin's Fabric SSO,
  takes the model and the tables' locations from the app's function with a read-only SAS per table, and downloads
  the tables' files into the browser, where DuckDB-WASM (DuckDB 2.0), shipped in the site's `vendor/`, reads them as `v_<table>`
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

## The desktop app

**The app is the extension.** Its Node process ([`src/desktop/main.js`](../src/desktop/main.js)) runs
[`src/extension.js`](../src/extension.js) as it is, bundled with `vscode` pointing at
[`src/desktop/vscode.js`](../src/desktop/vscode.js): the part of VS Code's API the extension uses, and no more. So every
command, menu, tab and message is the same code in both, and a change to the extension is a change to the app.

- **The window** ([`desktop/ui/`](../desktop/ui/)) draws what VS Code otherwise would: the tree, the tab strip, menus,
  dialogs, Go To, Settings and the status bar. What it shows comes from the extension and its `package.json`: the tree's
  nodes, the tabs' pages, the menus and their `when` clauses, the settings.
- **It behaves as a Windows app does**: a menu bar (File, View, Help, About), the tree put away with Ctrl+B or its
  button on the left, a tab's right-click (Close Others, Close All), Ctrl+Tab. A tab's page hands every key to the
  window first, so a shortcut works wherever the focus is, and the browser's own (F5, Ctrl+P, Ctrl+F) do nothing.
  The tree's width, whether it shows, and the zoom are kept in `window-state.json` in the data folder, not in the
  page's storage, whose origin's port is new each start.
- **A tab** is the same page as the extension's, in an iframe, with `acquireVsCodeApi` and VS Code's theme variables given
  to it in its own CSP.
- **The connection** is an HTTP server on `127.0.0.1` ([`src/desktop/server.js`](../src/desktop/server.js)): messages out
  as server-sent events, back as POSTs. The first request's token becomes an `HttpOnly`, `SameSite=Strict` cookie, and
  anything without it, with another `Host` or another `Origin`, is refused. A page reaches only its own files.
- **What needs Windows** ([`src/desktop/dialogs.js`](../src/desktop/dialogs.js)): the save and folder dialogs, the clipboard
  and Explorer, through PowerShell, as Open in Excel is.
- **Sign-in** is the command line's: MSAL as the Azure CLI's public client, with the token cache under DPAPI, and the same
  `signin` for both. No app registration.
- **The same data:** with VS Code on the machine, its folder for this extension, so the extension, the command line and the
  app read one cache. With none, `%LOCALAPPDATA%\OneLake Studio\data`. Settings are VS Code's where there are any, under
  what the app's Settings tab changes.
- **The shell** is Tauri ([`desktop/src-tauri/`](../desktop/src-tauri/)): it shows a splash, starts the Node process, and
  opens the page it names. Each line the process says after that is something only the shell can do: exit, zoom.
  Closing the window closes the process's stdin, and it ends; if the process ends first, the splash comes back with
  Restart. A second start shows the first window, and the window's size and place are kept. The installer is per user.
- **Updates:** at start, and on Help › Check for Updates, the latest release's tag is compared with this version
  ([`src/desktop/update.js`](../src/desktop/update.js)). A newer one is said in the status bar, with a link to the
  installer. Offline, nothing is said. The app downloads and installs nothing itself.
- **CI's `desktop` job** drives the window in Edge, which is what WebView2 is, on the real engine, then builds the
  installer, installs it and starts it once. Its screenshots and the installer are the run's artifacts.

## The command line and the agent skill

**[`bin/cli.mjs`](../bin/cli.mjs) is a doorbell first.** It hands its arguments to the running extension over a
local pipe or socket ([`src/bridge.js`](../src/bridge.js)). The extension answers
([`src/agent.js`](../src/agent.js)) with its own sign-in, cache, engine and compiler.

**With VS Code closed,** on Windows with Node 22.5 or later, the same answer comes from
[`src/standalone.js`](../src/standalone.js), which is [`src/core.js`](../src/core.js) with no editor around it:

- **Sign-in:** `signin` opens the browser, once, as the Azure CLI's public client through MSAL
  ([`src/msalsession.js`](../src/msalsession.js)). No app registration. A tenant's admin can block that client, and only
  this is affected: the extension's sign-in stays VS Code's. The token cache is encrypted for this Windows user
  with DPAPI ([`src/tokenstore.js`](../src/tokenstore.js)).
- **The same cache:** a session's account id is MSAL's `homeAccountId` in both, so one person has one account key, and the
  files are VS Code's for this extension. The tenant and the proxy come from VS Code's `settings.json`.
- **Its own engine:** VS Code's server has its session token in VS Code's secret storage, so this one is a server of its
  own, sharing the catalog, the log and the disk cache as the background engine does. Its token is in a file in this user's
  profile, and opens a local port, no more.
- **Nothing stays running:** no sync and no idle job. The process ends with the answer, and its server a minute after.
- **Not here:** `export`, which asks for an OK in VS Code. Exit code 3 says so.

**`serve <model.yaml|.bim>`** is always that, as it stays running: Excel's endpoint ([Open in Excel](#open-in-excel)) on a
model file, with no VS Code. The model takes the name `semanticmodel.<workspace>.<model>`, from where its tables are and the
file's name, or `--workspace` and `--name`, as [NAMING.md](NAMING.md#files) says of a model made from a file. Excel's
PivotTables are its only client. **`--open`** opens a new workbook on it.

**The skill** is [`claude-skill/SKILL.md`](../claude-skill/SKILL.md). **Install Agent Skill** writes it to
`~/.claude/skills/onelake/`, where Claude Code and GitHub Copilot in VS Code (agent mode) look for
personal skills, and it follows the extension through updates.

`node bin/cli.mjs --help` is the full reference for commands and options. An agent should branch on:

| Exit code | Meaning |
| --- | --- |
| 0 | Answered. With `--json`, `complete` and `truncated` say how much. |
| 1 | Failed. |
| 2 | Wrong call. |
| 3 | Not signed in, or `export` with VS Code closed. |
| 4 | Not cached. `--fresh` asks OneLake or Fabric now, unless offline, when it fails the same way. |
| 5 | You declined an export. |
| 6 | Timed out. |

- **Output:** the answer alone goes to stdout and notes go to stderr.
- **`--json`** prints `{ ok, columns, rows, total, truncated, complete, cachedAt, notes }`, or
  `{ ok: false, error: { code, message, retry }, notes }`.
- **How old an answer is:** `cachedAt` on `sql` is when the oldest table it read was last read from OneLake, and
  `sql --fresh` reads their metadata first. Past an hour, a note says so, and so does a tab's status line.
- **`sql -`** reads SQL from stdin. Prefer it for anything with quotes in it: `AGG("Total Sales")` does
  not survive every shell.
- **`--show-sql`** prints the SQL a model query compiles to.
- **A missing table fails at once.** A 400 or 404 from the catalog checks for the table's folder under `Tables/`.
  With no folder there is no conversion to wait for, and the error names the closest listed tables.
- **A folder that is no table fails at once.** With neither `_delta_log` nor `metadata/` in it, it is not a valid OneLake
  table. `ls` and `find` say so, `exists` says no, and `SHOW ALL TABLES` leaves it out.
- **`export`** is the command line's one write: the same code path as Explore's button, with the same questions asked
  in VS Code.

## Keep offline

**Keep offline**, a switch beside a semantic model's tabs, keeps every table the model reads on this machine and current,
so it answers from disk and with no connection ([`src/modeldata.js`](../src/modeldata.js)). Each table is read whole
through the engine, as the idle job does it (`keepTable`): every column of every file goes through the disk cache, and
no row comes back.

- **A background job, in an engine of its own.** Reading whole with the query engine took a whole connection: beside a
  query, it held one for 3 minutes on a 50 Mbit/s line, and starved the host's own requests. So it runs in a second server
  process, `extension.js backgroundEngine`, on one thread and 1 GB with few requests per read, and never stops for a
  query. They share only the disk cache. A cold query still shares the line with it, and has most of it. The server
  exits once nothing is left to read, and isn't started until something is.
- **It was asked for,** so it differs from the idle job: it starts at once, with no two quiet minutes first, and has no
  time limit. The idle job holds off meanwhile, or the two would read the same bytes twice.
- **It stays on.** It's a row in the catalog per model, so it goes on with the tab closed and comes back with the next
  window. Each table's metadata is read past the cache every hour, and a new snapshot comes down when it appears.
- **Every window shows the same.** What the switch says is worked out from the catalog (`table_kept`), and one window reads:
  the one with the catalog's lease. Its statements are in **Logs**, a line per column, as the two servers share a log file.
- **Off stops it, and deletes nothing.** A table stopped part way keeps what it read, and switching on again carries on.
  Back on answers at once from what's kept, asking OneLake nothing: whether anything is newer is looked for behind it, on the hourly clock.
  The disk cache clears the oldest as it does for everything else.
- **More than the disk cache holds stays off** (`diskCacheMaxGB`), counting the other models kept offline, since it would
  evict itself. **Clear Cached OneLake Data** switches them all off.
- **A table that fails** is named beside the switch and tried again in an hour. With no connection it waits, and carries on.

## Open in Excel

**Open in Excel**, a button on a semantic model's Pivot, opens a new workbook with a PivotTable live on the model,
on Windows and the Excel desktop app. Any model that has a Pivot has it, a local copy or a file in a lakehouse's
`Files/`: the model is found by its SQL name, through its kept view. It opens with no fields placed, whatever the
Pivot's shelves hold. Excel's provider speaks XMLA over HTTP, so [`src/xmla/`](../src/xmla/) answers it from the window:

```
Excel (MSOLAP) --SOAP over http://127.0.0.1--> extension host
  Discover -> rowsets built from the model's TMSL
  Execute  -> MDX -> model SELECTs -> dax-sql -> the guard -> the server -> a cell set
```

- **A model is one cube.** A table is a dimension, a column an attribute hierarchy, a measure a member of `[Measures]`.
  What's hidden stays out, as in Power BI's field list ([`cube.js`](../src/xmla/cube.js)).
- **Not an MDX engine.** A PivotTable writes a narrow, regular subset, and [`mdx.js`](../src/xmla/mdx.js) reads only that:
  the statements captured from Excel are its tests. Anything else is refused by name, never guessed at. That covers
  calculated members written in Excel, Show Details, value and Top 10 filters, and "show items with no data".
- **One model SELECT per grain.** Totals and subtotals are computed by dax-sql at their own grain, not added up, so a
  distinct count or a ratio is right on every line ([`cellset.js`](../src/xmla/cellset.js)). The price is a query per
  combination of subtotals, capped at 256.
- **The port.** The one port the extension opens, and only once **Open in Excel** has been used. It binds `127.0.0.1`,
  and a request must name a token kept in VS Code's secret storage. A browser can still send a request there, so anything
  with an `Origin` is refused, and a `Host` that isn't this address, which is what DNS rebinding would show.
- **A saved workbook** keeps its port and token, so it refreshes whenever VS Code is open, in any window: one
  window serves at a time, as with the command line's bridge. With VS Code closed it fails with a connection error.
  On another machine it doesn't refresh, since the token belongs to this install.
- **Number formats** aren't applied: Excel doesn't ask this server for them (`CELL PROPERTIES VALUE` only).
- **A model with no measures** still opens, with a hidden placeholder measure, since Excel refuses a cube with none. Its
  fields list their values, and there are no numbers: Excel adds up a model's measures, never its columns.

## Commands

| Command | What it does |
| --- | --- |
| **Open OneLake Studio** | Brings the last tab forward, or opens one, signing in if needed. In the Command Palette only: the tree opens a tab with **New Query**. |
| **Sign in to OneLake** | Signs in and fills the explorer, without opening a tab. |
| **Sign in to the Fabric API** | Asks for the second token, for semantic models and apps. |
| **Switch Microsoft Account** | Asks which account to use, closes every tab and opens a new one, so the previous account's tables do not survive the switch. |
| **Sign Out** | Signs out of OneLake Studio, closes every tab and stops the server. What is cached stays on show. In the explorer's "..." menu. |
| **Settings** | Opens VS Code's Settings page, filtered to this extension. In the explorer's "..." menu. |
| **Logs**, **Performance** | Nodes in the tree. See [The server](#the-server). |
| **Refresh** | Re-reads a workspace, item or folder from OneLake in the foreground. |
| **Filter by Type** | The filter button on the explorer. Shows one type, and only the workspaces that hold it, which reads every workspace's listing, cache-first. The explorer's header names the filter. Not remembered. |
| **Pin to Favorites** / **Unpin from Favorites** | Moves a workspace in or out of the tree's favorites group. |
| **Show Read Log** | Every OneLake request the host made, with sizes and timings. DuckDB's own reads aren't in it. |
| **Clear Cached OneLake Data** | Empties the on-disk cache and reports what it freed. In the explorer's "..." menu. |
| **Install Agent Skill (Claude Code, GitHub Copilot)** | Installs the skill above. |
| **New Query**, **Open Query**, **Rename Query…**, **Delete Query**, **Show Queries Folder** | Saved queries, under *Queries* in the tree. |
| **Go to a Table, Column or Measure…** (Ctrl+Alt+O) | Searches everything the cache holds. |
| **Clear Query Variables** | Forgets values from `SET VARIABLE`. |
| **Select Top Rows**, **Copy SQL Name**, **Copy Column List** | A table's right-click. Copy SQL Name is on a file's and a folder's too. |
| **Download Again (from Fabric)** | Replaces a semantic model's local copy. |
| **Copy App URL** | An app's button. |
| **Open App**, **Open Table**, **Open File**, **Open Semantic Model** | A click in the tree. A double click counts as one ([`src/doubleclick.js`](../src/doubleclick.js)). |
| **Copy**, **Copy with Headers**, **Copy as CSV**, **Copy as Markdown**, **Copy as JSON**, **Open as CSV Document**, **Open as JSON Document** | The grid's right-click. |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `onelakeStudio.tenantId` | empty | Directory (tenant) GUID to sign in against. Empty is your home tenant. Set it to reach a tenant you are a guest in. |
| `onelakeStudio.catalogTtlMinutes` | 5 | How old a listing may be before it is refreshed. The last known answer is always served from disk first. |
| `onelakeStudio.tableMetadataTtlHours` | 24 | How old a table's Iceberg metadata may be before it is refreshed. **Refresh** on its lakehouse re-reads it at once. |
| `onelakeStudio.keepUsedTablesGB` | 10 | How much of the tables statements keep reading is read whole in the background and kept, and may come down in a day. Never over half of `diskCacheMaxGB`. `0` turns it off, and their metadata is still read every hour. |
| `onelakeStudio.prefetchMetadata` | on | Reads every table's metadata in the background once a lakehouse's Tables node is opened, so the first click is a disk read. |
| `onelakeStudio.diskCacheMaxGB` | 64 | How much of what DuckDB reads from OneLake, tables and `Files/`, is kept on disk, per account. `0` turns the disk cache off. |
| `onelakeStudio.cacheDirectory` | empty | Where the disk cache is kept, as a full path. Empty is VS Code's storage for this extension. A new folder starts empty. |
| `onelakeStudio.engineMemoryLimit` | empty | Most memory DuckDB may use, e.g. `4GB`. Empty is a quarter of the machine's RAM. |
| `onelakeStudio.engineThreads` | 0 | How many threads DuckDB may use. `0` is every core. |
| `onelakeStudio.engineSpillMaxGB` | 0 | How much a query bigger than memory may spill to the temp folder. `0` is DuckDB's default. |
| `onelakeStudio.logMaxGB` | 1 | How much of what the engine ran is kept for **Logs**, per account. `0` keeps none. |
| `onelakeStudio.selectTopRows` | 1000 | How many rows **Select Top Rows** asks for. |
| `onelakeStudio.maxResultRows` | 200,000 | The most rows of one result a tab and the command line keep, from 1,000 to 1,000,000. Past it, rows are only counted. |
| `onelakeStudio.sqlEngine` | `duckdb` | What runs the SQL box's statements and a model's queries: `duckdb`, or `sqlEndpoint`, the workspace's Fabric SQL endpoint, in T-SQL ([SQL endpoint mode](#sql-endpoint-mode)). Offline, DuckDB. |
| `onelakeStudio.tableOpensOn` | `stats` | What clicking a table shows first: `stats` or `data`. |
| `onelakeStudio.gridThousandsSeparator` | off | Shows numbers in the grid with thousands separators. A copy still gets the raw value. |

The engine locks its configuration after it boots. Disk cache size, cache folder, memory, threads,
spill limit, log limit and the result row limit therefore apply when it restarts, which closes every tab of
every window. The rest apply at once.

## Limitations

- **A lakehouse with no schemas of its own lists its tables under `dbo`**, the namespace OneLake's catalog
  reports for those items.
- **An item its catalog cannot serve shows an error rather than a table list.** There is no DFS fallback.
  Re-picking the item tries again.
- **A result past `maxResultRows` is counted rather than carried into the tab.** The status line gives both counts,
  and **Export…** writes every row.
- **Tabs don't come back after a window reload.** Only the box's last text does (see
  [The SQL box and results](#the-sql-box-and-results)).
- **A Pivot's shelves are kept per tab,** so a model opened again in a new tab starts with empty shelves.
- **Requires desktop VS Code 1.101+** on Windows x64, or macOS or Linux on x64 or arm64, for its built-in SQLite. Windows on arm64 has no build of DuckDB's `delta`, so no package.

## Where the code is

| Folder or file | What it holds |
| --- | --- |
| [`src/`](../src/) | The extension host and the server. Ship bundled, with `@duckdb/node-api`, as `dist/extension.js` and `dist/engine-server.js`. |
| `src/extension.js` | What is VS Code's: activation, commands, the tree's view, dialogs and the status bar. It hands the rest in. |
| `src/core.js` | What a window builds that isn't about how it looks: the store, the catalog, the command line, Excel, and what happens when the account moves. Nothing it loads needs VS Code. |
| `src/signin.js`, `src/settings.js`, `src/readlog.js` | When a session is asked for, and its tokens. What the settings mean. What a window says about its reads. |
| `src/engines.js` | The engine this window reads with, the background engine, and the catalog files. |
| `src/queries.js`, `src/models.js` | Saved queries on disk. A model's local copy, and what the cache can name. |
| `src/exportflow.js` | Export to Fabric, from its first question to the published app. |
| `src/skill.js`, `src/diskuse.js` | The agent skill's file. How much a folder holds. |
| `src/names.js` | What items hold tables, and how a table or model is named. |
| `src/sql.js` | The read-only guard, `tableRefs`, and `SHOW` rewriting. |
| `src/engine-host.js` | The native DuckDB engine: what the server boots, and how a window prepares and runs a statement. |
| `src/catalog.js`, `src/onelake.js`, `src/store.js` | OneLake requests, cache first, and the store. |
| `src/sqltables.js` | A table's SQL name found in OneLake, and a model's GUIDs named. |
| `src/connectivity.js` | Whether this window is offline, and why. |
| `src/http.js` | How the host asks OneLake and the Fabric API for anything. |
| `src/deltalog.js` | A Delta table's own log, for Stats and History. |
| `src/deltamirror.js` | A Delta table's log kept in the cache folder, for `delta_scan` to run on. |
| `src/fabric.js` | A workspace's semantic models and apps, and a model's definition. |
| `src/sqlendpoint.js` | A Direct Lake model over a SQL endpoint, pointed at the item behind it. |
| `src/semviews.js` | The models opened, per account. |
| `src/tree.js`, `src/doubleclick.js` | The explorer, and a double click in it counting as one click. |
| `src/title.js` | What the sidebar's header and a tab's title say. |
| `app/querytext.js` | The SQL box's statements, error positions and variables. |
| `src/panel.js`, `src/host.js`, `src/html.js`, `src/webview.js` | A tab's webview, its channel, and its page. |
| `src/performance.js`, `src/logs.js` | The Performance and Logs tabs. |
| `src/catalogfile.js`, `src/catalogtables.js`, `src/syncworker.js` | What is remembered, in SQLite, the catalog's tables there, and what keeps them current and looks after tables in use. |
| `src/engine-server.js`, `src/engine-client.js`, `src/enginelog.js`, `src/logfile.js` | The server: its process, a window's side of it, and its log. |
| `src/agent.js`, `src/bridge.js`, `bin/cli.mjs` | The command line. |
| `src/desktop/`, `desktop/` | The desktop app: VS Code's API for the extension, its server, its window and its Tauri shell. |
| `src/standalone.js`, `src/msalsession.js`, `src/tokenstore.js` | The command line with VS Code closed: `core.js` with no editor, its sign-in, and its token cache. |
| `src/diaglog.js` | A window's own log. |
| `src/exportapp.js`, `src/fabricapp.js`, `src/onelakewrite.js` | Export to Fabric. |
| `src/vendored.js` | The one list of pinned third-party code the webview runs, dax-sql included. |
| [`app/`](../app/) | A tab's page: `index.html`, `app.js`, `data.js`, `grid.js`, `chart.js`, `docview.js`, `dbview.js`, `paths.js`, `semantic.js`, `cdn.js`, `host.js`, `vscode-api.js`. |
| [`app/explore/`](../app/explore/) | Explore, shared with the Fabric app. |
| [`fabric_app/`](../fabric_app/) | The template for an exported app. |
| [`claude-skill/`](../claude-skill/) | The agent skill. |
| [`test/`](../test/) | `js/`: the `node --test` suite and browser runners. Its `cli*.test.mjs` run `bin/cli.mjs` as a process. `sql/`: SQL statements and their answers (sqllogictest), run through the agent's `sql`. `e2e/`: the vsix in a real VS Code server and headless Chrome, signed out, and signed in with no internet. |
| [`scripts/`](../scripts/) | Packaging: bundle, stage-webview, vendor, function-bundle, fetch-extensions, check-binding, fetch-binding, fetch-retry, make-icon. The website: build-website, and website-shots, which takes its screenshots in the installed app. |
| [`media/`](../media/) | Icons. |
| `docs/` | This file, the naming contract, the catalog specification and the changelog, which the website renders as pages of its own; an index and a screenshot for GitHub. |
| [`website/`](../website/) | The public website: static HTML and its screenshots, built with the docs by `scripts/build-website.mjs` and deployed by `.github/workflows/pages.yml`. |

`dist/`, `webview/`, `vendor/`, `duckdb-extensions/`, `fabric-function/` and `blog/` are ignored by git.
The first five are build output or fetched at package time, so do not edit them.
