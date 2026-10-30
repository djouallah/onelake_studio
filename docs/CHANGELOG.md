# Changelog

## Unreleased

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
- **SQL is written in VS Code's own editor.** The panel's SQL box is gone: New Query (+ under
  Queries) opens an editor, a saved query opens as its `.sql` file, and Edit SQL in the panel (or in
  a table's Pivot) opens what is on screen in a new one. In a query's editor:
  - Ctrl+Enter, or ▶ OneLake Run above each statement (and in the title bar), runs the statement under the cursor (or the
    selection); OneLake Plan shows where it spends its time. The results show in the panel, under
    the editor (or beside it: the `onelakeStudio.resultsLocation` setting).
  - DuckDB's error is marked where it says it is, until the next edit.
  - Completion names what the cache holds: catalogs, workspaces, items, schemas, tables and their
    columns, and an opened model's measures as `AGG("…")`.
  - OneLake Save Query (Ctrl+S) keeps a new query under Queries as "Query N".

  Other `.sql` files are left to their own extensions.
- **Query History** (the clock on Queries, or in a query's title bar): every query run from an
  editor, per account, newest first, searched by its SQL; with when it ran, its time, its rows or
  its error, and how many requests reached OneLake meanwhile. A pick opens it in a new editor.
- **Go to a Table, Column or Measure** (Ctrl+Alt+O, or the search icon on the tree): every table,
  column, semantic model and measure the cache holds, in one search. A pick opens the table or the
  model; its button puts the SQL name in the query being written (or copies it).
- **The results grid scrolls every row a result holds**, not the first 2,000, with row numbers.
  Click a cell, Shift+click or Shift+arrows for a range, a row number for its row; Ctrl+A, and
  Ctrl+C copies as tab-separated text (Ctrl+Shift+C with headers). Right-click: Copy, Copy with
  Headers, Copy as CSV, Markdown or JSON. A double click (or Enter) shows a cell whole, JSON
  indented. The filter box keeps the rows that hold its text.
- **Time travel on an Iceberg table:** History's Query opens a snapshot's rows in a query editor
  (`iceberg_scan(…, snapshot_from_id = …)`), and each snapshot says how its row count and its
  columns differ from the table now.
- **Each query editor keeps its last result.** Moving to another query's editor shows its result
  in the panel at once, and says when it ran (unless the panel is showing a table or a file).
- **Query variables:** `SET VARIABLE year = 2024` run from a query editor keeps a value for the
  session, and `getvariable('year')` in a query reads it; one never set is asked for the first time.
  **Clear Query Variables** forgets them.
- **Chart** in the panel: the rows on screen as a bar, line or scatter chart, one column across
  and a number (or every number) up; nothing is queried again.
- **Profile** in the panel: each column of the result, over every row the query returns: its
  type, min and max, distinct values, average, spread, quartiles, count and nulls.
- **Export…** (was Save CSV) writes every row the query returns, not only the rows on screen, to
  a CSV, Parquet or Excel file. The engine writes it; SQL typed by hand still cannot `COPY`. The
  grid's right-click also opens the selection (or every row) as an untitled CSV or JSON document.
- **SQL from the tree.** A table's right-click: Select Top 1000 Rows (a query in its editor, run),
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
