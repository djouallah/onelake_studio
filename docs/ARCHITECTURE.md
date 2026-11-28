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
  What DuckDB makes us work around is in [DUCKDB.md](DUCKDB.md).
- **Works offline.** This is a must, not a fallback. Everything you have read keeps working with no
  internet and no sign-in: browsing, SQL, a model's Explore and its Pivot.
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
| **One name per object** | A lakehouse table is `<workspace>.<lakehouse>.<schema>.<table>`, another item's `<workspace>.<item>_<kind>.<schema>.<table>`, either by its GUIDs too, and a model is `<workspace>.<model>_semanticmodel`. A file is `'<workspace>.<lakehouse>/Files/<path>'`, or `/Context/` or `/SystemContext/` in place of `/Files/`. | [NAMING.md](NAMING.md), [`core/names.js`](../core/names.js) |
| **SQL only** | A model is read with `AGG("measure")` in SQL. There is no DAX query. | [`page/semantic.js`](../page/semantic.js) |
| **Reads, and writes to a lakehouse only** | A statement reads, or writes to a lakehouse: its tables as Iceberg, through its Iceberg catalog, and its `Files/` by `COPY … TO` ([SQL writes](#sql-writes)). Past a tab's own session (its variables and temp tables), SQL writes nothing else, and DuckDB's own plan of each write is checked first. Upload Files… asks first; Save and Publish of a semantic view, and a notebook's Publish, are the clicks themselves. | `assertReads`, `checkedRead`, `writeOf`, `checkPhysical` and `sessionStatementOf` in [`core/sql.js`](../core/sql.js), `runWrite` in [`core/engine/engine-host.js`](../core/engine/engine-host.js) |
| **Cache first** | Every answer from OneLake or Fabric is kept on this machine and served from there first. It is trusted until using it fails, then read again once. | [`core/onelake/onelake.js`](../core/onelake/onelake.js), [`core/onelake/store.js`](../core/onelake/store.js) |
| **Works offline** | A feature that reads data works from what this machine holds, with no network. What isn't held says so at once, never on a timeout. Only writing to Fabric needs a connection: Upload Files…, a semantic view's Save and Publish, and a notebook's Publish. A notebook's cells read OneLake themselves, so running one needs a connection too. | [`core/onelake/connectivity.js`](../core/onelake/connectivity.js), [`core/onelake/http.js`](../core/onelake/http.js), the lake in [`core/lake/tableservice.js`](../core/lake/tableservice.js) |
| **The host does the work** | Sign-in, the read-only guard and OneLake's listings, metadata and `Files/` bytes are in the host, and DuckDB's reads are in the server it starts. A tab is a view: it holds no token and makes no network request. | [`core/host.js`](../core/host.js), [`extension/panel.js`](../extension/panel.js), [`core/engine/engine-client.js`](../core/engine/engine-client.js) |
| **A table's Pivot is a SQL starter** | It builds a first SQL. Its only actions are Edit SQL and Close. | [`page/app.js`](../page/app.js) |

## Out of scope

- DAX queries (`EVALUATE`).
- Writing a Delta table, a warehouse or anything outside a lakehouse (but a notebook's Publish); `DROP`; editing data in the grid.
- `CREATE` and `DROP SEMANTIC VIEW`: a model exists because Fabric has it, not because SQL made it.
- ER diagrams for lakehouse tables: they declare no keys.
- vscode.dev: the engine is a native library, so this needs desktop VS Code.

Results computed from a semantic model are not guaranteed to match Power BI.

## How the parts fit

```
 Tree            Tabs, Explore           Command line, agent skill
 (VS Code)       (webview, page/)        (cli/cli.mjs)
      |                 |                        |
      |          one message channel       local pipe or socket
      |           (core/host.js)        (cli/bridge.js, cli/agent.js)
      v                 v                        v
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
   names. A statement that names no model passes through unchanged. Before that, `semantic.takeStats` runs
   dax-sql's two checks, `orphanCheck` and `trailingSpacesCheck`, once for each model the statement names. Their
   answers become the compiler's `orphans` and `trailingSpaces` options. They hold for the DuckLake snapshot each
   table was at (`lake.snapshots`, which reads the lake's metadata and nothing of OneLake), and are read again when
   one of the model's tables is at another. A table the lake doesn't hold gets no answer: its keys are tested in the SQL.
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
too.

Nothing turns this on. The extension is offline when there is no internet or no session, says which in
the status bar, and comes back by itself ([`core/onelake/connectivity.js`](../core/onelake/connectivity.js)).

- **Detecting it:** a request that gets no answer at all starts a probe of OneLake, and offline means the
  probe got none either. Any HTTP status is an answer, so a slow connection counts as online. Offline, the
  probe repeats every 30 seconds.
- **No request is sent.** `authedFetch` refuses first ([`core/onelake/http.js`](../core/onelake/http.js)), so nothing waits
  on a timeout.
- **What is kept is the answer,** however old ([`core/onelake/onelake.js`](../core/onelake/onelake.js)), with no background
  refresh or prefetch. Anything not held says so at once.
- **No session:** the tree and the tabs open on the cache of the last account signed in on this machine,
  in the tenant the setting names, with no prompt. Another account signing in gets its own cache.

| Works offline, if cached | Needs OneLake |
| --- | --- |
| The tree, `SHOW ALL TABLES`, `information_schema`, Go To | A table's file no statement has opened here, or a file never read |
| A table's Stats and History, and first rows already read | A wildcard over files |
| Semantic models: opening them, Explore's Model page, `SHOW SEMANTIC …` | A table whose metadata was never read |
| Table rows, a model's queries and its Pivot, for what was read | |
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
- **Lockdown:** file access is limited to the temp directory, `https://` and `abfss://`.
  Nothing loads after it: every extension is loaded before, and autoload is off. They load from the
  files that ship, `httpfs` and `avro` before `iceberg`, which asks for both as it starts, so a first start fetches
  nothing. DuckDB 2.0 takes a community extension's signature only from its own repository, so the shipped
  `nanoarrow` loads as unsigned, held to its hash at build time. With unsigned loading on DuckDB checks
  no signature at all, so in a packaged build no extension is ever fetched, a core one included: one whose shipped
  file is missing or won't load is not there, and the engine doesn't start without one it needs.
- **What a statement may be:** from a tab or the command line, one read, or an `EXPLAIN` of one, or one of
  [SQL's writes](#sql-writes) to a lakehouse. Never `EXPORT`, `PRAGMA`, `DROP`, anything that attaches, a Quack
  function, the log's own switches, a `ducklake_` function, `query()` or `json_execute_serialized_sql()`, a function
  that writes, a write's own catalog, or an Azure URL whose host isn't OneLake's. A view or a macro kept in a DuckDB
  file is held to the same list when the file is attached (`storedFault` in [`core/sql.js`](../core/sql.js)), since
  it runs inside whatever statement names it: a file with one that isn't allowed is not opened.
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
  token and the offline switch go this way rather than over Quack, which logs
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

**Logs**, a node in the tree, opens a query tab with `SELECT … FROM onelake_logs WHERE NOT setup ORDER BY logged_at DESC
LIMIT 1000`, run at once. The record is DuckDB's own: its `Quack` log has a row per
statement with the time to its first rows and any error, for every tab, window and the command line. A large
result's later rows aren't in that time, since DuckDB doesn't log them. It is kept in memory
(file storage can't be read back on Windows, since DuckDB locks its own file), and the server moves it to the log
file every two seconds ([`core/engine/enginelog.js`](../core/engine/enginelog.js)), up to `onelakeStudio.logMaxGB`, the oldest going first.
It holds your SQL and its errors in plain text, and never the OneLake token.
`onelake_logs` is that file, attached read only through DuckDB's sqlite extension before the lockdown
([`core/engine/engine-host.js`](../core/engine/engine-host.js)): `logged_at`, `status`, `ms`, `client` (the window), `sql`,
`error`, and `setup`, true for what the engine and the tree run to get ready (a `CREATE`, `DROP`, `ATTACH` or `DETACH`:
thousands of views at each start). DuckDB refuses a write to it, and so does the guard. A semantic model's query is
there as the SQL dax-sql compiled it to, with the query as written in a comment in front
([`page/semantic.js`](../page/semantic.js)).
`SELECT * FROM duckdb_logs` answers in a SQL box for what is still in memory.

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
  standalone host's server has a lake of its own, `lake-standalone`.
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
  `scripts/downloads.sha256.json`, and DuckDB's native binding against the lockfile. The community extension
  `nanoarrow` ships in the vsix too, and loads as an unsigned extension, as a load by path knows only DuckDB's own
  signing keys. `ducklake` ships with the rest.

## The explorer

The tree ([`extension/tree.js`](../extension/tree.js)) lists workspaces, then lakehouses, warehouses, SQL and
mirrored databases, their tables and files, semantic models, apps and Python notebooks. *Queries* and **Logs**
come after them, and stay there when a listing fails or finds nothing. Workspaces can be pinned, and the tree can be filtered to one type.

**A table's icon** says whether its data is on this machine: a check when every data file of its current snapshot is
in the lake's copies, a cloud while any is only on OneLake. The lake says so (`localAll` in
[`core/lake/onelaketable.js`](../core/lake/onelaketable.js)), asked every 5 s while an engine runs, and what it last said is kept beside
the lake in `local-tables.json` ([`core/lake/localtables.js`](../core/lake/localtables.js)), so the tree draws it with no engine. A
table nothing was ever written to has a check, since it has no file. **A file's icon** says the
same, per version of the file (`cached.file`): a statement or a tab read it, or the host kept it whole, and a file
rewritten in OneLake goes back to the cloud. A wildcard marks no one file. **A folder under `Tables/`** with neither a
Delta log nor Iceberg metadata has a warning and says *not a valid table*. That is kept like any table's metadata, so it
shows offline, and it is asked again when the table is opened or its Tables node is, so a folder that becomes a table stops saying so.

**Clicking a table** opens it in a new tab, or brings forward the tab that shows it: Data, Stats, History and Pivot. The SQL box gets
`SELECT * FROM <its name> LIMIT <selectTopRows>` to start from, not run. A file does the same with what its preview runs.
- **Data** is hidden offline on a table with none of its rows read here, since all it could show is an error. The status
  line says why. It comes back with the connection.
- **Stats and History** come from the table's metadata, with no data read. A table written as Delta
  also has its own log read for what Iceberg has no word for ([`core/lake/deltalog.js`](../core/lake/deltalog.js)).
- **Time travel:** on an Iceberg table, History's Query puts a snapshot's rows in the SQL box, and
  each snapshot says how its row count and columns differ from the table now.
- **Pivot** is the SQL starter described under the rules above.

**Clicking a file** opens it in a new tab, or brings forward the tab that shows it: Parquet, CSV, JSON, Excel, DuckDB and SQLite.
- **A database file** is recognised by its header, never its extension. A DuckDB file is attached
  read-only and block-read on demand. A SQLite file is copied by the host into the engine's temp
  directory and attached read-only, capped at 200 MB.
  - **It opens on what it holds** ([`page/dbview.js`](../page/dbview.js)): a tree of its schemas, tables, views and
    columns beside the SQL box, with a filter, and an overview of the file. This comes from DuckDB's catalog, so no
    table's rows are read. The tree stays while queries run in that tab.
  - **A table or view** opens as a table in OneLake does: Stats (columns, keys, indexes, its definition), Data and
    Pivot. It has no History.
  - **Row counts:** a DuckDB file's are its own estimate, which still counts deleted rows, and say so. A SQLite file's
    are counted from its copy, for up to 200 tables, since its estimate means nothing.
- **CSV, JSON, avro, xlsx and plain text** have no block structure, so DuckDB pulls them whole.
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

**Each workspace's Notebooks node** lists its Fabric **Python** notebooks. These run on this machine, because a
notebook that reaches OneLake only by `abfss://` paths reads the same tables anywhere.
- **Which ones are listed.** Fabric's listing (`GET …/notebooks`) doesn't say whether a notebook is Python or Spark,
  so each notebook's definition is read (`getDefinition?format=ipynb`, four at a time) and its kind is taken from the
  `.ipynb` metadata (`notebookKind` in [`core/models/fabric.js`](../core/models/fabric.js)). The listing is cached
  like *Apps*. Spark notebooks (`synapse_*` kernels) run only on Fabric's Spark, so they aren't listed.
- **A click** opens the notebook in VS Code's notebook editor, to read, edit and run. It is kept as `<name>.ipynb`,
  beside the workspace's model copies, with `<name>.ipynb.sync.json` beside it: hashes of the copy and of Fabric's
  definition when the two last agreed (`fetchNotebook` in [`core/models/models.js`](../core/models/models.js)).
  The click reads Fabric again unless the copy changed since (edits, or a run's outputs): then the copy opens as it
  is, and the tree marks it *not published*. If it is open here already, that tab comes forward. Offline, the copy
  kept is opened.
- **Nothing runs on a click.** Cells run when the person runs them, on a local kernel (the Jupyter extension's). The
  kernel's Python needs whatever the notebook imports, such as `duckdb`, and its own way to sign in to OneLake:
  outside Fabric there is no `notebookutils`, so a DuckDB notebook makes a `credential_chain` secret (az login).
- **Publish** (the notebook's ⬆ button) is the one way back to Fabric (`publishNotebook`, `updateDefinition`). It
  saves the open editor first, then reads Fabric's definition: if that changed since the two last agreed, nothing
  is written and the person picks **Overwrite** (theirs is replaced) or **Take theirs** (the copy's changes are
  dropped and Fabric's version opens). Nothing is merged. Outputs are published with the code, as Fabric keeps them.

## The SQL box and results

SQL is written in a box in each tab ([`page/app.js`](../page/app.js)), not in VS Code's editor. **A query
never opens a `.sql` file**, because opening one starts every SQL extension installed, on the extension
host every extension shares, and a click on Run then waits behind them with nothing on screen. A `.sql`
file you open yourself is left to those extensions. The box reacts by itself: a click says *Running…* at
once and counts, though the answer still comes through the host.

- **The box holds one query.** The text last written comes back when **Open OneLake Studio** opens a tab with
  none open, in the next window too.
- **New Query** (the **+** on *Queries*) opens a new tab with `SHOW ALL TABLES` in its box, not run. A saved query
  opens in a new tab too. **Save Query** (Ctrl+S) writes it back, or keeps a new one under *Queries* as `Query N`. A `.sql`
  file's box has **Save** in its place, which writes the box back over that file ([Opening files from disk](#opening-files-from-disk)).
- **Run** (Ctrl+Enter) runs the statement under the cursor, or the selection. A selection with several statements
  runs each in turn, in order, and stops at the first that fails, with the cursor on it; the status line says which
  one is running (`2/3 · …`), and the last one's rows are shown. **Plan** shows where one statement spends its time.
- **A statement can write** to a lakehouse ([SQL writes](#sql-writes)), with no question asked.
- **Errors:** the status line says what DuckDB says, and the cursor goes where it says it is.
- **A tab is one DuckDB session.** Its statements run one at a time on a DuckDB connection of its own (on the
  shared server, an attach of its own; `tabSession` in [`core/engine/engine-host.js`](../core/engine/engine-host.js)),
  so what DuckDB keeps on a connection lasts from one of them to the next, and no other tab sees it:
  `SET VARIABLE year = 2024`, read with `getvariable('year')` or `$year`, and `CREATE TEMP TABLE` / `TEMP VIEW`, with
  `INSERT`, `UPDATE`, `DELETE` and `DROP` on them (`sessionStatementOf` in [`core/sql.js`](../core/sql.js), each held
  to its `EXPLAIN` as a write is). A variable never set is asked for the first time a statement reads it.
  **Clear Query Variables** resets them, in every tab of the window. A **Stop** ends the session: what the stopped
  statement was reading can keep it busy for a minute, so the tab's next statement starts a new one, and the status
  line says when its temp tables and variables went with the old.
- **From the tree:** a table's right-click has Select Top Rows, Copy SQL Name and Copy Column List. Files, folders
  and semantic models have no right-click: their actions are icons on the row, shown on hover.
  - **A file:** Download File… and Copy SQL Name. A file is read from OneLake after the save dialog, so a cancel
    reads nothing.
  - **A semantic model:** Download File… and Copy SQL Name. Download File… saves the model's YAML (Apache Ossie, its
    local copy, `<model>.ossie.yaml`) to this computer, and works offline once the model has been opened.
  - **A folder** (Files/ itself, or one under it): **Upload Files…**, Copy SQL Name and Refresh. Upload picks files on
    this computer and writes each into that folder ([`core/onelake/onelakewrite.js`](../core/onelake/onelakewrite.js)): a name already
    there asks Replace or Skip, each file is written beside the target in 32 MB pieces and renamed into place, so a
    cancel or a failure leaves what was there, and the folder is listed again. It needs a connection,
    and OneLake's own refusal is shown when the lakehouse is read-only to you.
  - **A folder of `Context/` or `SystemContext/`** (`dirReadOnly`): Copy SQL Name and Refresh. A lakehouse shows
    both after Files, closed, and drawing them asks nothing. `Context/` holds a semantic view's YAML, and
    `SystemContext/` the TMDL Fabric makes of it, marked read-only. Their files open as Files/'s do, a `.bim` or
    `.sql` as a document. The `.tmdl` in `SystemContext/Semantic Views/<view>/` opens as the model Fabric made, read
    only, its text tab the TMDL ([`page/tmdl.js`](../page/tmdl.js) reads TMDL as TMSL: the script Fabric wraps it in,
    tables, columns, measures, partitions, hierarchies, relationships and expressions; annotations and lineage left
    out). A `.yaml` in `Context/Semantic Views/<view>/` opens the view as a model, as Fabric's
    Publish makes it (`fabricViewBim` in [`page/semantic.js`](../page/semantic.js)). Every `.yaml` in the folder
    is merged, and each dataset is a Direct Lake table with the columns its lake table has, from the table's
    metadata. The DAX metrics go in a table named `Metrics`. Microsoft's version (0.2.0.dev0) opens, and Ossie
    0.3.0.dev0 too. The published model is read-only, so the view's YAML is what a change goes into: a view of one
    `.yaml` is edited on the Model page's YAML tab and **Save** writes it back over that file, once it still opens as a
    view; then **Publish**. A view of several files is read-only here, and there is no Upgrade. Its YAML shows in red, and why on hover, what Fabric's Publish refuses as far as a line shows
    it: a version other than 0.2.0.dev0, 0.3's `nonportable_extensions`, a dialect Fabric has no name for (`OSSIE_SQL_2026`
    fails the whole Publish, even beside DAX; `ANSI_SQL` is only left out), an empty `dialects` or `datasets`, a source
    that isn't schema.table, a relationship's description or second column, a name given twice
    (`publishRefusals` in [`pretty.js`](../page/explore/pretty.js)). What of that a model can do without is left out
    of the model the view opens as, so the view still opens: a query source, a name given again, a relationship of
    more columns or to a dataset left out, a metric named as a dataset. As in any model's YAML, an expression in a
    dialect other than Ossie SQL (DAX, say) and an extensions block are amber.
  - **A view's folder** (`Context/Semantic Views/<view>`, `semanticViewDir`) **and its `.yaml`** (`semanticViewFile`):
    **Publish** beside them, as Fabric's own right-click has it. It is one request to Fabric's beta API, made in the background with the status bar saying
    so ([`core/onelake/publishview.js`](../core/onelake/publishview.js)). A Publish of a view while one of
    it is under way joins it: Fabric finds the view's model by its name and makes one when there is none, so two at
    once made two models, and Fabric then refused every Publish of the view (`DuplicateDatasetNamesInWorkspace`, said
    in plain words). Fabric compiles the view into
    its TMDL in `SystemContext/` and the model of the view's name. Studio says what Fabric answered: the model's
    name, or Fabric's diagnostics, each by file and line, also in the log. It then lists `SystemContext/` and the
    workspace's semantic models again. Fabric refuses the definition of the model Publish makes to everyone
    ("configured by service apps"), so a click on it in the tree reads it from that TMDL: in the workspace's lakehouse
    whose `SystemContext/Semantic Views/<model>/metadata.json` names it (`modelObjectId`), as if Fabric had given it
    (`publishedTmsl` in [`core/models/models.js`](../core/models/models.js)). With no such TMDL, the tree marks it a
    semantic view's model and says to open the view. Upload and `COPY … TO` are refused for both (`AREAS` in
    [`core/names.js`](../core/names.js)). The one write to `Context/` is Save, over a view's own `.yaml`
    (`host.saveFileText` in [`core/host.js`](../core/host.js)).
  **Go to a Table, Column or Measure** (Ctrl+Alt+O) searches everything the cache holds. A pick opens it in a
  new tab, and its button puts its name in the box, or copies it with no tab open.

Results show in the tab:

- **Grid** ([`page/grid.js`](../page/grid.js)): every row scrolls, cells select and copy, and a filter box
  keeps the rows that hold its text.
- **Chart** ([`page/chart.js`](../page/chart.js)): draws the rows on screen. Nothing is queried again.
- **Profile:** each column of the result, over every row the query returns (`SUMMARIZE`).
- **Export…** writes every row to a CSV, Parquet or Excel file. The engine writes it, through VS Code's
  save dialog. SQL typed by hand can `COPY` only to a lakehouse's `Files/` ([SQL writes](#sql-writes)).

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
- **What the copy says:** it is Ossie as its spec is now (`0.3.0.dev0`; dax-sql is checked against Ossie's own
  validator every day). A measure is a metric in Ossie's portable SQL when it means the same there, and DAX
  when not; a measure made of two tables' measures is the model's own metric, each of them `AGG(dataset.metric)`. When every table is in one lakehouse of the model's workspace, each dataset's `source` is
  `<lakehouse>.<schema>.<table>` and the file holds no Direct Lake expression; that lakehouse is found by name
  in the tree's listing, so it opens offline. A model over several lakehouses keeps its expression. The
  `POWER_BI` extension (`nonportable_extensions`, plain YAML) holds only what Ossie has no field for and something
  needs: what changes an answer (a relationship's filter direction, a date table, ...) and what a user sees (format
  strings, hidden, ...). A file of the spec before (`custom_extensions`, a JSON string) reads the same. A copy is
  never changed by being read, and nothing offers to rewrite it in another Ossie version: Refresh, which reads
  Fabric, writes it again.
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
Ossie's SQL alike, and from there the two are one. These files can be stored anywhere and have no model name. A model created from one must be named `<workspace>.<model>_semanticmodel`, and it overwrites
whatever we have under that name. See [NAMING.md](NAMING.md#files).

**A model file opened from disk** is read by `modelFile` ([`core/models/models.js`](../core/models/models.js)). Its
tables are OneLake's. A Direct Lake expression says their workspace. Tables named `<lakehouse>.<schema>.<table>` are
in the model's workspace, which the file doesn't say: the one it was opened in before, while that workspace still
holds those lakehouses, else the one workspace whose kept listing holds them, and the error names them when several do.

## Explore

A semantic model opens as **Explore** ([`page/explore/`](../page/explore/)), on two pages: Model and Pivot. It opens
on Model.
- **The bar** holds the page tabs, then each page's own: Model's Keep offline at the left, its Diagram | YAML, Save (a model file it can write back, or a
  semantic view's one `.yaml`, on YAML only) and Publish (a semantic view) at the right; Pivot's Show plan and Download CSV.

- **Model:** its tables as a star, dimensions in the middle and facts around them, with its
  relationships. Click a table for its columns, measures (with their DAX) and relationships. Double-click it, or its
  panel's Open table, for the OneLake table behind it in a tab of its own, as the tree opens it (`host.openTable`, by
  its SQL name, placed in the tree's kept listings by `place` in [`core/sqltables.js`](../core/sqltables.js)).
- **Pivot:** drag columns onto Rows, Columns and Filters and measures onto Values, drawn as a pivot or
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
    summarised columns and `ROLLUP` totals. Its query is always generated from the shelves: nothing else writes
    Pivot's SQL.
  - **Top** keeps the first n rows as they are sorted, ties kept (`FETCH FIRST n ROWS WITH TIES`; picking one sorts by
    the first measure, largest first, when the sort was by fields). A measure dropped on Filters filters the figures
    shown: a range of them, a `HAVING` (by its name when it is on Values, else as `AGG("measure")`).
  - **Treemap**, **Calendar** and **Map** are marks too (`pivotChart`): a treemap's levels are Rows (one or two), its
    size the first measure; a calendar is a date column on Rows, a strip a year, each day coloured by the first
    measure; a map is a latitude, a longitude and a name on Rows, each point sized by the first measure and coloured by
    a column on Columns, over the world's outline (ECharts 4's `world.json`, vendored and pinned like ECharts, read the
    first time a map is drawn: `ctx.worldMap`).
  - Pivot has no SQL box: its query is its shelves' (a JSON visual query, kept as the shelves), and the SQL is made
    from it behind the scenes. Nobody, a person or an agent, writes SQL into Pivot.
  - **Card** is a mark too (`cardView`): each field on Values as one figure, in its format string, over every row its
    filters keep. Its query leaves Columns out (`buildQuery`); a field on Rows (a date) is its trend, a line under the
    figure, and the figure is then the query's total row. Automatic picks it when only Values has fields. Its format can
    show a second measure as its change (▲ or ▼, coloured good or bad).
  - **Format** opens a pane at the right of the view: how the view is drawn, kept with its shelves as their
    `format` ([`format.js`](../page/explore/format.js)).
    What it offers follows the mark: a chart's series colours, data labels, legend, axis titles and value range, its
    measures in one plot (each a bar, a line, an area or a dashed line, on the left axis or the right), each measure's
    total as a line (`totalLine`: the query asks for its totals), the highest point labelled, a zoom slider; a
    table's colours by value (a tint, or a bar) and banded rows; a card's figures' size and colour and a measure as its
    change (▲/▼, good when it goes `goodWhen`); and each number's style (`NUMBER_STYLES`, each a format string:
    `#,##0.0a` writes 1.2K, `0%` a percent). A change is drawn at once from the rows there are (`formatChart` over a
    chart's ECharts option, the rest through `formatLook` into Pivot's own drawing); the total line runs the query
    again.
  - **Show plan** puts, in place of the view, the shelves' query: its SQL, shown and never written (the model's SQL
    the shelves make, and the SQL it compiles to, each with Copy), its profile (`profile.js`: DuckDB's `EXPLAIN
    ANALYZE` as totals, a timeline and the costly operators) and its plan tree.

`view.js` is host-neutral: the host passes in the compiler, how to run SQL, and where ECharts comes
from. A tab runs it on the native engine.

## SQL writes

A statement in the SQL box or the command line's `sql` can write to a lakehouse, and to nothing else
([`core/sql.js`](../core/sql.js) `writeOf` and `checkPhysical`, [`core/engine/engine-host.js`](../core/engine/engine-host.js)
`runWrite`). There is no dialog: running it is the consent, once the settings let it run.

- **The settings** (*Writes*, read at each statement), with nothing sent while the one a statement needs is off:
  **Allow Table Writes** (`onelakeStudio.allowTableWrites`) is off by default, for every write to a table or a schema.
  **Allow Drop Table** (`allowDropTable`) is off by default too, and `DROP TABLE` and `DROP SCHEMA` need both. **Allow Copy to Files**
  (`allowCopyToFiles`) is on by default, for `COPY` to `Files/` alone, which replaces a file already at its path. The
  command line reads the same keys from its settings file.

| Statement | Where it writes |
| --- | --- |
| `CREATE TABLE … (…)`, `CREATE TABLE … AS …`, `INSERT INTO`, `UPDATE`, `DELETE`, `MERGE INTO`, `ALTER TABLE` | A lakehouse table that is Iceberg, or a new one, made as Iceberg |
| `INSERT INTO` | A lakehouse table that is Delta |
| `DROP TABLE [IF EXISTS]` | A lakehouse table that is Iceberg: it and its files are gone. A Delta table is refused |
| `CREATE SCHEMA` | A lakehouse with schemas |
| `DROP SCHEMA [IF EXISTS]` | A schema of a lakehouse with schemas, as its Iceberg catalog drops one |
| `COPY (…) TO '<ws>.<lh>/Files/<path>'` | A file in its `Files/`: Parquet, CSV or JSON |

- **A new table's Parquet** is laid out as Direct Lake reads it best, with nothing written for it: every
  `CREATE TABLE` gets four Iceberg table properties in its `WITH (…)` (`TABLE_PROPERTIES` and `withTableProperties` in
  [`core/sql.js`](../core/sql.js)). Row groups close at 4M rows or 1 GiB uncompressed, files at 1 GiB, and pages at 1 MB.
  A property the statement sets itself is kept as it is. They are read when files are written, so a CTAS's rows have
  them too, and every later write to the table. Sorting is the statement's own (`ORDER BY`).

- **The names:** a table is `<ws>.<lh>.<schema>.<table>` ([NAMING.md](NAMING.md#a-writes-target)), and a
  schema is `<ws>.<lh>.<schema>`.
- **What is refused, before anything runs:** any `DROP` but `DROP TABLE` and `DROP SCHEMA`; what DuckDB's Iceberg writer doesn't have
  (`CREATE OR REPLACE`, `INSERT OR REPLACE`, `ON CONFLICT`, `TRUNCATE`, `COPY … FROM`); a view, a macro, a secret or any
  other `CREATE`; anything but `INSERT INTO` on a table that is Delta in OneLake; a warehouse, a
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
- **Each table in its own format.** Which format a table is, the catalog says (`sourceFormat` in
  [`core/names.js`](../core/names.js)): the store's answer first, and a Delta one asked of OneLake again, since an
  Iceberg table has a Delta log beside it that is OneLake's conversion, never to be written (`deltaTarget` in
  `engine-host.js`). A table that isn't there is made as Iceberg. A Delta table's Iceberg face is read only, so an
  `INSERT` into it is written by DuckDB's `delta` extension instead: the table's folder is attached (`TYPE delta`)
  for that one statement under a name of its own (`delta_` and 16 hex digits), and the statement names that
  attach as its table. DuckDB writes the rows' files with the storage secret; the extension's own storage client
  writes the commit to `_delta_log`, with the same secret's token, and a commit another writer made first is a
  conflict, not an overwrite. The extension adds rows only: an `UPDATE`, `DELETE`, `MERGE`, `ALTER` or
  `CREATE TABLE … AS` on a Delta table is refused before anything is attached, and so is a table whose Delta
  features it can't write. Its plan is the extension's `DELTA_INSERT`, held by `checkPhysical` like any other.
  OneLake converts the new commit to the table's Iceberg face in its own time; the engine reads the Delta log, so
  the next read has the rows at once.
- **Checked by DuckDB, then run.** The statement's text says what it writes and where (`writeOf`). Then DuckDB's own
  physical plan of it, as it will run (`EXPLAIN (FORMAT json)`, on the connection that runs it, which runs nothing),
  must be that write and no other (`checkPhysical`): DuckDB-Iceberg's `ICEBERG_INSERT` (an `INSERT`, and a
  `CREATE TABLE … AS` over the copy that makes the table), `ICEBERG_UPDATE` or `ICEBERG_DELETE`, a `MERGE_INTO` whose
  every write is one of those, the delta extension's `DELTA_INSERT`, DuckDB's own `CREATE_SCHEMA`, `CREATE_TABLE`,
  `ALTER` or `DROP`, or a `COPY_TO_FILE`, with no other write anywhere in it. Which table or file it is, the text
  alone says: no statement may name a write's catalog, so the only one it binds is the one attached for it, and a
  `COPY`'s file is the URL put in it here. What it reads is any read: a table, a file in `Files/`, a URL, VALUES.
- **Each statement is its own commit.** A write is never sent twice: a failure is said, not retried.
- **Afterwards:** the lakehouse's table listing is read again, and a table's new snapshot is synced into the lake, so
  the tree and the next read show it. After a `COPY`, its folder is listed again.
- **Offline:** a write is refused at once. It needs a connection.

## Opening files from disk

A model file or a `.sql` file on this machine opens in a tab, as one from the tree does (`openPath` in
[`extension/extension.js`](../extension/extension.js), the command `onelakeStudio.openPath`).
- **A `.sql` file** opens in the SQL box, not run, in a tab named after it, as a saved query does. A file open already
  brings its tab forward. A `.sql` file in a lakehouse's `Files/` opens in the box the same way, from the tree.
- **Save** (Ctrl+S) writes a file back where it was opened from: a `.sql` file's box, and a model file's text on Model's
  YAML (or BIM), which is written in there (`host.saveFileText`). On this machine, only a file `openPath` opened, and
  offline too. In a lakehouse's `Files/`, it is written beside the file and renamed into place, as Upload writes
  ([`core/onelake/onelakewrite.js`](../core/onelake/onelakewrite.js)), and its folder is listed again; that
  needs a connection. A model's text that doesn't open as a model is not written, and says why. Once saved, the
  model opens again from the new text. A semantic model's local copy is read only: Fabric's copy
  is the model, and Refresh reads it again.
- **A model file**, a `.bim`, or a `.yaml`/`.yml` that is an Ossie model (a top-level `version:` and `datasets:`): its
  model, its tables OneLake's by the names in it, in the workspace that holds them (`modelFile` in
  [`core/models/models.js`](../core/models/models.js)). One whose tables more than one workspace could hold says so, and is opened from
  its lakehouse's `Files/` instead. Another YAML is a document, and says it is not a model.
- **A file named `<name>.ossie.yaml`** is a model by its name: the Apache Ossie spec names no extension, and Ossie's own
  tools (its compliance suite and grader) name a model `*.ossie.yaml`. Studio's own copies are named so too.
- **In VS Code**, a `*.ossie.yaml` opens in OneLake Studio by default (a custom editor
  that hands it over and closes its own tab; *Reopen Editor With… > Text Editor* shows the text). A `.sql` file opens as text: most
  have nothing to do with OneLake. A `.bim` or an Ossie `.yaml` opens as text, with **Open in OneLake Studio** on the editor's title bar, by
  what the file holds (`onelakeStudio.modelPaths`), so other YAML has none; Explorer's right-click offers it on a
  `.yaml`, `.yml`, `.bim` or `.sql`, which opens without the file in an editor, so no SQL
  extension starts.

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
  `lake-standalone`, beside VS Code's in the same cache folder. Its token is in a plain file in this user's profile, and opens a
  local port, no more.
- **Nothing stays running:** no sync and no idle job. The process ends with the answer, and its server a minute after.

**The skill** is [`cli/SKILL.md`](../cli/SKILL.md). **Install Agent Skill** writes it to
`~/.claude/skills/onelake/`, where Claude Code and GitHub Copilot in VS Code (agent mode) look for
personal skills, and it follows the extension through updates.

`node cli/cli.mjs --help` is the full reference for commands and options. An agent should branch on:

| Exit code | Meaning |
| --- | --- |
| 0 | Answered. With `--json`, `complete` and `truncated` say how much. |
| 1 | Failed. |
| 2 | Wrong call. |
| 3 | Not signed in. |
| 4 | Not cached. `--fresh` asks OneLake or Fabric now, unless offline, when it fails the same way. |
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
when the tables are more than the disk cache. A Delta table's log state comes down with it, so Table Health answers
offline in full, the tree draws the table as read at once, and neither waits for a query.

## Commands

| Command | What it does |
| --- | --- |
| **Open OneLake Studio** | Brings the last tab forward, or opens one, signing in if needed. In the Command Palette only: the tree opens a tab with **New Query**. |
| **Sign in to OneLake** | Signs in and fills the explorer, without opening a tab. |
| **Sign in to the Fabric API** | Asks for the second token, for semantic models, apps and notebooks. |
| **Switch Microsoft Account** | Asks which account to use, closes every tab and opens a new one, so the previous account's tables do not survive the switch. |
| **Sign Out** | Signs out of OneLake Studio, closes every tab and stops the server. What is cached stays on show. In the explorer's "..." menu. |
| **Settings** | Opens VS Code's Settings page, filtered to this extension. In the explorer's "..." menu. |
| **Logs** | A node in the tree. See [The server](#the-server). |
| **Refresh** | Re-reads a workspace, item or folder from OneLake in the foreground. |
| **Filter by Type** | The filter button on the explorer. Shows one type, and only the workspaces that hold it, which reads every workspace's listing, cache-first. The explorer's header names the filter. Not remembered. |
| **Pin to Favorites** / **Unpin from Favorites** | Moves a workspace in or out of the tree's favorites group. |
| **Show Read Log** | Every OneLake request the host made, with sizes and timings. DuckDB's own reads aren't in it. |
| **Clear Cached OneLake Data** | Empties the on-disk cache and reports what it freed. In the explorer's "..." menu. |
| **Install Agent Skill (Claude Code, GitHub Copilot)** | Installs the skill above. |
| **New Query**, **Open Query**, **Rename Query…**, **Delete Query**, **Show Queries Folder** | Saved queries, under *Queries* in the tree. |
| **Go to a Table, Column or Measure…** (Ctrl+Alt+O) | Searches everything the cache holds. |
| **Clear Query Variables** | Resets every variable `SET VARIABLE` set in a tab. |
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

- **A statement can read any `https://` address.** So SQL someone else wrote, or an agent wrote after reading
  hostile text, can send data out in a URL. The OneLake token goes only to OneLake. See [SECURITY.md](https://github.com/djouallah/onelake_studio/blob/main/SECURITY.md).
- **The guard on SQL is in the window, not in the engine's process.** Whatever holds the engine's session token can
  send it any SQL. Every program running as you is trusted with that already.
- **A lakehouse with no schemas of its own lists its tables under `dbo`**, the namespace OneLake's catalog
  reports for those items.
- **An item its catalog cannot serve shows an error rather than a table list.** There is no DFS fallback.
  Re-picking the item tries again.
- **A result past `maxResultRows` is counted rather than carried into the tab.** The status line gives both counts,
  and **Export…** writes every row.
- **Tabs don't come back after a window reload.** Only the box's last text does (see
  [The SQL box and results](#the-sql-box-and-results)).
- **Pivot's shelves are kept per tab,** so a model opened again in a new tab starts with empty shelves.
- **OneLake's table read API is in preview,** so how a table with OneLake security is read may change. It doesn't
  serve a table behind a shortcut to another region, and a very large table can fail with *Stream was too long*.
- **Requires desktop VS Code 1.101+** on Windows x64, macOS on Apple silicon, or Linux on x64 or arm64, for its built-in SQLite. Windows on arm64 has no build of DuckDB's `delta`, so no package, and macOS on Intel has none either.

## Where the code is

One folder for each part. `core/` is what every part is built on, and loads no editor: only `core/core.js`,
which puts a window together, names another part ([`test/js/core-no-editor.test.mjs`](../test/js/core-no-editor.test.mjs)
holds both). The host's code ships bundled, with `@duckdb/node-api`, as `dist/extension.js`,
`dist/engine-server.js` and `dist/standalone.js`.

| Folder | What it holds |
| --- | --- |
| [`core/`](../core/) | What reads OneLake, with no editor. |
| [`extension/`](../extension/) | What is VS Code's. |
| [`page/`](../page/) | A tab's page, and Explore in `page/explore/`. |
| [`cli/`](../cli/) | The command line and the agent skill. |
| [`test/`](../test/), [`scripts/`](../scripts/), `docs/`, [`website/`](../website/), [`media/`](../media/) | Tests, packaging, these documents, the public website, icons. |

### core/

| File | What it holds |
| --- | --- |
| `core.js` | What a window builds that isn't about how it looks: the store, the catalog, the command line, and what happens when the account moves. |
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
| `models/fabric.js` | A workspace's semantic models, apps and notebooks, and a model's or notebook's definition. |
| `models/models.js`, `models/modeldata.js`, `models/semviews.js` | A model's or notebook's local copy, Keep offline, and the models opened, per account. |
| `models/sqlendpoint.js` | A Direct Lake model over a SQL endpoint, pointed at the item behind it. |

### extension/

| File | What it holds |
| --- | --- |
| `extension.js` | Activation, commands, the tree's view, dialogs and the status bar. It hands the rest in. |
| `tree.js` | The explorer. |
| `panel.js`, `webview.js`, `html.js` | A tab's webview and its page. |

### page/

| File | What it holds |
| --- | --- |
| `index.html`, `app.js` | A tab's page. |
| `data.js`, `host.js`, `vscode-api.js` | Tables and files asked of the host, over the page's side of the channel. |
| `grid.js`, `chart.js`, `dbview.js`, `docview.js` | The grid, the chart, a database file's view and a document's. |
| `querytext.js` | The SQL box's statements, error positions and variables. |
| `paths.js`, `semantic.js` | Names and paths, and semantic views. The command line loads these two as well. |
| `cdn.js` | Where the pinned third-party code is loaded from. |
| `explore/` | Explore: Model and Pivot. |

### cli/

| File | What it holds |
| --- | --- |
| `cli.mjs` | The command line: what an agent runs. |
| `bridge.js`, `agent.js` | The pipe it asks VS Code over, and the answers. |
| `standalone.js` | The command line with VS Code closed: `core.js` with no editor. |
| `skill.js`, `SKILL.md` | The agent skill, and what installs it. |

### test/ and scripts/

- **`test/js/`** is the `node --test` suite and browser runners. Its `cli*.test.mjs` run `cli/cli.mjs` as a process.
- **`test/sql/`** is SQL statements and their answers (sqllogictest), run through the agent's `sql`.
- **`test/e2e/`** is the vsix in a real VS Code server and headless Chrome, signed out, and signed in with no internet.
- **`scripts/`** is packaging (bundle, stage-webview, vendor, fetch-extensions,
  check-binding, fetch-binding, fetch-retry, pinned-downloads, release-notes, make-icon) and the website
  (build-website).

`dist/`, `webview/`, `vendor/`, `duckdb-extensions/` and `blog/` are ignored by git.
The first four are build output or fetched at package time, so do not edit them.
