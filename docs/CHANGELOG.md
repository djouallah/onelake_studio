# Changelog

## Unreleased

- **A table that doesn't exist fails in seconds.** It used to wait about two minutes as if Fabric were converting it,
  then suggest writing to it. The error now says there is no such table and names the closest ones. A table
  still waiting for its conversion still waits.
- **The command line takes reads only.** `DROP`, `DETACH`, `CREATE VIEW`, `CREATE SCHEMA` and `ATTACH` are refused at
  once. The SQL box keeps what a tab needs to set up its reads.
- **`find --fresh`** reads every listing, then searches. `find` also says when it searched a table by name only.
- **The command line's answers fit an agent better.** `SHOW ALL TABLES` in Markdown gives a column count rather than
  every column. `sql` marks `NULL` in Markdown, and `--csv` writes an empty string as `""`. `models --downloaded` lists
  only what is on this machine, and `models` and `items` have a `staging` column. A query the shell split says so.
- **Double-click an app in the tree** to open it in the browser.
- **It works offline.** With no internet, or nobody signed in, OneLake Studio notices and works from what
  this machine has cached: the tree, the catalog, stats, first rows, semantic models, and the rows it has
  read. A query or a model's Pivot runs from what was read, and a column or a file never read says so at
  once. Export to Fabric needs OneLake. The status bar shows when this is happening, and it comes back by
  itself.
- **The SQL box runs the statement under the cursor, or the selection.** Ctrl+Enter runs it, Ctrl+S keeps it
  under Queries as "Query N", and the cursor goes to where DuckDB says an error is. The text last written comes
  back in the next window. Edit SQL is only where the box is hidden: a semantic model's view and a table's
  Pivot. A table or file you click puts its SQL in its tab's box, not run.
- **DuckDB runs in a process of its own, shared by every tab and window.** One memory budget and one cache of what
  was read, and it outlives a window reload. What the tree opens gets a new tab, each running its own query with its own
  Stop. Listings, table metadata and first rows move to a DuckDB file, imported once from the JSON files.
- **Logs and Performance, as nodes in the tree.** Logs is what the engine ran, from DuckDB's own log, kept up to
  `logMaxGB`, and a row reopens its SQL in a new tab. It holds your SQL in plain text. Performance is live charts of
  memory, cores, queries per second and the disk cache. Nothing of it is stored.
- **Logs left Explore and the Fabric app.** A published app has no built-in diagnostics page now.
- **A first `SHOW ALL TABLES` answers at once.** The catalog's list is kept and checked behind you, so it no
  longer walks every table first. On a machine that scans what it opens, that took 35 seconds.
- **The title says where you are.** The sidebar's header and each tab's title read OneLake Studio and then
  `offline` or the tenant in use.
- **Sign Out stays signed out.** The next VS Code start asks for no session and sends nothing to OneLake,
  until you sign in again.
- **A model has one name in SQL.** `FROM nem` no longer reaches an open model: only
  `semanticmodel.<workspace>.<model>` does. A shorter name is an error from DuckDB.
- **A table shows whether it is cached.** As a semantic model does: a cloud until its rows have been read on
  this machine, a check after. The Delta and Iceberg icons are gone; Stats still says which format it is.
- **Sign Out.** In the explorer's "..." menu. It signs out of OneLake Studio; VS Code's Accounts menu still
  removes the account itself. Signed out, the last account's cached data stays on show on this machine, until
  another account signs in or Clear Cached OneLake Data deletes it.
- **A cached answer that turns out wrong now corrects itself.** A lakehouse made a minute ago no longer
  gives "there is no lakehouse", a renamed one keeps working under its model, and a table whose metadata
  has moved is read again rather than failing. Nothing extra is read unless something fails.
