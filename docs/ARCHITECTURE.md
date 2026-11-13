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
  internet and no sign-in: browsing, SQL, a model's Explore and its Visual.
- **Agents get the same access.** An agent asks through the command line, on the same sign-in, cache
  and engine as a person in the editor.

```sql
SELECT * FROM aemo.data.dbo.dim_duid;
SELECT dim_region.Region, AGG("Registered MW") FROM aemo.nem_semanticmodel GROUP BY ALL;
SELECT * FROM 'aemo.data/Files/x.parquet';
SHOW ALL TABLES;
```

## Rules every change keeps

| Rule | What it means | Where it is held |
| --- | --- | --- |
| **One name per object** | A lakehouse table is `<workspace>.<lakehouse>.<schema>.<table>`, another item's `<workspace>.<item>_<kind>.<schema>.<table>`, either by its GUIDs too, and a model is `<workspace>.<model>_semanticmodel`. A file is `'<workspace>.<lakehouse>/Files/<path>'`. | [NAMING.md](NAMING.md), [`core/names.js`](../core/names.js) |
| **SQL only** | A model is read with `AGG("measure")` in SQL. There is no DAX query. Excel's MDX is a second way in, and is compiled to that same SQL. An exported Fabric app on a semantic model runs the DAX that dax-sql makes of that SQL. | [`page/semantic.js`](../page/semantic.js), [`xmla/`](../xmla/) |
| **Reads, and writes to a lakehouse only** | A statement reads, or writes to a lakehouse: its tables as Iceberg, through its Iceberg catalog, and its `Files/` by `COPY … TO` ([SQL writes](#sql-writes)). SQL writes nothing else, and DuckDB's own plan of each write is checked first. Export to Fabric (the app), Create Semantic Model and Upload Files… each ask first. | `assertReads`, `checkedRead`, `writeOf` and `checkPlan` in [`core/sql.js`](../core/sql.js), `runWrite` in [`core/engine/engine-host.js`](../core/engine/engine-host.js) |
| **Cache first** | Every answer from OneLake or Fabric is kept on this machine and served from there first. It is trusted until using it fails, then read again once. | [`core/onelake/onelake.js`](../core/onelake/onelake.js), [`core/onelake/store.js`](../core/onelake/store.js) |
| **Works offline** | A feature that reads data works from what this machine holds, with no network. What isn't held says so at once, never on a timeout. Only writing to Fabric needs a connection: Export to Fabric, Create Semantic Model and Upload Files…. The exported Fabric app is online by design, and this rule doesn't apply to it. | [`core/onelake/connectivity.js`](../core/onelake/connectivity.js), [`core/onelake/http.js`](../core/onelake/http.js), the lake in [`core/lake/tableservice.js`](../core/lake/tableservice.js) |
| **The host does the work** | Sign-in, the read-only guard and OneLake's listings, metadata and `Files/` bytes are in the host, and DuckDB's reads are in the server it starts. A tab is a view: it holds no token and makes no network request. | [`core/host.js`](../core/host.js), [`extension/panel.js`](../extension/panel.js), [`core/engine/engine-client.js`](../core/engine/engine-client.js) |
| **A table's Visual is a SQL starter** | It builds a first SQL. Its only actions are Edit SQL and Close. | [`page/app.js`](../page/app.js) |

## Out of scope

- DAX queries (`EVALUATE`).
- Writing a Delta table, a warehouse or anything outside a lakehouse; `DROP`; editing data in the grid.
- `CREATE` and `DROP SEMANTIC VIEW`: a model exists because Fabric has it, not because SQL made it.
- ER diagrams for lakehouse tables: they declare no keys.
- vscode.dev: the engine is a native library, so this needs desktop VS Code.

Results computed from a semantic model are not guaranteed to match Power BI.

## How the parts fit

```
 Tree            Tabs, Explore           Command line, agent skill     Excel
 (VS Code)       (webview, page/)        (cli/cli.mjs)                 (PivotTable)
      |                 |                        |                         |
      |          one message channel       local pipe or socket      XMLA on 127.0.0.1
      |           (core/host.js)        (cli/bridge.js, cli/agent.js)    (xmla/)
      v                 v                        v                         v
 +-------------------------------------------------------------+
 |  Extension host (extension/, core/), one per window         |
 |  sign-in  |  cache-first OneLake  |  the read-only guard    |
 +-------------------------------------------------------------+
      |                  |  Quack, control pipe
      |                  v
      |     +---------------------------------------------+
      |     |  The server (core/engine/engine-server.js)          |
      |     |  one per account: DuckDB, the lake, and the |
      |     |  table service that copies its files here   |
      |     +---------------------------------------------+
      v                  v
 Fabric REST API      OneLake
 (semantic models,    (tables, files)
  apps)
```

The model compiler, dax-sql, is pinned in [`core/vendored.js`](../core/vendored.js). Each tab loads it,
and the host loads the same code for the command line. To change the syntax, change dax-sql and move
the pin: the extension carries no copy of its own.

## What happens when a statement runs

The SQL box and the command line follow these steps. Explore compiles its own view
and joins at step 3.

1. **Open the models it names.** `unopenedModels` finds each `<ws>.<model>_semanticmodel` not open yet.
   The host opens it from its local copy, reading it from Fabric the first time.
2. **Compile.** `semantic.statement` has dax-sql rewrite a model query as plain SQL over the tables'
   names. A statement that names no model passes through unchanged.
3. **Check.** `assertReads` in the host refuses more than one statement, and anything that isn't a read. A
   statement that isn't a read goes to [SQL writes](#sql-writes) instead.
   `checkedRead` then asks DuckDB's parser, in this window's own empty DuckDB, what the statement is, so that
   misreading SQL's lexing isn't enough to write. `PIVOT` is the one read the parser can't speak for, and runs with
   its comments gone. A statement that doesn't parse goes on, for DuckDB's own error and where it is.
4. **Prepare.** `withTables` in [`core/engine/engine-host.js`](../core/engine/engine-host.js) does three things:
   - A statement that reads the catalog (`SHOW ALL TABLES`, `information_schema`) gets the catalog
     synced from the cache first.
   - `withTables` makes a view for each table's name: `tableRefs` finds the names,
     `resolve` ([`core/sqltables.js`](../core/sqltables.js)) looks them up in the cached listings. The view
     is over the table's lake table ([Reading OneLake tables](#reading-onelake-tables)).
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

**The title says where this window reads from** ([`core/title.js`](../core/title.js)): the sidebar's header and
the title of a tab with a SQL box read OneLake Studio and then `offline` or the tenant in use. The tenant is the
`onelakeStudio.tenantId` setting when it is set, since a guest's own domain would name the wrong tenant, and
otherwise the account's domain. Only its first 4 letters are shown (`fabr…`), so a screenshot doesn't give it away.
Refresh and Open are in the view's "..." menu so it fits. A tab opened on a table, file,
semantic model or saved query is named after it instead, as a file's tab is in an editor.

## Offline

Offline is a requirement for every feature of the extension that reads data, so a new one has to work here
too. The exported Fabric app is online by design.

Nothing turns this on. The extension is offline when there is no internet or no session, says which in
the status bar, and comes back by itself ([`core/onelake/connectivity.js`](../core/onelake/connectivity.js)).

- **Detecting it:** a request that gets no answer at all starts a probe of OneLake, and offline means the
  probe got none either. Any HTTP status is an answer, so a slow connection counts as online. Offline, the
  probe repeats every 30 seconds.
- **No request is sent.** `authedFetch` refuses first ([`core/onelake/http.js`](../core/onelake/http.js)), so nothing waits
  on a timeout. Export to Fabric is refused too.
- **What is kept is the answer,** however old ([`core/onelake/onelake.js`](../core/onelake/onelake.js)), with no background
  refresh or prefetch. Anything not held says so at once.
- **No session:** the tree and the tabs open on the cache of the last account signed in on this machine,
  in the tenant the setting names, with no prompt. Another account signing in gets its own cache.

| Works offline, if cached | Needs OneLake |
| --- | --- |
| The tree, `SHOW ALL TABLES`, `information_schema`, Go To | A table's file no statement has opened here, or a file never read |
| A table's Stats and History, and first rows already read | A wildcard over files |
| Semantic models: opening them, Explore's Model page, `SHOW SEMANTIC …` | A table whose metadata was never read |
| Table rows, a model's queries and its Visual, for what was read | Export to Fabric |
| `Files/` objects read before | |

**How rows are read offline:** a table's files that statements have read are on this machine, whole, and its
lake table names them there ([Reading OneLake tables](#reading-onelake-tables)). Offline, a statement reads
those. A file not here yet fails on its OneLake path, and the engine says that part isn't cached. A table never
read on this machine is refused at once, before anything runs.

A `Files/` object read by a statement isn't kept: it is read from OneLake each time, and offline that statement is
refused at once.

**Losing the internet during a read:** the read fails on DuckDB's own timeout, the engine checks the
internet once, and if it has gone the statement runs again, offline.

## The engine

The engine is **DuckDB 2.0 running natively in a process of its own** ([The server](#the-server),
[`core/engine/engine-host.js`](../core/engine/engine-host.js)), not a WebAssembly build in the page.

- **When it starts:** behind the tree, once it has drawn and the session is known, if the tree is on screen. The window
  joins it in the background and lists the cached catalog, so a first statement does not wait for either. That statement
  still waits for its tab to open.
- **What the tree waits for:** nothing here. It draws from the catalog file before sign-in, with no server running and
  no DuckDB loaded, and the log says how long that took (`tree drawn`). A sign-in then moves it, if the account differs
  from the last one.
- **What a statement waits for:** each tab defines every kept semantic model when it opens, which can
  ask Fabric for an item's name. Only a statement that can name a model waits for that: one with
  `semantic` in it.
- **Catalogs:** none of its own for names. A table's workspace, item and schema are nested schemas in the engine's
  catalog, and a model is a view in its workspace's schema there. A workspace named like a catalog the engine
  has (`lake`, an attached database file) is read by GUIDs, and a database file named like a workspace is attached as
  `<name>_file`.
- **Reading OneLake:** a Delta or Iceberg table through the lake ([Reading OneLake tables](#reading-onelake-tables)),
  `Files/` objects through DuckDB's `azure` extension. A Delta table is never read through Fabric's Iceberg conversion,
  whose column ids can disagree with the files'. Which it is, and where, comes from the cache, so the catalog is never
  asked at query time. A table with OneLake security that OneLake refuses this user is read with
  `read_arrow` on what the table read API answered ([OneLake security](#onelake-security)).
- **Reading files:** `Files/` objects are named as in [NAMING.md](NAMING.md#files), and DuckDB reads them as `abfss://` URLs.
- **Lockdown:** file access is limited to the temp directory, `https://`, `abfss://` and `zip://` over a
  remote archive. Nothing loads after it: every extension is loaded before, and autoload is off.
- **What a statement may be:** from a tab or the command line, one read, or an `EXPLAIN` of one, or one of
  [SQL's writes](#sql-writes) to a lakehouse. Never `EXPORT`, `PRAGMA`, `DROP`, anything that attaches, a Quack
  function, the log's own switches, a `ducklake_` function, `query()`, a function that writes, a write's own
  catalog, or an Azure URL whose host isn't OneLake's.
- **How a tab sets up a file:** by host methods, `fileView`, `attachFile` and `releaseFiles`, not by SQL. A tab takes
  away only what it made, and what it made goes when it closes. A view's source is one read too, and an attach is
  always `READ_ONLY`, from OneLake or a copy the host made.
- **What the page reaches:** the host, through one message channel, only by those, `query`, `stream`, `cancel`,
  `info` and the methods in [`core/host.js`](../core/host.js).

## The server

DuckDB runs in a process of its own ([`core/engine/engine-server.js`](../core/engine/engine-server.js)), and every tab of
every window is a client of it over DuckDB's Quack protocol ([`core/engine/engine-client.js`](../core/engine/engine-client.js)).

- **One per account and install.** The first window that needs it starts it. A rebuild replaces it. A window
  that leaves cancels its statements, and with no window left the server waits a minute, so a reload finds
  it warm, then exits. If it dies, its tabs close and the next click starts it again. **Sign Out**, **Switch
  Microsoft Account**, a restart and **Clear Cached OneLake Data** stop it for every window, and their tabs close.
- **What is shared:** one memory budget, the blocks read, in memory, and the lake.
- **Tabs:** each runs its own statements, and its Stop reaches only those, including one still opening its tables:
  that one answers at once and never runs. Whatever the tree opens gets a new tab, unless a tab shows it already: then that tab comes forward, as it is. **New Query** always gets a new tab. A tab's `Files/` views carry a tag, so two tabs' views never share a name.
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
  ([`core/onelake/catalogfile.js`](../core/onelake/catalogfile.js)). All metadata is real tables there: listings, table metadata, Delta state
  and commits, the models opened, and what has been read ([`core/onelake/catalogtables.js`](../core/onelake/catalogtables.js)). A `listing`
  table says what was read and when, so an empty listing is an answer. A table's first rows are here too, with a limit of 256 MB, oldest first. Nothing else is
  evicted, as offline depends on it. Each window
  opens the file itself with Node's `node:sqlite`, so it needs no server and no DuckDB, and a page's SQL can't reach it, as
  it is outside the folders DuckDB may open. WAL lets a window read while another writes, and another window's Clear is
  noticed within a few seconds. A file that isn't a database is set aside as `.bad` and started again. It is named after
  the account, not the install, so an update keeps it, and F5 has its own.
  What an older version kept, in a DuckDB state file or a JSON store, comes across once, behind the tree, and those files
  go. That is the one time a window loads DuckDB with nothing to run.
- **The log** is a SQLite file of its own, `engine-server\logs-<id>.sqlite` ([`core/logfile.js`](../core/logfile.js)), as it
  isn't metadata: **Clear Cached OneLake Data** leaves it. The server writes it. It is named after the account, and F5 has
  its own.
- **A window's own log** is the OneLake Studio Output channel: what the extension did, with the time on each line, under
  `start:`, `session:`, `move:`, `catalog:` and `sync:`. `start:` is in ms since the extension host started, and VS Code asking for
  the tree and the tree's answer are two lines, which says whose time it was. While starting up it also says when the host's one thread was frozen, by anyone. The command line's `status` and `log` answer from
  it, signed in or not, with no request to OneLake ([`core/diaglog.js`](../core/diaglog.js)).
- **The server's own log is `logs-<id>.log`,** a plain text file beside it, so it can be read when nothing else can. Its last
  1 MB is kept.

Outside those files there is **one cache folder**, `file-cache-v1`, with a folder per account. In it: the lake under
`lake\` (its DuckLake metadata file `meta.ducklake`, the tables' file copies under `files\` and their delete files under
`deletes\`), the bytes of a `Files/` object the host reads under `host\`, and a table with OneLake security under
`secured\`. A semantic model's `.yaml` copy is under `models\<account>\`. Saved queries are yours, under
`~/OneLakeStudio/queries`.

**Logs** ([`extension/logs.js`](../extension/logs.js)), a node in the tree, with one tab per window. The record is DuckDB's own: its `Quack` log has a row per
statement with the time to its first rows and any error, for every tab, window and the command line. A large
result's later rows aren't in that time, since DuckDB doesn't log them. It is kept in memory
(file storage can't be read back on Windows, since DuckDB locks its own file), and the server moves it to the log
file every two seconds ([`core/engine/enginelog.js`](../core/engine/enginelog.js)), up to `onelakeStudio.logMaxGB`, the oldest going first.
It holds your SQL and its errors in plain text, and never the OneLake token. A row reopens its SQL in a new tab, not run.
A semantic model's query runs as the SQL dax-sql compiles it to, with the query as written in a comment in front
([`page/semantic.js`](../page/semantic.js)), so its row shows what was asked and, opened, what it compiled to. It reopens
as what was asked.
`SELECT * FROM duckdb_logs` answers in a SQL box for what is still in memory.

**Performance** ([`extension/performance.js`](../extension/performance.js)), a node in the tree, with one tab per window. Live charts of
memory, cores in use, queries per second and the disk cache, while the tab is on screen. Nothing is stored. It has no
SQL box, no Stop and no Restart.

## OneLake security

A table can have OneLake security: roles with rules on its rows or its columns. OneLake then refuses the table's
files, and often its metadata and Delta log, to a user those rules restrict, so DuckDB can't read it directly. Such a
table is read through OneLake's table read API instead ([`core/lake/tableread.js`](../core/lake/tableread.js)), on the user's own
storage token. The API applies the user's rules and answers Arrow streams, which DuckDB reads with `read_arrow`, from
the `nanoarrow` extension shipped in the vsix. The table keeps its SQL name, so a join, a model and Explore read
it as they read any table.

- **The direct read comes first.** A user who may read the files never uses the API.
- **When the API is used:** OneLake answers 403 for the table's metadata or Delta log while the table is resolved
  ([`core/sqltables.js`](../core/sqltables.js)), or DuckDB gets a 403 reading its files. The engine then reads the first
  row of each table the statement names, to find which ones were refused, and only those go to the API. The statement
  runs again once. The window remembers each one, so its next statement goes straight to the kept copy.
- **What it costs:** each read is charged to the workspace's capacity, for every row it scans. The API has no row
  filter, so a read is every row and column the user may see.
- **Kept like a table's metadata:** what the API answered is kept in the cache folder, under `secured\`, one folder per
  table, and read again only past `tableMetadataTtlHours` or after **Refresh** on its lakehouse. A copy past its age
  tries the direct read first, so a user since given the whole table stops paying for the API. A read is kept whole or
  not at all: its streams go into a `.part` folder that is renamed once all of them have arrived. The disk cache's
  limit and **Clear Cached OneLake Data** cover these folders.
- **Offline:** a kept copy answers, however old. A table never read says so at once.
- **Stop** stops a read under way, unless another statement is waiting for the same table.
- **Stats and History** still need the table's metadata and log. If OneLake refuses those, they show its 403, which
  says the table may have OneLake security and that a statement still reads its rows.
- **Turned off** with `onelakeStudio.securedTableRead`: a refused table then fails, and the error names the setting. A
  copy already kept is still used.
- **With the disk cache off** there is nowhere to keep the streams, and a refused table says so.

## Reading OneLake tables

Every Delta and Iceberg table is read through **the lake**: one DuckLake catalog, `lake`, in the server
([`core/lake/onelaketable.js`](../core/lake/onelaketable.js), [`core/lake/tableservice.js`](../core/lake/tableservice.js)). Each of its files
is named by where it is: its OneLake path, until it has come to this machine whole, then its copy in the cache folder.
A table can be part here and part on OneLake, and DuckDB opens each file where its name says.

- **A table is synced from its own metadata, and no data file is read for that.** A Delta table from its `_delta_log`:
  the newest checkpoint, in one part or several, and the commits after it, a file known by its path and its deletion
  vector together, as Delta reconciles them. An Iceberg table from its manifests. What is synced is its schema and its live
  files: each one's size, row count, partition values and deletes. Each sync is one snapshot of the lake table: a file no
  longer live is ended, a new one added, a column added, renamed (under column mapping) or dropped.
- **A statement reads the lake as it is, and asks OneLake nothing.** The table's name is found in the catalog file, and
  if the lake holds the table, the statement reads it at once: no log is read, and no metadata is asked for, even right
  after the server starts. It reads the table as of its last sync. Only a table the lake has never held is synced
  first, on its first read, which reads its whole log once.
- **The sync service finds out that a table changed** ([`core/onelake/syncworker.js`](../core/onelake/syncworker.js)), in the window with
  the lease. It reads the catalog's metadata of the tables the lake holds: every hour for a table in use, and at
  `tableMetadataTtlHours` for the others. When a table's metadata location has moved past the one the lake was synced
  from, it asks the server to sync that table (`lakeSync` on the control pipe), one table at a time, and only while no
  statement is running. **Refresh** on a lakehouse makes the next statement on each of its tables read the metadata
  again and sync the table. A failed read that is retried (`fresh`) syncs it too.
- **A sync reads only what is new.** The lake remembers what each table was synced from, in `studio_synced` in its own
  metadata file, in the same transaction as the sync: its folder, the metadata location, the Delta version, and that
  version's live files. The next sync reads only the commits after that version, 16 at a time, and applies them to
  those files. It reads the log whole only when a checkpoint is newer than that version, when the log doesn't go on
  from it, or when the table was dropped and made again. A new snapshot of a table written every few minutes is one
  commit, which is one request.
- **Deletes:** a Delta deletion vector is the same bytes as an Iceberg Puffin delete file, which DuckLake reads, so
  each is cut out of the `.bin` it is packed in, or built from an inline one, and kept under `lake\deletes`. An Iceberg
  table's position-delete file is used as it is. A data file with several (an `UPDATE` and then a `DELETE` each write
  one) has them merged into one under `lake\deletes`, since DuckLake takes one delete file a data file and read the
  file once for each. Column mapping and partitions are kept.
- **Held to its snapshot:** after an Iceberg table is synced, its lake table's rows are counted and must come to what
  its snapshot says it holds (`total-records` less `total-position-deletes`). One that doesn't is never read, and the
  statement says why, until a sync reads it right: wrong rows are worse than none.
- **What a statement reads comes here.** The server keeps DuckDB's log of the files statements open. A file
  opened on OneLake is queued, downloaded whole over HTTPS, opened once here (on Windows the first open of a new file
  can wait many seconds, and a statement mustn't be the one that waits), and then its name in the lake becomes the copy,
  in the transaction that records it. The unit is a file: a table never comes down whole for this, only the files
  statements open. Kept under `lake\files`, by workspace, item and folder, so a Delta partition's `col=value` folder
  is in the copy's path, where the lake reads its value.
- **What goes:** a copy whose file the latest snapshot no longer names, slowly and behind everything else, once nothing
  has needed it for 15 minutes, since a statement that started before keeps the files it started with. A file a table
  still reads stays, unless what is kept here would pass `onelakeStudio.diskCacheMaxGB`: then the least recently read
  goes back to its OneLake name, and its copy goes the same slow way. At `0` nothing comes here.
- **One process holds the lake:** its metadata file can be open in one only. So the server holds it, a window asks it
  for a table over the control pipe (`lakeTable`, `lakeSync`, `lakeTables`), and Keep offline's reads are a client of the same server. The
  standalone host's server has a lake of its own, `lake-standalone`, and the desktop app's `lake-desktop`.
- **Only through the lake:** a table is never read past it. An engine that can't open the lake doesn't start, and one
  with no cache folder (no account) refuses a table.
- **What a statement can't do to it:** DuckLake's own functions write, and one deletes files from a `SELECT`. The guard
  and the server refuse any `ducklake_` function by name. The lake's metadata is a database called `system_internal`
  (`system_internal.ducklake_snapshot`, `ducklake_data_file`, `studio_synced` and the rest), which a statement reads
  like any table, and can't write, since a statement writes only to a lakehouse, through its own catalog.

## The cache

| What | Where it is kept | When it is read again |
| --- | --- | --- |
| Listings (workspaces, items, tables, `Files/`, semantic models), table metadata, first rows | The catalog file, [`core/onelake/catalogfile.js`](../core/onelake/catalogfile.js) | Served at once, refreshed in the background past its window |
| The name behind a Direct Lake model's item GUIDs | The catalog file | Only when using it fails |
| The bytes of a `Files/` object the host reads (an image, a `.bim`, a SQLite copy, a saved file) | The cache folder, under the etag its cached listing gave | Only when the file was rewritten |
| A table's files that statements read | The cache folder, `lake\files`, named in the lake ([Reading OneLake tables](#reading-onelake-tables)) | Never: a file isn't rewritten. A new snapshot names new files |
| `Files/` objects a statement reads | Not kept | Every time |
| That a table's rows were read, per snapshot | The catalog file | Never: a new snapshot is a new entry |
| A semantic model's definition | The cache folder, `models/<account>/<workspace>/<model>.ossie.yaml` | On **Refresh** of its workspace or its Semantic models |
| A table with OneLake security: the rows and columns the table read API gave this user | The cache folder, `secured\` | Past `tableMetadataTtlHours`, or after **Refresh** ([OneLake security](#onelake-security)) |

- **A kept answer is trusted until using it fails.** Then it is read again once, and the work tried again
  only if the answer changed. Otherwise the first error stands, and so it does offline
  (`revalidate` in [`core/onelake/store.js`](../core/onelake/store.js)). A window's age only ever starts a refresh in the
  background.
  - **A name not in a kept listing:** the listing is read again before the name is called missing.
  - **A lakehouse renamed under a model:** the name its GUIDs gave no longer resolves, so Fabric is asked
    again. A compiled query goes on working, and the next one uses the new name.
  - **A table's read fails** (DuckDB's `IO Error`): the table's listing and metadata are read again. A
    statement's own mistake asks OneLake nothing.
  - **A model's local copy** is not covered: it changes only on **Refresh** of its workspace or its Semantic models.
  - **A table kept as empty** can't fail, so it is read again past `catalogTtlMinutes`, before a statement uses it.
- **An answer that was cut off is a failure, not an empty listing:** what was kept stays, and shows *refresh failed*.
- **The disk cache's limit** is held by the table service before each file comes down.
- **Clearing reaches every window:** each one notices it in the catalog file within a few seconds, and what it holds in
  memory goes too.
- **The catalog keeps itself current** ([`core/onelake/syncworker.js`](../core/onelake/syncworker.js)), behind everything, in a window's
  extension host, where VS Code's sign-in, proxy and certificates are. Each window refreshes what it has open and pinned
  workspaces past `catalogTtlMinutes`. One window, holding a lease in the catalog file, reads the rest of the tenant's
  listings every 12 hours: workspaces, items, table lists, and models if a Fabric token is already there. That is five
  listings every 15 seconds, one at a time, and a 429 or no answer stops it for a minute. The only table metadata it reads
  is that of the tables the lake holds, to sync each one that moved ([Reading OneLake tables](#reading-onelake-tables)), and
  offline it asks nothing. A listing that can't be read shows *refresh failed* beside the last good answer. A window hears
  what another wrote from the file within a few seconds, and its tree redraws.
- **A table statements keep reading is looked after** ([CATALOG.md](CATALOG.md#tables-in-use)). Read 3 times in 14 days, it is
  *in use*. Its metadata is read every hour, so its lake table is synced to each new snapshot within the hour, and when
  nobody is running anything it is synced once more under `onelakeStudio.keepUsedTablesGB` (`keepTable`, which syncs it now). Nothing of it is read: its files come here only as
  statements open them, and the sync keeps every copy still live. A table over the limit isn't synced, and says so in its tooltip.
- **Per Microsoft account:** switching accounts never serves one account's data to another.
- **Survives a sign-out:** signing back in finds it warm. Only **Clear Cached OneLake Data** deletes it.
- **The catalog is cached too:** `SHOW ALL TABLES` and `information_schema` list every table the catalog file knows with
  no request to OneLake. A table whose columns were never read is listed with none, and a statement that names it reads
  them first. In `information_schema.columns` it has one placeholder, `(columns not read yet)`, as a DuckDB view must have
  a column.
- **The OneLake token and other hosts:** the guard refuses an Azure URL whose host isn't OneLake's, as a statement
  writes it. A URL joined up from pieces at run time gets past that check, and nothing behind it refuses it yet.
- **What a build downloads is held to its hash:** the libraries and DuckDB's extensions, against
  `scripts/downloads.sha256.json`, and DuckDB's native binding against the lockfile. The community extensions `h3`,
  `zipfs` and `nanoarrow` ship in the vsix too, and load as unsigned extensions, as a load by path knows only DuckDB's own
  signing keys. `ducklake` ships with the rest.

## The explorer

The tree ([`extension/tree.js`](../extension/tree.js)) lists workspaces, then lakehouses, warehouses, SQL and
mirrored databases, their tables and files, semantic models and apps. *Queries*, **Logs** and
**Performance** come after them, and stay there when a listing fails or finds nothing. Workspaces can be pinned, and the tree can be filtered to one type.

**A table's icon** says whether it is cached, as a model's does: a cloud until a statement has read its
rows at its current snapshot, a check after (`cached.rows` in [`core/onelake/onelake.js`](../core/onelake/onelake.js)). What is
kept is each file a statement opened, whole, so a check doesn't promise every file: a statement filtered to one
partition brought that partition, not the table. A new snapshot goes back to the cloud. A table nothing was ever written to has a check, since it reads no file. **A file's icon** says the
same, per version of the file (`cached.file`): a statement or a tab read it, or the host kept it whole, and a file
rewritten in OneLake goes back to the cloud. A wildcard marks no one file. **A folder under `Tables/`** with neither a
Delta log nor Iceberg metadata has a warning and says *not a valid table*. That is kept like any table's metadata, so it
shows offline, and it is asked again when the table is opened or its Tables node is, so a folder that becomes a table stops saying so.

**Clicking a table** opens it in a new tab, or brings forward the tab that shows it: Data, Stats, History and Visual. The SQL box gets
`SELECT * FROM <its name> LIMIT <selectTopRows>` to start from, not run. A file does the same with what its preview runs.
- **Data** is hidden offline on a table with none of its rows read here, since all it could show is an error. The status
  line says why. It comes back with the connection.
- **Stats and History** come from the table's metadata, with no data read. A table written as Delta
  also has its own log read for what Iceberg has no word for ([`core/lake/deltalog.js`](../core/lake/deltalog.js)).
- **Time travel:** on an Iceberg table, History's Query puts a snapshot's rows in the SQL box, and
  each snapshot says how its row count and columns differ from the table now.
- **Visual** is the SQL starter described under the rules above.

**Clicking a file** opens it in a new tab, or brings forward the tab that shows it: Parquet, CSV, JSON, Excel, DuckDB, SQLite, and files inside a zip.
- **A database file** is recognised by its header, never its extension. A DuckDB file is attached
  read-only and block-read on demand. A SQLite file is copied by the host into the engine's temp
  directory and attached read-only, capped at 200 MB.
  - **It opens on what it holds** ([`page/dbview.js`](../page/dbview.js)): a tree of its schemas, tables, views and
    columns beside the SQL box, with a filter, and an overview of the file. This comes from DuckDB's catalog, so no
    table's rows are read. The tree stays while queries run in that tab.
  - **A table or view** opens as a table in OneLake does: Stats (columns, keys, indexes, its definition), Data and
    Visual. It has no History.
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

SQL is written in a box in each tab ([`page/app.js`](../page/app.js)), not in VS Code's editor. **A query
never opens a `.sql` file**, because opening one starts every SQL extension installed, on the extension
host every extension shares, and a click on Run then waits behind them with nothing on screen. A `.sql`
file you open yourself is left to those extensions. The box reacts by itself: a click says *Running…* at
once and counts, though the answer still comes through the host.

- **The box holds one query.** The text last written comes back when **Open OneLake Studio** opens a tab with
  none open, in the next window too.
- **New Query** (the **+** on *Queries*) opens a new tab with `SHOW ALL TABLES` in its box, not run. A saved query
  opens in a new tab too. **Save Query** (Ctrl+S) writes it back, or keeps a new one under *Queries* as `Query N`.
- **Run** (Ctrl+Enter) runs the statement under the cursor, or the selection. A selection with several statements
  runs each in turn, in order, and stops at the first that fails, with the cursor on it; the status line says which
  one is running (`2/3 · …`), and the last one's rows are shown. **Plan** shows where one statement spends its time.
- **A statement can write** to a lakehouse ([SQL writes](#sql-writes)), with no question asked.
- **Errors:** the status line says what DuckDB says, and the cursor goes where it says it is.
- **Variables:** `SET VARIABLE year = 2024` keeps a value in that tab and `getvariable('year')`
  reads it. **Clear Query Variables** forgets them, in every tab of the window.
- **From the tree:** a table's right-click has Select Top Rows, Copy SQL Name and Copy Column List. Files, folders
  and semantic models have no right-click: their actions are icons on the row, shown on hover.
  - **A file:** Download File… and Copy SQL Name. A semantic model: Download File…, which asks Ossie (its local copy,
    `<model>.ossie.yaml`, read from Fabric first when there is none yet; experimental) or TMSL (`<model>.bim`, Fabric's
    own model.bim, kept beside the copy each time Fabric is read, so it downloads offline; Power BI's default), and Copy
    SQL Name. A file is read from OneLake after the save
    dialog, so a cancel reads nothing.
  - **A folder** (Files/ itself, or one under it): **Upload Files…**, Copy SQL Name and Refresh. Upload picks files on
    this computer and writes each into that folder ([`fabric_app/export/onelakewrite.js`](../fabric_app/export/onelakewrite.js)): a name already
    there asks Replace or Skip, each file is written beside the target in 32 MB pieces and renamed into place, so a
    cancel or a failure leaves what was there, and the folder is listed again. It needs a connection, as Export does,
    and OneLake's own refusal is shown when the lakehouse is read-only to you.
  **Go to a Table, Column or Measure** (Ctrl+Alt+O) searches everything the cache holds. A pick opens it in a
  new tab, and its button puts its name in the box, or copies it with no tab open.

Results show in the tab:

- **Grid** ([`page/grid.js`](../page/grid.js)): every row scrolls, cells select and copy, and a filter box
  keeps the rows that hold its text.
- **Chart** ([`page/chart.js`](../page/chart.js)): draws the rows on screen. Nothing is queried again.
- **Profile:** each column of the result, over every row the query returns (`SUMMARIZE`).
- **Export…** writes every row to a CSV, Parquet or Excel file. The engine writes it, through VS Code's
  save dialog. SQL typed by hand still cannot `COPY`.

## Semantic models

**A Power BI semantic model is a Fabric item.** It is not in OneLake: its list and its definition come
from the Fabric REST API ([`core/models/fabric.js`](../core/models/fabric.js)). In SQL it is a **semantic view**, named
`<workspace>.<model>_semanticmodel` and listed by `SHOW ALL TABLES` with the rest of the catalog. Every
workspace has one model of a name.

**Opening one**
- **From the tree:** a click reads its TMSL definition (the REST API's `getDefinition`) and keeps it as
  Apache Ossie (dax-sql's `tmslToOssie`) in the cache folder, at `models/<account>/<workspace>/<model>.ossie.yaml`
  (named as Ossie's own tools name a model; a copy an earlier version named `<model>.yaml` is renamed, its view with it),
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
- **A model over a SQL endpoint is read from OneLake too** ([`core/models/sqlendpoint.js`](../core/models/sqlendpoint.js)). Its
  expression names the endpoint, and the local copy holds the OneLake URL of the item behind it instead, so nothing
  connects to the endpoint and it works offline as any model does. The endpoint's workspace is in its host name, and a
  lakehouse or mirrored database says which endpoint is its own.
- **An endpoint Fabric doesn't show** is deleted or isn't yours to see, which look alike. If it is in the model's own
  workspace, its tables are read from there when exactly one item holds them all, and a message says so. Otherwise it is
  refused: tables of the same name in another workspace are other tables.
- **The local copy is the cache.** Later clicks open it without asking Fabric, and the tree marks the
  model with a check. The command line reads and writes the same copies. **Refresh** on the
  workspace or its Semantic models reads each downloaded model from Fabric again, behind, and replaces its copy; one
  that can't be read keeps its copy, and the log says why.
- **Every model opened is remembered** as a pointer (name, file path, when) in the account's catalog file
  ([`core/models/semviews.js`](../core/models/semviews.js)), so it survives a restart. **Clear Cached OneLake Data** takes it, with the
  local copy.
- **Permissions:** reading a definition needs Contributor or above on the workspace, or write on the
  model.

**Reading one.** A Direct Lake table is read from the lakehouse its model names, whichever item is
selected, and only when a query actually reads it. A model's query can be a subquery or CTE inside
SQL of your own.

```sql
SELECT dim_region.Region, AGG("Registered MW") AS mw FROM aemo.nem_semanticmodel GROUP BY ALL;
```

**Describing one.** These statements are dax-sql's (`createViews()`). Only those that read are taken.

```sql
SHOW SEMANTIC VIEWS;
SHOW SEMANTIC DIMENSIONS IN ws.sales_semanticmodel [FOR METRIC m];
SHOW SEMANTIC METRICS IN ws.sales_semanticmodel;
DESCRIBE ws.sales_semanticmodel;
SELECT * FROM (SHOW SEMANTIC METRICS IN ws.sales_semanticmodel) WHERE ...;
```

**A model file is a file.** A `.bim` under `Files/`, or an [Apache Ossie](https://github.com/apache/ossie)
`.yaml` or `.yml` whose top level has `version:` and `datasets:`, opens in the model view in place of
the SQL box. dax-sql's `formats/ossie.js` turns Ossie into the `.bim` it stands for, metrics in DAX or in
Ossie's SQL alike, and from there the two are one. These files can be stored anywhere and have no model name. A model created from one, for
Fabric or only for a Fabric app, must be named `<workspace>.<model>_semanticmodel`, and it overwrites
whatever we have under that name. See [NAMING.md](NAMING.md#files).

**`serve <file>`** reads a model file on this computer ([`core/models/models.js`](../core/models/models.js) `modelFile`). Its
tables are OneLake's. A Direct Lake expression says their workspace. Tables named `<lakehouse>.<schema>.<table>` are
in the model's workspace, which the file doesn't say: the one it was served in before, while that workspace still
holds those lakehouses, else `--workspace`, and the error names the workspaces whose kept listing holds them.

## Explore

A semantic model opens as **Explore** ([`page/explore/`](../page/explore/)), on three pages: Model, Visual and Report
(Visual is the `pivot` page in the code). It opens on Model. The Fabric app is its Report alone.
- **The bar** holds the page tabs, then each page's own: Model's Keep offline at the left, its Diagram | YAML, Create
  Semantic Model (a model file only) and Open in Excel at the right; Visual's Show plan, Download CSV and Add to report; the Report's Add text and Export to Fabric.

- **Model:** its tables as a star, dimensions in the middle and facts around them, with its
  relationships. Click a table for its columns, measures (with their DAX) and relationships. Double-click it, or its
  panel's Open table, for the OneLake table behind it in a tab of its own, as the tree opens it (`host.openTable`, by
  its SQL name, placed in the tree's kept listings by `place` in [`core/sqltables.js`](../core/sqltables.js)).
- **Visual:** drag columns onto Rows, Columns and Filters and measures onto Values, drawn as a pivot or
  a chart.
  - It is as tall as the tab, in flat panes: the fields; then the tools (swap, sort, totals, clear, Format) over the
    Filters card and the Show as card, which holds the mark and Values; then Columns and Rows over the view; and a status
    line under them all, with the row count and Top. A pill is plain for a column and in the measure's colour for a
    figure (a measure, or a column summarised). The mark is picked from a list under its button,
    which says what Automatic picked. An empty view shows where Columns and Rows go, and takes a drop there.
  - A column dropped on Values is summarised, as in Power BI: a number is summed and anything else
    counted, and its chip switches to average, min, max, count or distinct count.
  - Totals are off until turned on, and a view cut at the row limit (maxResultRows) leaves them out.
  - Every view is one `SELECT … FROM <model>` in dax-sql's SQL (`modelSql`): columns, `AGG("measure")`,
    summarised columns and `ROLLUP` totals. Its query is always generated from the shelves: nothing else writes a
    Visual's or a Report tile's SQL.
  - **Top** keeps the first n rows as they are sorted, ties kept (`FETCH FIRST n ROWS WITH TIES`; picking one sorts by
    the first measure, largest first, when the sort was by fields). A measure dropped on Filters filters the figures
    shown: a range of them, a `HAVING` (by its name when it is on Values, else as `AGG("measure")`).
  - **Treemap**, **Calendar** and **Map** are marks too (`pivotChart`): a treemap's levels are Rows (one or two), its
    size the first measure; a calendar is a date column on Rows, a strip a year, each day coloured by the first
    measure; a map is a latitude, a longitude and a name on Rows, each point sized by the first measure and coloured by
    a column on Columns, over the world's outline (ECharts 4's `world.json`, vendored and pinned like ECharts, read the
    first time a map is drawn: `ctx.worldMap`).
  - Visual has no SQL box: its query is its shelves' (a JSON visual query, kept as the shelves), and the SQL is made
    from it behind the scenes. Nobody, a person or an agent, writes SQL into a Visual or a Report tile.
  - **Slicer** is a mark like the others (`slicerView`): the values of the first Rows field, those the query answers
    (with a measure on Values, only those with a figure, shown beside each; a filter narrows them too), drawn as a list,
    buttons, a dropdown of the list, or a range for a date or a number, picked by a switch over it (`state.slicer`). On
    Visual it only shows; on the Report it filters. A table's Visual has no Slicer: it only builds SQL.
  - **Card** is a mark too (`cardView`): each field on Values as one figure, in its format string, over every row its
    filters keep. Its query leaves Columns out (`buildQuery`); a field on Rows (a date) is its trend, a line under the
    figure, and the figure is then the query's total row. Automatic picks it when only Values has fields. On the Report
    the other tiles' picks filter it, a click on it picks nothing, and its format can show a second measure as its change
    (▲ or ▼, coloured good or bad).
  - **Format** opens a pane at the right of the view: how the Visual is drawn, kept with its shelves as their
    `format` ([`format.js`](../page/explore/format.js)), so a Report tile made from it, or edited with ✎, draws the same.
    What it offers follows the mark: a chart's series colours, data labels, legend, axis titles and value range, its
    measures in one plot (each a bar, a line, an area or a dashed line, on the left axis or the right), each measure's
    total as a line (`totalLine`: the query asks for its totals), the highest point labelled, a zoom slider; a
    table's colours by value (a tint, or a bar) and banded rows; a card's figures' size and colour and a measure as its
    change (▲/▼, good when it goes `goodWhen`); and each number's style (`NUMBER_STYLES`, each a format string:
    `#,##0.0a` writes 1.2K, `0%` a percent). A change is drawn at once from the rows there are (`formatChart` over a
    chart's ECharts option, the rest through `formatLook` into Visual's own drawing); the total line runs the query
    again. A tile from before kept its format on the tile: it is read as its Visual's (`tileOf` in
    [`report.js`](../page/explore/report.js)), and the first save writes it there.
  - **Show plan** puts, in place of the view, the profile of the shelves' query (`profile.js`: DuckDB's `EXPLAIN ANALYZE` as totals, a timeline and the
    costly operators) next to its plan tree.
  - **Add to report** puts the view on the Report, as a tile (Report, below).
- **Report:** pages of tiles, each tile a Visual (`pivot`, its shelves) or text, drawn as Visual draws it or as
  Markdown ([`report.js`](../page/explore/report.js)). No tile holds SQL: a tile's query is Visual's, from its shelves.
  A tile of an older report that holds SQL (`kpi`, `bar`, `line`, `table`) says it is not a Visual tile, to be built
  again in Visual. A tile that fails says so in its box, and the rest still draw.
  - **Filter bar:** the report's `filters` (`[{ field, style }]`), over the pages' names on every page (`drawBar` in
    [`view.js`](../page/explore/view.js)): a dropdown of one value, a list to tick (searched, 150 shown), or dates from
    and to with 3d, 7d, 30d, 1y and All back from the latest day the column has. A filter's values are a query of their
    own, as the Filters shelf lists them (`valuesSql`). What is picked is a condition of every tile's query
    (`ctx.where`), but those that do not follow it (a tile's `ignore`, set in the Theme pane); a pick draws
    every page again, and the picks in its tiles go. The viewer's picks are this visit's only. Studio's + Filter adds
    one (a column and its style) and a filter's ✕ takes it out, saved like every other edit.
  - **Pages:** the report is `{ pages: [{ name, tiles }] }`; one written before pages, `{ tiles }`, is one page, Page 1
    (`reportPages`), and the first save writes it as pages (`withPages`). Their names sit over the tiles and one page is
    on screen (`reportAt` in [`view.js`](../page/explore/view.js)); each page is drawn the first time it is shown and kept,
    hidden, with its picks, until the Report is drawn again. Its tiles wait while it is not on screen, and a tile running
    on a page left is stopped and runs again when it is back. A click on a name shows it, a double-click renames it,
    dragged onto another name it moves there, its ✕ deletes it (a page with tiles asks first; the last page has none),
    and + adds Page n after the others, its name ready to rename. A tile's grip dropped on another page's name moves the
    tile to the end of that page, as big as it was. Add to report and Add text add to the page on screen. The Fabric
    app's Report shows the names only with two pages or more, and only to switch.
  - **While a tile runs again** (a pick, the filter bar): it keeps what it shows, dimmed (`rp-stale`), until its
    new answer is drawn. A chart is drawn over, not made again, so its bars and lines move to their new values. Only a
    tile with nothing drawn yet says Waiting… or Running….
  - **Over the tiles:** the report's `title` (a double-click writes it) and the time every tile last had its
    answer (`drawTop` in [`view.js`](../page/explore/view.js), told by the page's `done`). A tile has a `title`
    and, under it, a `subtitle`: a double-click on either edits both.
  - **Text:** `{ title, kind: 'text', text }`, `text` a few lines of Markdown (`markdownBlocks`: `#` to `###`
    headings, `**bold**`, `*italic*`, http(s) links, `-` lists, paragraphs), built as elements, never as HTML. A
    double-click edits it in a box in place, kept by Done or Ctrl+Enter. Picks don't touch it.
  - **Theme:** the Report bar's **Theme** opens a pane at the right of the tiles (`drawTheme` in
    [`view.js`](../page/explore/view.js); over them on a narrow window). It writes the report's `theme`: `style`
    (`STYLES` in [`theme.js`](../page/explore/theme.js): Paper, Midnight or Slate, the whole look at once, a class on
    the report's page that sets its colours, its tiles' corners and its titles' font, with its own palette and its
    charts' extras, `styleChart`; left out, Studio), `background` (for a report with no style: the Report's own dark
    or light colours, on its page and in its charts, in any editor theme; left out, the editor's), `palette`
    (`PALETTES` in [`theme.js`](../page/explore/theme.js)), `textSize`, and `colors`, a colour by value (a column's
    values, picked in the pane) that every tile draws that value in: a series, a bar, a treemap's box, a map's points. A
    Visual's own colours win over it. Under it, each tile of the page on screen: its title shown or not
    (`showTitle`) and its size (`titleSize`), and the filter bar's filters it follows (`ignore` lists those it does
    not). Each change is saved, and the page drawn again. A tile's look is its Visual's (Format, above), edited by ✎.
  - **Which tiles:** the model's Export to Fabric zip's `site/report.json`, when it has one (the zip its last export was
    approved into); else the file Studio keeps for the model until its first export (`<storage>/reports/`, by its
    workspace and name); else none: a Report starts empty. The first export writes Studio's file, or no tiles, into
    the zip, and the file goes.
  - **Add to report, ✕ and the grip:** Visual's **Add to report** puts the shelves on screen after the tiles, as a
    `pivot` tile (a slicer too); a tile's ✕ takes it out, and its grip ⠿ drags it anywhere on the grid and its ◢ drags its size (or the arrow keys, on
    either), drawn there at once with nothing run again. ⧉ adds a copy after the tiles, as big as the tile, in the first
    place it fits, and a double-click on a title renames it in place. A tile's tools show only while the pointer or the
    keyboard is on it. All write where the tiles are kept, one save after another (`reportSave` in
    [`fabric_app/export/exportflow.js`](../fabric_app/export/exportflow.js)), over the tiles they were drawn from: a report that changed since (an
    edit to its file) is refused and drawn again. The pages' +, ✕, renames and moves save the same way. The Fabric app's
    Report only reads, so it has none of them.
  - **Editing a tile:** a pivot tile's ✎ opens its shelves in Visual (`editTile` in [`view.js`](../page/explore/view.js)),
    under a strip with its title, **Update tile** and **Cancel**. Update writes the shelves and the title into that tile,
    its layout kept; a title that was its shelves' own follows the new ones. Either way Visual's shelves from before come
    back, and the Report is on screen again. Add to report still adds a new tile from there.
  - **Drawn again** when the zip changes, while the tab is on screen: a person or an agent edits the report and sees it.
  - A tile is `{ title, kind: 'pivot', pivot, layout?, wide?, showTitle?, titleSize?, ignore? }`, `pivot` the shelves as Visual keeps them; its SQL
    is Visual's (`pivotQuery`), and it is drawn by Visual's own code (`pivotView` in [`explore.js`](../page/explore/explore.js)),
    so it keeps every mark. A slicer is a `pivot` tile whose mark is `slicer` (Visual, above). The tiles are laid out on 12 columns and rows of 10px:
    `layout` (`{ x, y, w, h }`) is where a tile's grip and ◢ put it. `arrange` places them: the tile moved stays where
    it is put, every other tile floats up as far as it can and down past what it would overlap, and then all float up
    once more, so a gap under a short tile is filled. A tile with no layout goes in the first place it fits, as big as
    its kind is (a slicer 3 columns, a chart 6, figures and tables 12). The tiles are kept top to bottom.
  - **Cross filtering:** a click on a bar, a point, a row or a day picks the tile's first Rows field's value (else
    Columns'; a map's, its points' name), and every other tile runs again with it as a condition of its own query, as its
    Filters shelf writes one (`pickWhere`, then `sqlWith`: `= value`, `IS NULL` for a blank, the literal typed by the
    model's column). A slicer's pick is its values, `IN (…)` (`IS NULL` for a blank among them), or its range, `>=` and
    `<=` (a date's last day kept whole); it does not run again when other picks change. The tile clicked stays whole, its pick bright and the rest dim. The same click
    again, or the pick's ✕ in the bar above the tiles, clears it; picks in several tiles all apply. A card takes no
    clicks, nor does a treemap (a click zooms into its box). The tiles still run one at a time (in a Fabric app, side by side: its engines take a query each), and a pick stops the tile running when it changes it. A pick filters only
    the tiles of its own page.

`view.js` is host-neutral: the host passes in the compiler, how to run SQL, and where ECharts comes
from. **A tab** runs it on the native engine. **The Fabric app** runs the
same files on DuckDB-WASM. Its page ([`fabric_app/site/index.html`](../fabric_app/site/index.html)) names the model in
its header and is black, always; the chrome is the text's colour, and colour is for the data.

## SQL writes

A statement in the SQL box or the command line's `sql` can write to a lakehouse, and to nothing else
([`core/sql.js`](../core/sql.js) `writeOf` and `checkPlan`, [`core/engine/engine-host.js`](../core/engine/engine-host.js)
`runWrite`). There is no dialog: running it is the consent.

| Statement | Where it writes |
| --- | --- |
| `CREATE TABLE … (…)`, `CREATE TABLE … AS …`, `INSERT INTO`, `UPDATE`, `DELETE`, `MERGE INTO`, `ALTER TABLE` | A lakehouse table, as Iceberg |
| `CREATE SCHEMA` | A lakehouse with schemas |
| `COPY (…) TO '<ws>.<lh>/Files/<path>'` | A file in its `Files/`: Parquet, CSV or JSON |

- **The names:** a table is `<ws>.<lh>.<schema>.<table>` ([NAMING.md](NAMING.md#a-writes-target)), and a
  schema is `<ws>.<lh>.<schema>`.
- **What is refused, before anything runs:** `DROP` of anything, for now; what DuckDB's Iceberg writer doesn't have
  (`CREATE OR REPLACE`, `INSERT OR REPLACE`, `ON CONFLICT`, `TRUNCATE`, `COPY … FROM`); a view, a macro, a secret or any
  other `CREATE`; a temporary table; a table that is Delta in OneLake, whose Iceberg face is read only; a warehouse, a
  SQL or mirrored database; a name of the engine's own (`lake`, `system_internal`, …); and a `COPY` to
  anywhere but a lakehouse's `Files/`. What OneLake's catalog itself turns down fails with its own error.
- **How a table is written:** DuckDB writes Iceberg only through a catalog. So the host attaches the lakehouse's
  Iceberg REST catalog (`https://onelake.table.fabric.microsoft.com/iceberg`, the warehouse `<workspace>/<item>`) in the
  server, for that one statement, under a name of its own (`ice_` and 16 hex digits), and detaches it after: nothing
  stays attached for a listing to find, and two statements never share one. The options are those OneLake takes: no
  vended credentials and no staged create. DuckDB writes the data files with the storage secret, where the catalog puts
  them: `abfs://<workspace GUID>@onelake…/<item GUID>/Tables/…`. Nothing names that GUID but a table's own metadata, so
  it is read off a table of the workspace the store keeps, and the secret's scope gets it (`lakehouseOf` in
  [`core/sqltables.js`](../core/sqltables.js)). A workspace with no table yet has the name's scope alone. The token is an Iceberg secret's, as an `ATTACH`'s `TOKEN` shows in `duckdb_databases()`. The write's
  target is named as that catalog's table, as a file's name is given its URL, and the statement's reads go through the
  lake as any read does. No statement may name such a catalog itself.
- **Checked by DuckDB, then run.** The statement's text says what it writes and where (`writeOf`). Then DuckDB's own
  plan of it, as it will run (`json_serialize_plan`, bound in the server against the real catalogs), must agree: the
  kind of statement (`LOGICAL_INSERT`, `LOGICAL_CREATE_TABLE`, …), and the catalog it writes, which must be the one
  attached for it, or for a `COPY` the file's URL (`checkPlan`). An `UPDATE`, a `DELETE` or a `MERGE` on an Iceberg
  table has no bound plan DuckDB can write as JSON (its scan of the table has no serialization), and is held to its
  physical plan instead (`EXPLAIN (FORMAT json)`, `checkPhysical`): DuckDB-Iceberg's own `ICEBERG_UPDATE` or
  `ICEBERG_DELETE`, or a `MERGE_INTO` whose every write is one of those or `ICEBERG_INSERT`, and no other write
  anywhere in it. Which Iceberg table it is, the text alone says: no statement may name a write's catalog, so the only
  one it binds is the one named in it here. Being wrong about the text writes nowhere else.
- **Each statement is its own commit.** A write is never sent twice: a failure is said, not retried.
- **Afterwards:** the lakehouse's table listing is read again, and a table's new snapshot is synced into the lake, so
  the tree and the next read show it. After a `COPY`, its folder is listed again.
- **Offline:** a write is refused at once. It needs a connection, as Export does.

## Opening files from disk

A model file, an app's file or a `.sql` file on this machine opens in a tab, as one from the tree does (`openPath` in
[`extension/extension.js`](../extension/extension.js), the command `onelakeStudio.openPath`).
- **A `.sql` file** opens in the SQL box, not run, in a tab named after it, as a saved query does. A file open already
  brings its tab forward. **Save Query** keeps it under *Queries*, as any query. A `.sql` file in a lakehouse's `Files/`
  opens in the box the same way, from the tree.
- **A model file**, a `.bim`, or a `.yaml`/`.yml` that is an Ossie model (a top-level `version:` and `datasets:`): its
  model, its tables OneLake's by the names in it, in the workspace that holds them (`modelFile` in
  [`core/models/models.js`](../core/models/models.js)). One whose tables more than one workspace could hold says so, and is opened from
  its lakehouse's `Files/` instead. Another YAML is a document, and says it is not a model.
- **An app's file**, `.fabricapp` (`openApp` in [`fabric_app/export/exportflow.js`](../fabric_app/export/exportflow.js)): on the Report page, which
  draws this file; its Add to report writes here, and its next export saves here. A semantic model's app opens that
  model, as the tree's click does. A client-side app opens on its own `model.ossie.yaml`, the app as it is, and Export to
  Fabric there publishes this file as it is: no Save dialog, and no question about its changes.
- **A file named `<name>.ossie.yaml`** is a model by its name: the Apache Ossie spec names no extension, and Ossie's own
  tools (its compliance suite and grader) name a model `*.ossie.yaml`. Studio's own copies are named so too.
- **In VS Code**, a `.fabricapp`, a `*.ossie.yaml` and a `.sql` file open in OneLake Studio by default (custom editors
  that hand them over and close their own tab; *Reopen Editor With… > Text Editor* shows the text). None of them is a
  text editor, so no SQL extension starts for a `.sql` file. When the desktop app is installed,
  they open in the app: the editor finds it by the key its installer writes (`OneLakeStudio.Model`'s open command) and
  starts it with the file. Without the app, or if it fails to start, they open in the extension. This matters for a
  Windows double-click on a `*.ossie.yaml`: Windows goes by the last extension only, `.yaml`, whose default is often
  VS Code. A `.bim` or an Ossie `.yaml` opens as text, with **Open in OneLake Studio** on the editor's title bar, by
  what the file holds (`onelakeStudio.modelPaths`), so other YAML has none; Explorer's right-click offers it on a
  `.yaml`, `.yml`, `.bim` or `.fabricapp`.
- **In the desktop app**, File › Open… (Ctrl+O); a double-click on a `.fabricapp`, whose default app it is; and
  Windows' "Open with" on a `.yaml`, `.yml` or `.bim`, which lists it without becoming their default (the installer,
  [`desktop/src-tauri/hooks.nsh`](../desktop/src-tauri/hooks.nsh)). A file the app is started with reaches the Node
  process as a line on its stdin, `{"open":"<path>"}`, also when the app is already running (its single instance).
  Windows lets only the person make the app `.yaml`'s default (*Open with › Choose another app › Always*), and a
  double-click on a `*.ossie.yaml` then opens straight in the app, with no stop in VS Code. Any YAML then starts
  the app's exe, which reads it before a window shows: a model (`*.ossie.yaml`, or a top-level `version:` and
  `datasets:`) opens in the app, and any other YAML goes on to the program that opened it before, VS Code first
  among `.yaml`'s other "Open with" programs, else Windows' own Open with dialog (`open_elsewhere` in
  [`desktop/src-tauri/src/main.rs`](../desktop/src-tauri/src/main.rs)).
  A file dropped on the window is not opened: the window gets no path for it.

## Create Semantic Model

A `.bim` or Ossie `.yaml` in a lakehouse's `Files/` has a ⛁ in the tree (`modelFile`, [`extension/tree.js`](../extension/tree.js)), and
the same button on Explore's Model page when it is open there (`fabric.createSemanticModel`, [`core/host.js`](../core/host.js)):
**Create Semantic Model** makes the Power BI semantic model of it, named for the file, in the file's workspace, on Direct
Lake (refreshed once made) or DirectQuery (its SQL endpoint signed in to by SSO) (`createSemanticModel` in
[`fabric_app/export/exportflow.js`](../fabric_app/export/exportflow.js)), and nothing else: no app, no zip, no Report. One dialog asks which: its
buttons are the two modes, and it says the workspace, the file, and whether a model of that name is there, whose
definition is then replaced (*Update the semantic model …?*). The definition is TMSL made from the file
([`fabric_app/export/pbimodel.js`](../fabric_app/export/pbimodel.js)), written over the Fabric API ([`fabric_app/export/fabricmodel.js`](../fabric_app/export/fabricmodel.js)).
Direct Lake takes no calculated column: a model with one is refused before anything is written, and the message says to
make it DirectQuery. The workspace's semantic models are listed again after. The command line's
`semanticmodel <ws> <item> <Files/path> --mode directlake|directquery` (Direct Lake without it) asks nothing for a new
model, and waits for an OK in VS Code before it replaces one. Needs a connection, as Export does. An app on it is that
semantic model's Export to Fabric, as it is.

## Export to Fabric

One of two writes, with Upload (above). The Report's **Export to Fabric** button, or the command line's `export`, publishes
the model's Report as a Fabric app, and nothing else of Explore (item type `AppBackend`, named
`<model>-explore`). VS Code and the extension are all it needs: no CLI, no Node, no GitHub.

**The local copy is one file**, `<model>.fabricapp`, a zip with an extension of its own (as a `.vsix` is), so
VS Code and the desktop app open it (Opening files from disk, below). It is the whole app but its packages (DuckDB-WASM,
Arrow, the Rayfin SDK, ECharts), which are the extension's own and are added when it publishes, so the file is a few MB.
It holds `site/`, `rayfin/`, `AGENTS.md` and `export.json`, the record of what was published, and a client-side app's
model. Its report, `site/report.json`, is the Report tab's (Explore, above). No export writes that entry again, and it
is not one of the local changes an export asks about, so a person or an agent grows it in the file and exports again to
publish it. The Save dialog first offers the model file's own name, its model extension (`.ossie.yaml`, `.yaml`, `.bim`)
made `.fabricapp`: `sales.ossie.yaml` is `sales.fabricapp`, and a semantic model's app is `<model name>.fabricapp`. After
that it offers where the app was saved last. The app's name in Fabric is still `<model>-explore`. One an earlier
export saved as `<model>-explore.zip` is offered under its new name, and renamed when saved there.

**The app runs on the model as exported**, never on the lakehouse's file as it is now:
- **Client side**, the file holds its model, `model.ossie.yaml` (`model.bim` for a .bim; `model.yaml` from an earlier export still reads), and each publish makes the site's
  `model.json` from it, which the page reads. The function never reads a model: the export gives it the tables it may
  sign for (its `TABLES` secret). An export from Explore rewrites `model.ossie.yaml` from Explore's model; an agent's edit to
  it is published by opening the `.fabricapp` and exporting there. A change to the lakehouse's file reaches the app
  when it is exported again.
- **On a semantic model**, the file holds no model of its own: `export.json` names the semantic model
  (`semanticModel: { workspace, id, name }`), and the site's `model.json` is its local copy, which the page writes its
  DAX from.

**A Power BI semantic model** opened from the tree is exported as it is: the app queries that model, Direct Lake,
DirectQuery or Import, whatever it reads, and nothing is written to the model or for it: no definition, no refresh, no file in a lakehouse. The app goes in the
model's workspace, and the model needs to name no lakehouse.

**A model file** (a `.bim` or Ossie `.yaml` in a lakehouse's `Files/`) is exported client side: DuckDB in the browser
reads its lakehouse's tables, and no semantic model is made. A model file opened from disk (a download, say) is
exported the same way, in the workspace its tables are in, when it names one lakehouse: the app carries its own copy,
so no OneLake path is needed, and `export.json` names it `<workspace>/<file name>`. An app on a semantic model of the file is two steps:
Create Semantic Model (above), then Export to Fabric on that model.

What the app runs on is what was opened, so nothing is asked about it: the button goes straight to the questions below,
and the command line's `export` takes no `--mode`.

**What it writes**
- **The app**, in Fabric.
- **A local copy of the app**, one file, `<model>.fabricapp`, where you save it. An earlier export's
  `<model>-explore/` folder is no longer written; the app it published stays the zip's.

**What a model file needs** (a semantic model exported as it is needs none of it)
- **It names exactly one lakehouse** in its Direct Lake expression. Without that, the button is not
  shown.
- **Every table names its source as `schema.table`**, with a table name of letters, digits and `_`.
- **The workspace allows OneLake user-delegated SAS tokens.**

**How it behaves**
- **It asks one thing: where to save the app.** A Save dialog named for it, opened where this app was saved last, else
  in Documents; *Export* there exports, and saving over the file is the dialog's own question. The other questions
  come only when one applies (below), and all of them before anything is written, locally or in Fabric.
- **Protected:** the site loads only for people who may open the app item.
- **The app reads the model's tables, not the lakehouse:** its function signs a read-only SAS for each table the model
  names, and refuses any other.
- **Client side, the tables are read as the app's owner.** Fabric Apps gives a function one identity, the app item's
  owner, and no way to the viewer's own OneLake token. So anyone who may open the app reads the model's tables with
  the owner's rights. On a semantic model it is the other way round (below).
- **No silent takeover:** a re-export updates the item the last export created (its id is kept in the
  local copy, as soon as the item exists). If an app of that name exists and no export created it, the export asks.
- **Saving over the file rewrites it**, from this Explore, its report kept: nothing is asked about what changed in it.
  An edit made in the file (by a person or an agent) is published by opening the `.fabricapp` and exporting there,
  which publishes it as it is.
- **`site/engine.json` is in every site**, `{ engine: 'duckdb' }` or `{ engine: 'semanticModel', name }`: the hosting
  answers a file a site lacks with its `index.html`, so the page reads its JSON files as missing when they aren't JSON.
- **A name in the recycle bin:** a deleted app keeps its name there, and Fabric refuses a new app of that name. The
  export says so: delete it there for good, or restore it, and export again.
- **A newer deploy is never overwritten unasked.** `export.json` keeps the app's last deploy time, by
  Fabric's clock. If the app was deployed again since, the export asks.
- **A folder the export did not write** is refused.

**On a semantic model** the app runs no DuckDB, in the browser or anywhere.
- **The queries run as the viewer**, as [Fabric Apps' connectors page](https://learn.microsoft.com/en-us/fabric/apps/connectors)
  says a semantic model is read: "Semantic models support delegated authentication only", and "Don't configure
  application authentication for a semantic model". Functions get no token for one ("A Power BI semantic model isn't
  available through ctx.Tokens. Use the fabric-semanticmodel connector instead",
  [Connect Functions to external resources](https://learn.microsoft.com/en-us/fabric/apps/functions-connect-external-resources)).
  So the page queries the model through the app's `fabric-semanticmodel` connector. The export declares it in the app's settings
  (`model`, with the semantic model's workspace and id, [`fabric_app/export/fabricapp.js`](../fabric_app/export/fabricapp.js)), and writes it into
  the local copy's `rayfin.yml`. The function has no token for the model and runs no query.
- **The page** ([`storage/modeldata.js`](../fabric_app/site/storage/modeldata.js), chosen by `site/engine.json`) turns
  Explore's query over the model into DAX with dax-sql's `sqlToDax` (the copy in `site/semantic/`), runs it through the
  connector (Rayfin's `ConnectorsRayfinClient` and the connector's own runtime, which decodes its Arrow answer), and
  draws the rows. It takes only a SELECT over the model. Its Show plan has no plan tree: its SQL tab is the DAX, and its
  profile the query's one run.
- **The page's model is the semantic model's local copy:** `site/model.json`, written by the export, and again by a
  publish of the file as it is: the definition Fabric gave when it was opened (or Refreshed), which the page writes its DAX from. A
  change to the semantic model reaches the app when it is exported again.
- **Rows are cut on the semantic model** ([`storage/modelrows.js`](../fabric_app/site/storage/modelrows.js)): a
  preview's rows, and a LIMIT and OFFSET, are a `TOPN` in the DAX, and a count is `COUNTROWS`, so neither waits for
  the whole answer. executeQueries sends at most 100,000 rows or 1,000,000 values in one answer, and the page keeps at
  most 100,000 rows: an answer cut by either says so, as the client-side app's does.
- **No function of ours** ([`function_app.ts`](../fabric_app/rayfin/functions/src/function_app.ts)) is deployed, and
  no secret set: the page reads `site/model.json` and the semantic model, nothing else. The app's one function is the
  connector's, `<app>_connector`, which Fabric makes for it. An app first published with ours keeps it.
- **What it needs:** each viewer has Read on the semantic model, and the tenant has the Semantic Model
  Execute Queries REST API setting on ([the data app template's prerequisites](https://learn.microsoft.com/en-us/fabric/apps/data-apps-template)).
  A viewer the model refuses gets one box over the page: *You can't read the semantic model `<name>`. Ask its owner for
  access to it, then reload.* The name is the one the export wrote into `site/engine.json`.
  Build is needed to publish the app, not to view it. The connectors page says "Semantic model queries require the
  caller's applicable model permissions, including Build", and Fabric checks it on whoever publishes (the CI identity was
  refused with "Could not verify Build permission on semantic model"). But a viewer needs only Read: tried on 2026-11-11 with an account that
  was a workspace Viewer, Read on the model and no Build, the app's connector answered its DAX query.
- `site/` holds no DuckDB, extensions, DuckDB's Arrow or browser data source, and no SAS is signed: the workspace
  setting for user-delegated SAS tokens isn't needed.

**The template** ([`fabric_app/`](../fabric_app/))
- **`site/`:** the page, black always. Its data source (`storage/`) signs in with Rayfin's Fabric SSO,
  takes the model and the tables' locations from the app's function with a read-only SAS per table, and downloads
  what the Report reads of the tables into the browser, where DuckDB-WASM (DuckDB 2.0), shipped in the site's `vendor/`,
  reads them as `v_<table>` views. A table of 32 MB or less comes down whole. Of a larger one, only each file's footer
  and the columns a query names come down, before it runs ([`storage/ranges.js`](../fabric_app/site/storage/ranges.js)):
  each file's chunks of them are one request where they are less than 8 MB apart, since OneLake takes about 0.6 s per
  request whatever its size. Measured on 2026-11-10, a Report over 2 of 22 columns of a 4 GB table came down in
  12–19 s instead of 123 s. If DuckDB reads bytes the store lacks, the store says which, and the page downloads them with
  their columns and runs the query again.
  DuckDB-WASM runs one thread an engine, so the page starts several (half the machine's cores, two at least and four
  at most), and a query over a table of ten million rows or more is shared out between them
  ([`storage/split.js`](../fabric_app/site/storage/split.js)). dax-sql reads a fact table in a CTE of its own, a
  GROUP BY of keys and aggregates; each engine runs that CTE over its share of the table's files, the answers cross
  as Parquet (a few KB), and one engine adds them up and runs the rest of the statement. Only what adds up is
  shared out: sums, counts, minimums and maximums. A distinct count, an average, or a measure the compiler wrote as a
  subquery runs whole on one engine, as does any query whose sharing out fails. Measured on 2026-11-11 on a 3.6 GB
  table with four engines: 5.1 s to 1.2 s for a sum by a column. On a table of 4 million rows sharing out cost more than it saved, about
  0.1 s a query: hence the ten million. `?split=0` in the address runs every query whole.
- **`rayfin/`:** `rayfin.yml` and the function (`openCatalog`, for a client-side app).

[`fabric_app/export/exportapp.js`](../fabric_app/export/exportapp.js) writes the local copy from `fabric_app/`, Studio's
`page/explore/` and dax-sql, as one zip (`appFiles`, `writeApp`). What is uploaded is built in memory from it
(`buildDist`): `site/` stamped with the build, the packages from `vendor/webapp`, and `rayfin.config.json`, zipped
in-process.

**Publishing** ([`fabric_app/export/fabricapp.js`](../fabric_app/export/fabricapp.js)) is the REST sequence that `rayfin up` runs,
in the same order, with the user's Fabric-audience token:

1. Find the item, or create it.
2. Wait for its backend, then fetch the publishable key.
3. Apply the runtime settings, with the semantic model's connector on DirectQuery and Direct Lake.
4. Client side, set the `CATALOG_URL` and `TABLES` secrets.
5. Upload the site.
6. Deploy the function and poll it until it is done.
7. Add the hosting URL to the sign-in redirects.

The function's deploy package (an esbuild bundle plus its metadata) is built once, at package time, by
[`scripts/function-bundle.mjs`](../scripts/function-bundle.mjs) with Rayfin's own packager, from
`fabric_app/rayfin`. It ships in the vsix under `fabric-function/`.

## The desktop app

**The app is the extension.** Its Node process ([`desktop/node/main.js`](../desktop/node/main.js)) runs
[`extension/extension.js`](../extension/extension.js) as it is, bundled with `vscode` pointing at
[`desktop/node/vscode.js`](../desktop/node/vscode.js): the part of VS Code's API the extension uses, and no more. So every
command, menu, tab and message is the same code in both, and a change to the extension is a change to the app.

- **The window** ([`desktop/ui/`](../desktop/ui/)) draws what VS Code otherwise would: the tree, the tab strip, menus,
  dialogs, Go To, Settings and the status bar. What it shows comes from the extension and its `package.json`: the tree's
  nodes, the tabs' pages, the menus and their `when` clauses, the settings.
- **It behaves as a Windows app does**: a menu bar (File, View, Help, About), the tree put away with Ctrl+B or its
  button on the left, a tab's right-click (Close Others, Close All), Ctrl+Tab. A tab's page hands every key to the
  window first, so a shortcut works wherever the focus is, and the browser's own (F5, Ctrl+P, Ctrl+F) do nothing.
  The tree's width, whether it shows, and the zoom are kept in `window-state.json` in the data folder, not in the
  page's storage, whose origin's port is new each start.
- **The tree** has a tree's keys: up and down, Home and End, right to open a node and then to its first child, left
  to close it and then to its parent. A node opens at once and says Loading… until its listing answers. Moving the
  selection draws no row again.
- **Tabs:** closing the one on screen shows its neighbour. Ctrl+W or Ctrl+F4 closes it, the wheel moves the strip
  sideways, and a double-click on its empty part is a New Query. The keys go to the tab on screen, never to one left
  behind, and a dialog that closes gives them back to where they were. **Read Log** has one tab, shown again at its
  end.
- **Work that can be cancelled** (Upload Files…) has Cancel on its message: `withProgress`'s `cancellable`, and the
  click is the task's token (`progress.cancel`). A message that goes by itself stays while the pointer is on it.
- **Settings** draws a description's `code` and bold as elements. Help › Open Data Folder opens the data folder.
- **A tab** is the same page as the extension's, in an iframe, with `acquireVsCodeApi` and VS Code's theme variables given
  to it in its own CSP.
- **The connection** is an HTTP server on `127.0.0.1` ([`desktop/node/server.js`](../desktop/node/server.js)): messages out
  as server-sent events, back as POSTs. The first request's token becomes an `HttpOnly`, `SameSite=Strict` cookie, and
  anything without it, with another `Host` or another `Origin`, is refused. A tab's page is served from a second port,
  another origin: it reaches only its own files, can't reach into the window's page, and talks to the window by
  `postMessage`, as a webview does. The window's port refuses its requests, so only the window runs commands, changes
  settings or closes the app.
- **What needs Windows** ([`desktop/node/dialogs.js`](../desktop/node/dialogs.js)): the save and folder dialogs, the clipboard
  and Explorer, through PowerShell, as Open in Excel is.
- **Sign-in** is the command line's: MSAL as the Azure CLI's public client, with the token cache under DPAPI, and the same
  `signin` for both. No app registration.
- **The same data:** with VS Code on the machine, its folder for this extension, so the extension, the command line and the
  app read one cache. With none, `%LOCALAPPDATA%\OneLake Studio\data`. Settings are VS Code's where there are any, under
  what the app's Settings tab changes. Its engine is a server of its own, so it has a lake of its own, `lake-desktop`:
  with VS Code open too, both read OneLake tables, and each keeps its own copy of their files.
- **The shell** is Tauri ([`desktop/src-tauri/`](../desktop/src-tauri/)): it shows a splash, starts the Node process, and
  opens the page it names. Each line the process says after that is something only the shell can do: exit, zoom.
  Closing the window closes the process's stdin, and it ends; if the process ends first, the splash comes back with
  Restart. A second start shows the first window, and the window's size and place are kept. The installer is per user.
- **Updates:** at start, and on Help › Check for Updates, the latest release's tag is compared with this version
  ([`desktop/node/update.js`](../desktop/node/update.js)). A newer one is said in the status bar, with a link to the
  installer. Offline, nothing is said. The app downloads and installs nothing itself.
- **CI's `desktop` job** drives the window in Edge, which is what WebView2 is, on the real engine, then builds the
  installer, installs it and starts it once. Its screenshots and the installer are the run's artifacts.

## The command line and the agent skill

**[`cli/cli.mjs`](../cli/cli.mjs) is a doorbell first.** It hands its arguments to the running extension over a
local pipe or socket ([`cli/bridge.js`](../cli/bridge.js)). The extension answers
([`cli/agent.js`](../cli/agent.js)) with its own sign-in, cache, engine and compiler.

**With VS Code closed,** on Windows with Node 22.5 or later, the same answer comes from
[`cli/standalone.js`](../cli/standalone.js), which is [`core/core.js`](../core/core.js) with no editor around it:

- **Sign-in:** `signin` opens the browser, once, as the Azure CLI's public client through MSAL
  ([`core/msalsession.js`](../core/msalsession.js)). No app registration. A tenant's admin can block that client, and only
  this is affected: the extension's sign-in stays VS Code's. The token cache is encrypted for this Windows user
  with DPAPI ([`core/tokenstore.js`](../core/tokenstore.js)).
- **The same cache:** a session's account id is MSAL's `homeAccountId` in both, so one person has one account key, and the
  files are VS Code's for this extension. The tenant and the proxy come from VS Code's `settings.json`.
- **Its own engine:** VS Code's server has its session token in VS Code's secret storage, so this one is a server of its
  own, sharing the catalog and the log. The lake can be open in one process only, so it has a lake of its own,
  `lake-standalone`, beside VS Code's in the same cache folder. Its token is in a file in this user's profile, and opens a
  local port, no more.
- **Nothing stays running:** no sync and no idle job. The process ends with the answer, and its server a minute after.
- **Not here:** `export`, which asks for an OK in VS Code. Exit code 3 says so.

**`serve <model.yaml|.bim>`** is always that, as it stays running: Excel's endpoint ([Open in Excel](#open-in-excel)) on a
model file, with no VS Code. The model takes the name `<workspace>.<model>_semanticmodel`, from where its tables are and the
file's name, or `--workspace` and `--name`, as [NAMING.md](NAMING.md#files) says of a model made from a file. Excel's
PivotTables are its only client. **`--open`** opens a new workbook on it.

**The skill** is [`cli/SKILL.md`](../cli/SKILL.md). **Install Agent Skill** writes it to
`~/.claude/skills/onelake/`, where Claude Code and GitHub Copilot in VS Code (agent mode) look for
personal skills, and it follows the extension through updates.

`node cli/cli.mjs --help` is the full reference for commands and options. An agent should branch on:

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
- **`sql`** writes to a lakehouse as a tab does ([SQL writes](#sql-writes)), with nothing asked. Several statements run
  in turn: the first that fails stops them, and the last one's rows are the answer.
- **`export`** is the same code path as Explore's button, with the same questions asked in VS Code.

## Keep offline

**Keep offline**, a switch beside a semantic model's tabs, keeps every table the model reads on this machine and current,
so it answers from disk and with no connection ([`core/models/modeldata.js`](../core/models/modeldata.js)). Each table is kept
whole (`keepWhole`): its lake table synced to its latest snapshot, as the idle job does it, then every file of it still on
OneLake downloaded by the table service (`fetchTable`), as a statement's would be. A table counts as kept only once every
file has come down.

- **A background job, a client of the query server** (`engines.js backgroundEngine`), as a window is: the lake can be
  open in one process only. The downloads are the server's table service's (`lakeFetch` over the control pipe).
- **It was asked for,** so it differs from the idle job: it starts at once, with no two quiet minutes first, and has no
  time limit. The idle job holds off meanwhile, or the two would sync the same tables.
- **It stays on.** It's a row in the catalog per model, so it goes on with the tab closed and comes back with the next
  window. Each table's metadata is read past the cache every hour, and its lake table is synced when a new snapshot
  appears.
- **Every window shows the same.** What the switch says is worked out from the catalog (`table_kept`), and one window
  syncs: the one with the catalog's lease. Its statements are in **Logs**, a line per table.
- **Off stops it, and deletes nothing.** The files that came down stay, and switching on again carries on.
  Back on answers at once from what's kept, asking OneLake nothing: whether anything is newer is looked for behind it, on the hourly clock.
  What is kept goes as any table's files go.
- **More than the disk cache holds stays off** (`diskCacheMaxGB`), counting the other models kept offline, since it would
  evict itself. **Clear Cached OneLake Data** switches them all off.
- **A table that fails** is named beside the switch and tried again in an hour. With no connection it waits, and carries on.

**Download Tables for Offline** (the cloud icon on a lakehouse, a warehouse, a schema or a table in the tree) does the
same once, for every table under it, or the one table: each kept whole, with a notification counting them, and Cancel leaving what came down. Refused
when the tables are more than the disk cache.

## Open in Excel

**Open in Excel**, a button on a semantic model's Model page, opens a new workbook with a PivotTable live on the model,
on Windows and the Excel desktop app. Any model Explore opens has it, a local copy or a file in a lakehouse's
`Files/`: the model is found by its SQL name, through its kept view. It opens with no fields placed, whatever the
Visual's shelves hold. Excel's provider speaks XMLA over HTTP, so [`xmla/`](../xmla/) answers it from the window:

```
Excel (MSOLAP) --SOAP over http://127.0.0.1--> extension host
  Discover -> rowsets built from the model's TMSL
  Execute  -> MDX -> model SELECTs -> dax-sql -> the guard -> the server -> a cell set
```

- **A model is one cube.** A table is a dimension, a column an attribute hierarchy, a measure a member of `[Measures]`.
  What's hidden stays out, as in Power BI's field list ([`cube.js`](../xmla/cube.js)).
- **Not an MDX engine.** A PivotTable writes a narrow, regular subset, and [`mdx.js`](../xmla/mdx.js) reads only that:
  the statements captured from Excel are its tests. Anything else is refused by name, never guessed at. That covers
  calculated members written in Excel, Show Details, value and Top 10 filters, and "show items with no data".
- **One model SELECT per grain.** Totals and subtotals are computed by dax-sql at their own grain, not added up, so a
  distinct count or a ratio is right on every line ([`cellset.js`](../xmla/cellset.js)). The price is a query per
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
| **Open App**, **Open Table**, **Open File**, **Open Semantic Model** | A click in the tree. A double click counts as one ([`core/doubleclick.js`](../core/doubleclick.js)). |
| **Copy**, **Copy with Headers**, **Copy as CSV**, **Copy as Markdown**, **Copy as JSON**, **Open as CSV Document**, **Open as JSON Document** | The grid's right-click. |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `onelakeStudio.tenantId` | empty | Directory (tenant) GUID to sign in against. Empty is your home tenant. Set it to reach a tenant you are a guest in. |
| `onelakeStudio.catalogTtlMinutes` | 5 | How old a listing may be before it is refreshed. The last known answer is always served from disk first. |
| `onelakeStudio.tableMetadataTtlHours` | 24 | How old a table's Iceberg metadata may be before it is refreshed. **Refresh** on its lakehouse re-reads it at once. |
| `onelakeStudio.keepUsedTablesGB` | 10 | How big, by their files, the tables statements keep reading may be together for the idle job to sync them to each new snapshot, and how much of them may change in a day. It reads no rows. Never over half of `diskCacheMaxGB`. `0` turns it off, and their metadata is still read every hour. |
| `onelakeStudio.securedTableRead` | on | Reads a table whose files OneLake refuses you, because of OneLake security, through OneLake's table read API: the rows and columns your roles allow. Each read uses the workspace's capacity. Off, such a table fails. |
| `onelakeStudio.prefetchMetadata` | on | Reads every table's metadata in the background once a lakehouse's Tables node is opened, so the first click is a disk read. |
| `onelakeStudio.diskCacheMaxGB` | 256 | How much of the tables' files is kept on this machine, per account. `0` keeps none: every table is read from OneLake, through the lake. |
| `onelakeStudio.cacheDirectory` | empty | Where the disk cache is kept, as a full path. Empty is VS Code's storage for this extension. A new folder starts empty. |
| `onelakeStudio.engineMemoryLimit` | empty | Most memory DuckDB may use, e.g. `4GB`. Empty is DuckDB's default, 80% of the machine's RAM. |
| `onelakeStudio.engineThreads` | 0 | How many threads DuckDB may use. `0` is every core. |
| `onelakeStudio.engineSpillMaxGB` | 0 | How much a query bigger than memory may spill to the temp folder. `0` is DuckDB's default. |
| `onelakeStudio.logMaxGB` | 1 | How much of what the engine ran is kept for **Logs**, per account. `0` keeps none. |
| `onelakeStudio.selectTopRows` | 1000 | How many rows **Select Top Rows** asks for. |
| `onelakeStudio.maxResultRows` | 200,000 | The most rows of one result a tab and the command line keep, from 1,000 to 1,000,000. Past it, rows are only counted. |
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
- **A Visual's shelves are kept per tab,** so a model opened again in a new tab starts with empty shelves.
- **OneLake's table read API is in preview,** so how a table with OneLake security is read may change. It doesn't
  serve a table behind a shortcut to another region, and a very large table can fail with *Stream was too long*.
- **Requires desktop VS Code 1.101+** on Windows x64, or macOS or Linux on x64 or arm64, for its built-in SQLite. Windows on arm64 has no build of DuckDB's `delta`, so no package.

## Where the code is

One folder for each part. `core/` is what every part is built on, and loads no editor: only `core/core.js`,
which puts a window together, names another part ([`test/js/core-no-editor.test.mjs`](../test/js/core-no-editor.test.mjs)
holds both). The host's code ships bundled, with `@duckdb/node-api`, as `dist/extension.js`,
`dist/engine-server.js` and `dist/standalone.js`.

| Folder | What it holds |
| --- | --- |
| [`core/`](../core/) | What reads OneLake, with no editor. |
| [`extension/`](../extension/) | What is VS Code's. |
| [`page/`](../page/) | A tab's page, and Explore in `page/explore/`, shared with the Fabric app. |
| [`cli/`](../cli/) | The command line and the agent skill. |
| [`desktop/`](../desktop/) | The desktop app. |
| [`fabric_app/`](../fabric_app/) | Export to Fabric, and the app it exports. |
| [`xmla/`](../xmla/) | Excel's XMLA endpoint. |
| [`test/`](../test/), [`scripts/`](../scripts/), `docs/`, [`website/`](../website/), [`media/`](../media/) | Tests, packaging, these documents, the public website, icons. |

### core/

| File | What it holds |
| --- | --- |
| `core.js` | What a window builds that isn't about how it looks: the store, the catalog, the command line, Excel, and what happens when the account moves. |
| `host.js` | What a tab's page may ask over its channel. |
| `names.js` | What items hold tables, and how a table or model is named. |
| `sql.js` | The read-only guard, `tableRefs`, `SHOW` rewriting, and which hosts are OneLake's. |
| `sqltables.js` | A table's SQL name found in OneLake, and a model's GUIDs named. |
| `signin.js`, `settings.js` | When a session is asked for, and its tokens. What the settings mean. |
| `msalsession.js`, `tokenstore.js`, `home.js` | With no VS Code: a sign-in of its own, its token cache, and where the files and settings are. |
| `readlog.js`, `diaglog.js`, `logfile.js` | What a window says about its reads, its own log, and the log file. |
| `queries.js` | Saved queries on disk. |
| `title.js`, `doubleclick.js` | What the sidebar's header and a tab's title say. A double click counting as one click. |
| `vendored.js` | The one list of pinned third-party code the page runs, dax-sql included. |
| `crc32.js`, `diskuse.js` | A checksum. How much a folder holds. |
| `engine/engine-host.js` | The native DuckDB engine: what the server boots, and how a window prepares and runs a statement. |
| `engine/engine-server.js`, `engine/engine-client.js`, `engine/enginelog.js` | The server: its process, a window's side of it, and its log. |
| `engine/engines.js` | The engine this window reads with, the background engine, and the catalog files. |
| `engine/oldstate.js` | An older version's state file, brought over once. |
| `onelake/catalog.js`, `onelake/onelake.js`, `onelake/store.js` | OneLake requests, cache first, and the store. |
| `onelake/http.js`, `onelake/connectivity.js` | How the host asks OneLake and the Fabric API for anything. Whether this window is offline, and why. |
| `onelake/catalogfile.js`, `onelake/catalogtables.js`, `onelake/syncworker.js` | What is remembered, in SQLite, the catalog's tables there, and what keeps them current and looks after tables in use. |
| `lake/onelaketable.js` | A Delta or Iceberg table kept in the lake from its own metadata. |
| `lake/tableservice.js` | The files statements read, brought here as they are read, and let go when no snapshot names them. |
| `lake/tableread.js` | A table with OneLake security, read through OneLake's table read API and kept in the cache folder. |
| `lake/deltalog.js`, `lake/filecache.js` | A Delta table's own log, for Stats and History. An older cache folder, tidied once. |
| `models/fabric.js` | A workspace's semantic models and apps, and a model's definition. |
| `models/models.js`, `models/modeldata.js`, `models/semviews.js` | A model's local copy, Keep offline, and the models opened, per account. |
| `models/sqlendpoint.js` | A Direct Lake model over a SQL endpoint, pointed at the item behind it. |

### extension/

| File | What it holds |
| --- | --- |
| `extension.js` | Activation, commands, the tree's view, dialogs and the status bar. It hands the rest in. |
| `tree.js` | The explorer. |
| `panel.js`, `webview.js`, `html.js` | A tab's webview and its page. |
| `performance.js`, `logs.js` | The Performance and Logs tabs. |

### page/

| File | What it holds |
| --- | --- |
| `index.html`, `app.js` | A tab's page. |
| `data.js`, `host.js`, `vscode-api.js` | Tables and files asked of the host, over the page's side of the channel. |
| `grid.js`, `chart.js`, `dbview.js`, `docview.js` | The grid, the chart, a database file's view and a document's. |
| `querytext.js` | The SQL box's statements, error positions and variables. |
| `paths.js`, `semantic.js` | Names and paths, and semantic views. The command line loads these two as well. |
| `cdn.js` | Where the pinned third-party code is loaded from. |
| `explore/` | Explore: Model, Visual and Report. Copied into an exported Fabric app. |

### cli/

| File | What it holds |
| --- | --- |
| `cli.mjs` | The command line: what an agent runs. |
| `bridge.js`, `agent.js` | The pipe it asks the running app over, and the answers. |
| `standalone.js` | The command line with VS Code closed: `core.js` with no editor. |
| `skill.js`, `SKILL.md` | The agent skill, and what installs it. |

### desktop/

| Folder | What it holds |
| --- | --- |
| `node/` | The app's Node process: VS Code's API for the extension, its server, dialogs, theme and update check. |
| `ui/` | The window: tree, tabs and menus. |
| `splash/`, `src-tauri/` | The Tauri shell and its installer. |

### fabric_app/

| Folder | What it holds |
| --- | --- |
| `export/` | Export to Fabric, from its first question to the published app (`exportflow.js`, `exportapp.js`, `fabricapp.js`), a semantic model's TMSL and writes (`pbimodel.js`, `fabricmodel.js`), and writes to OneLake (`onelakewrite.js`). |
| `site/` | The exported app's page, and its two data sources in `storage/`. |
| `rayfin/` | The app's project and its function. |

### test/ and scripts/

- **`test/js/`** is the `node --test` suite and browser runners. Its `cli*.test.mjs` run `cli/cli.mjs` as a process.
- **`test/sql/`** is SQL statements and their answers (sqllogictest), run through the agent's `sql`.
- **`test/e2e/`** is the vsix in a real VS Code server and headless Chrome, signed out, and signed in with no internet.
- **`scripts/`** is packaging (bundle, bundle-desktop, stage-webview, vendor, function-bundle, fetch-extensions,
  check-binding, fetch-binding, fetch-retry, pinned-downloads, release-notes, make-icon) and the website
  (build-website, and website-shots, which takes its screenshots in the installed app).

`dist/`, `webview/`, `vendor/`, `duckdb-extensions/`, `fabric-function/` and `blog/` are ignored by git.
The first five are build output or fetched at package time, so do not edit them.
