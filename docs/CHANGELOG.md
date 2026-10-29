# Changelog

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
