# OneLake Studio

A VS Code extension to browse Microsoft Fabric OneLake and query it with DuckDB, signed in with the
Microsoft account VS Code already has — no app registration.

[Install from the Marketplace](https://marketplace.visualstudio.com/items?itemName=djouallah.onelake-studio),
then run **OneLake Studio: Open**.

- **Browse** workspaces, lakehouses, warehouses, tables and `Files/` from the activity bar.
- **Query** Iceberg tables, parquet, CSV, DuckDB/SQLite files and zips with read-only SQL on native DuckDB 2.0.
- **Semantic models**: double-click a Power BI model in the tree to download its `.bim` and query it
  with `AGG(measure)`, compiled from DAX by [dax-sql](https://github.com/djouallah/dax-sql).
- **Read only, by design.** Your token stays in the extension host, and nothing is ever written to
  Fabric or OneLake.

Requires desktop VS Code on Windows, macOS or Linux (x64/arm64). How it works, limitations, and the
standalone web version: [ARCHITECTURE.md](https://github.com/djouallah/onelake_studio/blob/main/ARCHITECTURE.md).

> A personal learning project — not a Microsoft product or supported by Microsoft, and DAX compiled
> to SQL here is not guaranteed to match Power BI.