- **A first query answers much sooner.**
  - A statement that names no semantic model no longer waits for its tab to load your models.
  - The name behind a Direct Lake model's GUIDs is kept on disk, so opening a tab no longer waits
    on the Fabric API each session.
  - The engine starts in the background once the OneLake view is visible, and its boot no longer
    waits to check the disk cache's size.
  - The catalog is listed in one call.
  - The Read Log shows the boot's stages in more detail, and how long the catalog and semantic models
    took.
- **Settings are one click away.** The explorer's "..." menu has Settings, next to Switch Microsoft
  Account, and Clear Cached OneLake Data. Settings are grouped into Cache, Engine, Query and Results,
  and Sign-in.
- **New settings:** `cacheDirectory`, `metadataCacheMaxMB`, `engineThreads`, `engineSpillMaxGB`, `logMaxGB`,
  `selectTopRows`, `maxResultRows`, `tableOpensOn` and `gridThousandsSeparator`.
- **`Files/` objects DuckDB reads are kept in the disk cache.** A Parquet or CSV under `Files/` is no
  longer downloaded again on every query. A kept copy is checked against OneLake first, so a rewritten
  file is read again.
- **`diskCacheMaxGB: 0` turns the disk cache off.** It used to mean no limit.
- **`catalogTtlMinutes` and `tableMetadataTtlHours` apply at once**, with no window reload.

- **Every OneLake table is read by its five-part name.** The Data tab's rows now are too. A model
  table with no Direct Lake source, in a `.bim` or `.yaml` opened from `Files/`, gives an error when
  a query reads it; it used to read whatever carried its short name, such as an open `Files/` view.
- **The command line is built for an agent to act on.**
  - **Exit codes say what happened:** 0 answered, 1 failed, 2 wrong call, 3 VS Code not open or not
    signed in, 4 not cached, 5 you declined an export, 6 timed out.
  - **New options:** `--json`, `sql -` for SQL from stdin with no shell quoting to get wrong,
    `--timeout`, `--version` and `<command> --help`. A query stops when its command is killed.
  - **Fixed:** `models <typo>` and `items <typo>` answered "none" and exit 0; a cancelled export
    exited 0; `--csv` left rows out past 200,000 with no word, now fails; `--show-sql` broke a `--csv`.
  - **Changed:** `--csv` holds raw values under plain column names, and always a header. An unknown
    option, a bad `--limit` or an option a command does not take is refused rather than ignored.
- **A semantic model's local copy is an Apache Ossie file.** Clicking a model keeps
  `~/OneLakeStudio/semantic-models/<workspace>/<model>.yaml` in place of the `.bim`, and Export to
  Fabric writes that `.yaml` into its lakehouse. A model downloaded before this downloads again on
  its next click; its old `.bim` is left where it is.
- **Export to Fabric reads an Ossie model as it reads a `.bim`.** A table with no schema is in
  `dbo`, and a table with no source of its own (a calculation group, a calculated table) is a
  warning, not a refusal.
- **Export to Fabric's app:** a query's tables download together, and outside the engine queue;
  each tab has one store writer, handed its downloads without a copy (the DuckDB workers only
  read); the function's answer and the table snapshots live in IndexedDB, not localStorage; and
  the manifest cache keeps only what the tables read now.
- **Go to a Table, Column or Measure** (Ctrl+Alt+O, or the search icon on the tree): every table,
  column, semantic model and measure the cache holds, in one search. A pick opens the table or the
  model; its button puts the SQL name in the SQL box (or copies it).
- **The results grid scrolls every row a result holds**, not the first 2,000, with row numbers.
  Click a cell, Shift+click or Shift+arrows for a range, a row number for its row; Ctrl+A, and
  Ctrl+C copies as tab-separated text (Ctrl+Shift+C with headers). Right-click: Copy, Copy with
  Headers, Copy as CSV, Markdown or JSON. A double click (or Enter) shows a cell whole, JSON
  indented. The filter box keeps the rows that hold its text.
- **Time travel on an Iceberg table:** History's Query puts a snapshot's rows in the SQL box
  (`iceberg_scan(…, snapshot_from_id = …)`), and each snapshot says how its row count and its
  columns differ from the table now.
