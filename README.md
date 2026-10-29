# OneLake Studio for VS Code

Browse and explore your Microsoft Fabric data without leaving VS Code, signed in with the
Microsoft account VS Code already uses.

![The OneLake explorer](docs/summary.png)

## What you can do

- **Browse everything in OneLake.** Workspaces, lakehouses, warehouses, SQL databases, mirrored
  databases, their tables and files, in one tree. Pin the workspaces you use, or group everything
  by type.
- **Look at a table in a click.** Its columns, row count and first rows, then query it with SQL.
  Delta and Iceberg tables each show their own stats and history.
- **Open the files in a lakehouse.** Parquet, CSV, JSON, Excel, DuckDB and SQLite files, even
  inside a zip, and query them with SQL.
- **Explore a semantic model.** See its tables and relationships, then drag fields into a pivot:
  rows, columns, values, filters, totals, as a table or a chart. See the SQL behind it, edit it,
  and see where the time went.
- **Publish it to Fabric.** One click turns a model's Explore into a Fabric app your colleagues
  open in their browser. Only people with access can open it, and it always shows the model's
  current data. A copy is kept in your folder to build on later.
- **See your Fabric apps.** Each workspace lists its apps, with their address and whether anyone
  can open them or only people with access.
- **Ask Claude Code or GitHub Copilot about your data.** One command, and your assistant can list
  your data, read a model's measures and compute them.
- **Fast after the first look.** What you've opened is kept on your machine, so it opens at once
  next time.

## Get started

1. In VS Code open Extensions (`Ctrl+Shift+X`), search **OneLake Studio** and click Install. It's
   also on the [Marketplace](https://marketplace.visualstudio.com/items?itemName=djouallah.onelake-studio),
   or run `code --install-extension djouallah.onelake-studio`.
2. Click the OneLake Studio icon in the activity bar and sign in.

It needs desktop VS Code 1.90 or later on Windows, macOS or Linux (x64 or arm64).

**Your data stays as it is.** OneLake Studio only reads, except when you click *Export to
Fabric*: it publishes an app, and writes the model's definition into its lakehouse for the app to
read. Opening a semantic model keeps its definition on your machine only.

Commands, settings and release notes: [docs/](https://github.com/djouallah/onelake_studio/tree/main/docs).

> A personal project, not a Microsoft product or supported by Microsoft. Results computed from a
> semantic model here aren't guaranteed to match Power BI.
