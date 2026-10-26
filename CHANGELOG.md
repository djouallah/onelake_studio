# Changelog

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