- **Query variables:** `SET VARIABLE year = 2024` run from the SQL box keeps a value in that tab,
  and `getvariable('year')` in a query reads it; one never set is asked for the first time.
  **Clear Query Variables** forgets them.
- **Chart** on a result: the rows on screen as a bar, line or scatter chart, one column across
  and a number (or every number) up; nothing is queried again.
- **Profile** on a result: each column of the result, over every row the query returns: its
  type, min and max, distinct values, average, spread, quartiles, count and nulls.
- **Export…** (was Save CSV) writes every row the query returns, not only the rows on screen, to
  a CSV, Parquet or Excel file. The engine writes it; SQL typed by hand still cannot `COPY`. The
  grid's right-click also opens the selection (or every row) as an untitled CSV or JSON document.
- **SQL from the tree.** A table's right-click: Select Top Rows (a query in the SQL box, run),
  Copy SQL Name, Copy Column List. A table or a semantic model dragged into an editor drops its
  SQL name.
- **The command line's `dax` command is gone.** OneLake Studio takes SQL only: a semantic model is
  queried with `AGG("measure")` in `sql`.

## 0.2.9

- **Clicking a semantic model writes nothing to OneLake.** Its definition is kept on this machine,
  `~/OneLakeStudio/semantic-models/<workspace>/<model>.bim`, and opened from there, so a user who
  can only read the workspace can open and query it. Export to Fabric writes the `.bim` into its
  lakehouse, after you approve the export.
- **A semantic model is `semanticmodel.<workspace>.<model>` in SQL.** A query that names one not
  opened yet opens it first.
- **`CREATE` and `DROP SEMANTIC VIEW` are gone.** A model is there because Fabric has it, or a
  lakehouse's `Files/` holds it; open one in the tree, or name it in a query. `SHOW SEMANTIC VIEWS`,
  `SHOW SEMANTIC METRICS` / `DIMENSIONS` and `DESCRIBE` still work. `SHOW SEMANTIC VIEWS` lists
  every model the cache knows; one not opened yet has no file and no tables yet.
- **`SHOW ALL TABLES` and `SHOW SCHEMAS` list everything the cache knows**, tables and semantic
  models, with no request to OneLake. Each schema is named by its whole path (`ws.lh.dbo`), so two
  workspaces' `dbo.t` are two rows. `SHOW TABLES FROM lakehouse.ws.lh.dbo` works.
- **New Query.** The **+** on **Queries** opens a new query that starts with `SHOW ALL TABLES`,
  not yet run. It lists only the tables cached on this machine; expand a lakehouse in the tree to
  add its tables. Show Queries Folder moved to the node's right-click menu.
- **A newer query keeps the results pane.** A slow query that finishes after a newer one no longer
  replaces its results. Opening a saved query clears the last table's Stats, History and Pivot.
- **Fixes:**
  - Save Query on a semantic model saves the query as it stands.
  - Sorting the grid no longer reorders a document's Pretty view.
  - The Data tab puts a query's results back instead of replacing them.
  - CSV quotes a cell with a carriage return.
  - Plan no longer runs the query again on every click.
  - A date-like filter on a text column compares text.
  - Signed out of Fabric, expanding both Semantic models and Apps no longer fails.
  - "Signed out" shows only to someone who was signed in.
  - A new account or tenant lists Fabric workspaces again.
  - Publishing a folder "as is" lists each redirect once in `rayfin.yml`.
  - A SQLite file in `Files/` is downloaded once per session, and Save downloads only after the dialog.
  - A `DROP` no longer leaves a table unreadable until reload.

## 0.2.8

- **Every table has one SQL name: `lakehouse.workspace.item.schema.table`.** For example
  `lakehouse.aemo.data.dbo.dim_duid`; the first part is `lakehouse`, `warehouse`, `sqldatabase`
  or `mirroreddatabase`, and a lakehouse without schemas is `dbo`. A query names tables that
  way and runs as written, whatever is open: joins across items and workspaces need no setup.
  The panel, Explore, a model's compiled SQL and the command line all use it. Copy SQL Name on
  a table gives it.
- **Saved queries.** Save Query in the SQL box keeps it, with no name to type, under **Queries**
  at the bottom of the tree: one folder per signed-in account,
  `~/OneLakeStudio/queries/<account>/`. A click opens one; Rename and Delete are on its menu.
- **Plan in place of Preview.** The query's profile (where the time goes) and DuckDB's plan
  tree. Rows returned and planning time are now right there and in Explore's Show plan.
- **Semantic models are named `workspace.model`**, so two workspaces' models of one name are
  two views. The bare name works while only one model has it. dax-sql 0.1.2.
- **Direct Lake models over several lakehouses open from the tree**, each table read from its own
  lakehouse.
- **An Import, DirectQuery or composite model gives a note, not an error** (#3), and the tree
  marks it.

## 0.2.7

- **Export to Fabric's app carries its own packages.** DuckDB-WASM 1.5.6 with its parquet and
  icu extensions, Apache Arrow, the Rayfin SDK and ECharts ship with the site, in the local copy's
  `site/vendor/` (about 48 MB). The app loads nothing from jsDelivr or DuckDB's extension
  repository. The export's output log lists what `site/vendor/` weighs, package by package.
- **SQL over a semantic model takes `ORDER BY ALL` and constants.** `ORDER BY ALL` orders by
  every column, left to right. A constant in the SELECT, such as `'orders' AS what`, is a column
  of every row, so each arm of a `UNION` can label its rows. The compiler is now dax-sql 0.1.1,
  from npm.

## 0.2.6

- **Export to Fabric from the command line.** Run `export <ws> <model>`, or
  `export <ws> <item> <Files/path>` for a model file. It uses the same export as Explore's
  button, and VS Code asks where the local copy goes and waits for your OK before publishing.
- **Generate Report is gone. Use Export to Fabric instead.** It did the same thing, but from an
  older copy of the app that ran a DuckDB-WASM 2.0 build taken from CI, with unsigned extensions.
  Export to Fabric publishes the model's Explore on DuckDB-WASM 1.5.6 from npm.
- **Mirrored databases show up.** OneLake names them `.MountedRelationalDatabase`, which the tree
  didn't list. They now appear as *Mirrored database*, with a mirror icon.
- **The disk cache keeps 64 GB by default, up from 10.** `onelakeStudio.diskCacheMaxGB` still sets it.
- **Delta and Iceberg tables have their own icons.** The icon says which format the table was
  written in. Every table is still read through its Iceberg metadata.
- **New: a History tab** beside Stats and Data.
  - **A Delta table** lists its commits from `_delta_log`, newest first, 10 at a time: version,
    time, operation, rows and files added or removed, engine, user and parameters. Nothing is read
    until the tab is opened, and each commit file is read only once.
  - **An Iceberg table** lists its snapshots, which are already in its metadata.
- **A Delta table's Stats come from its Delta log.** They show reader and writer versions,
  features, table properties (V-Order among them), partitioning and creation time. They are taken
  from the converted version's `.crc` file, which is one request and then kept. A writer that leaves
  no `.crc`, such as a Warehouse, has its last checkpoint read instead.
- **A table with no Iceberg metadata says why.** The error quotes Fabric's conversion log, for
  example a type it can't convert or too many commits. If there is no conversion log, the error
  says Fabric never converted the table.
- **A 403 names the tenant setting to check.** That setting is *Users can access data stored in
  OneLake with apps external to Fabric*, which a Fabric admin can turn off for every app at once.

## 0.2.5

- **Explore is analytics-as-code's, and lives here now.** A semantic model opens on three
  pages: Model, Pivot and Logs.
  - **The Pivot asks SQL over the model** (`SELECT … FROM <model>`).
  - **Show SQL** turns the pivot into that SQL, which you can edit and run.
  - **Show plan** profiles the query (DuckDB's `EXPLAIN ANALYZE`: totals, a timeline, the costly
    operators) and shows its plan.
  - **Logs** lists the session's queries with timings.
  - **The SQL page is gone:** the Pivot's Show SQL does its job.
  - **Values can no longer be summarised by median**, which SQL over the model doesn't have.
- **New: Export to Fabric.** A button on the Pivot publishes that Explore (and Logs) as a Fabric app
  named `<model>-explore`, and writes a local copy of it to `<open folder>/<model>-explore/` (or the folder
  approved last time), after you approve where.
  - **It asks before overwriting** local edits to that copy (overwrite, or publish the folder as it
    is), or an app deployed again from somewhere else since.
  - **It deploys directly** over the Fabric REST API: no CLI, no Node, no GitHub access.
  - **The site is protected**: only people who may open the app item can load it. It's black.
  - **The model is never copied:** the app reads it from the lakehouse, in place, every time.
  - **It never replaces an app it didn't create** without asking.
  - **It is the one write** the extension makes to Fabric, and it happens only when you click.
- **A semantic model opened from the tree goes into its lakehouse.** Its `.bim` is written to
  `<lakehouse>/Files/semantic_model/<model>.bim` and opened from there, so Export to Fabric works on
  it. Only Direct Lake models on one lakehouse are opened; any other is refused, with nothing
  written. *Download Again* overwrites it, after asking. The `onelakeStudio.semanticModelsFolder`
  setting is gone.
- **New: Apps in the explorer.** Each workspace has an *Apps* node listing its Fabric apps, however
  they were made, each with its URL and last deploy, and a button to copy the URL. An app whose site
  is public (anyone with the URL can load it, no sign-in) has an orange open lock; a protected one, a lock.
- **The app's template now lives in this repo** (`fabric_app/`), and analytics-as-code takes it
  from here. The function ships prebuilt in the vsix.
- **New: Generate Report.** Right-click an Apache Ossie model (`.yaml`) in `Files/` and choose
  *Generate Report…*. It writes a folder to this machine with a Fabric app (Rayfin, DuckDB-WASM in
  the browser) that reads the model's lakehouse through its OneLake Iceberg catalog. The page has
  one chart, and an `AGENTS.md` explains how an agent can grow it from there.
  - The template is analytics-as-code's Iceberg app, vendored at a pinned commit.
  - Nothing is deployed for you.

## 0.2.4

The first release notes for OneLake Studio. They cover every change since 0.1.0.

### Power BI semantic models

- **Semantic models in the explorer.** Each workspace has a *Semantic models* node, listed from the
  Fabric REST API. Listing them needs its own sign-in, which is asked for only when you click
  *Sign in to list semantic models*, never at startup.
- **One click opens a model.** The first click downloads its `.bim` to this machine, and every
  later click opens that file at once. The tree marks a downloaded model with a check, and
  *Download Again* fetches the current definition. The folder is set by
  `onelakeStudio.semanticModelsFolder`.
- **The model view has three pages:**
  - **Model:** the tables drawn as a star, with their relationships, columns and measures (with
    their DAX).
  - **SQL:** queries that ask the model with `AGG(measure)`. The DAX is compiled to SQL by
    [dax-sql](https://github.com/djouallah/dax-sql) and runs on DuckDB.
  - **Explore:** pivot tables and charts. Drag columns onto Rows, Columns and Filters, and
    measures onto Values. Measures are shown in amber. A column dropped on Values is summarised:
    numbers are summed by default, anything else is counted. Totals start off.
- **A `.bim` in a lakehouse's `Files/`** opens as its model too.
- **New: Apache Ossie models.** An [Apache Ossie](https://github.com/apache/ossie) `.yaml` or
  `.yml` model whose metrics are DAX opens just like a `.bim`. A file counts as an Ossie model when
  its top level has `version:` and `datasets:`. Any other YAML still opens as a document.
- **Semantic views.** `CREATE`, `DROP` and `SHOW SEMANTIC VIEW`, `SHOW SEMANTIC METRICS` and
  `SHOW SEMANTIC DIMENSIONS`, and `DESCRIBE`, from the SQL editor. A view can point at a `.bim` or
  an Ossie `.yaml`. Views are kept per account and survive a restart.
- **Direct Lake tables** are read from the lakehouse the model names, and only when a query needs
  them.

### Ask Claude Code or GitHub Copilot about your data

- **OneLake Studio: Install Agent Skill** writes a skill that Claude Code and GitHub Copilot (agent
  mode) both pick up. Either can then list your workspaces, lakehouses and models, read measures
  and their DAX, and compute measures by any column. It runs on the same sign-in, cache, DuckDB
  and DAX compiler as the panel, and it is read only.
- **The skill runs a read-only command line** (`cli.mjs`). It passes each request to the extension
  running in VS Code, so there is no second sign-in or cache. Commands: `ls`, `items`, `models`,
  `files`, `find`, `table`, `model`, `sql` and `dax`, plus `--show-sql` to print the compiled SQL.
- **Listings and metadata come from the cache only.** The command line never signs in or lists a
  workspace behind your back. `--fresh` is the one way to make it ask OneLake or Fabric.

### Explorer

- **The OneLake tree** of workspaces, lakehouses, warehouses, tables and `Files/` sits in the
  sidebar.
- **Group by Type** puts one heading per type at the top level (Lakehouses, Warehouses, SQL
  databases…, Semantic models), across every workspace. The choice is remembered.
- **Pin workspaces** to Favorites. Pinned workspaces are listed apart from the rest.
- New commands: **Sign in to OneLake**, **Refresh**, **Show Read Log** and **Clear Cached OneLake
  Data**.

### Engine

- **Native DuckDB 2.0** runs in the extension host, replacing the WebAssembly build. Each query
  runs on its own connection, so Stop interrupts only that query. A result past 200,000 rows is
  counted rather than carried into the panel.
- **The panel loads nothing from the network.** Its libraries ship inside the extension, and it
  holds no token.
- **Read only by design.** This is enforced in the extension host, and nothing is ever written to
  Fabric or OneLake. DuckDB is kept off the local disk outside its own temp directory.
- **SQLite files** in `Files/` open in the host.
- `onelakeStudio.engineMemoryLimit` caps DuckDB's memory. By default it may use a quarter of the
  machine's RAM.

### Cache

- **Cache first:** workspaces, items, tables, `Files/` listings, semantic model lists, each
  table's metadata and its first 100 rows are kept on disk per account. They are served at once
  and refreshed behind you. Set how often with `onelakeStudio.catalogTtlMinutes` and
  `onelakeStudio.tableMetadataTtlHours`.
- **A table you have opened before** opens without a single request, even after a restart. First
  rows are kept per snapshot, so they are never stale. **Refresh** re-reads a lakehouse at once.
- **Table data is kept on disk** by `cache_httpfs`, so a table read once is read from this machine
  afterwards. The limit is set by `onelakeStudio.diskCacheMaxGB`, 10 GB by default.
- **`Files/` objects** are kept under their etag, and each item's Iceberg catalog prefix is kept
  too.
- `onelakeStudio.prefetchMetadata` reads every table's metadata in the background once a
  lakehouse's Tables node is opened.

### Platforms

- There is one package per platform: Windows, macOS and Linux, each on x64 and arm64. Desktop
  VS Code only, because the engine is a native library and does not run on vscode.dev.

### Fixes

- Tables whose path has spaces now open.
- A semantic model opened from the tree no longer waits for DuckDB to start.
- In Explore, a search that hides a whole table no longer prints "null" in the field list.
