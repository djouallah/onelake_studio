# OneLake Studio for VS Code

Browse your Fabric workspaces and query OneLake Iceberg tables with DuckDB, in a panel
inside VS Code. Open it from the OneLake Studio icon in the activity bar, or run
**OneLake Studio: Open** from the command palette.

Sign-in is the VS Code Microsoft account you already use — there is nothing to register.

It also lists each workspace's **Power BI semantic models**. Export one to a lakehouse's
`Files/semantic_models/` and it opens as its model: the tables and relationships, SQL that asks the
model with `AGG(measure)` (compiled from DAX by [dax-sql](https://github.com/djouallah/dax-sql)), and
Explore for pivots and charts. Any `.bim` already in `Files/` opens the same way.

The panel is the same app that runs at
[studio.projectscontrols.com](https://studio.projectscontrols.com/), packaged into the
extension so it works with no CDN.

## Commands

| Command | What it does |
| --- | --- |
| **OneLake Studio: Open** | Opens the panel, signing in if needed. |
| **OneLake Studio: Sign in to OneLake** | Signs in and fills the explorer, without opening the panel. |
| **OneLake Studio: Switch Microsoft Account** | Asks which account to use instead of reusing the remembered one, and reopens the panel so the previous account's tables do not survive the switch. To sign out altogether, use the Accounts menu in the bottom left — that is VS Code's to own, not an extension's. |
| **OneLake Studio: Refresh** | Re-reads a workspace, item or folder from OneLake in the foreground. Everything else is served from the cache first and refreshed behind you. |
| **OneLake Studio: Show Read Log** | Every OneLake request the extension made, with sizes and timings. |
| **OneLake Studio: Clear Cached OneLake Data** | Empties the on-disk cache (listings, table metadata, first rows) and reports what it freed. |
| **Export .bim to Lakehouse Files and Open** | On a semantic model in the explorer (right-click, or the inline button). Reads its TMSL definition from the Fabric API, writes it to `Files/semantic_models/<model>.bim` in a lakehouse of the model's workspace — asking which, if there are several, and before replacing an existing file — and opens it in the panel. |

## Settings

| Setting | What it does |
| --- | --- |
| `onelakeStudio.tenantId` | Directory (tenant) GUID to sign in against. Leave empty for your home tenant; set it to reach a tenant you are a guest in. |
| `onelakeStudio.catalogTtlMinutes` | How old a listing or a table's metadata may be before it is refreshed (default 5). The last known answer is always served instantly from disk and refreshed behind you, so a table you have opened before opens without waiting — even after a restart. |
| `onelakeStudio.prefetchMetadata` | Read every table's metadata in the background once a lakehouse's Tables node is opened, so the first click is a disk read (default on). |
| `onelakeStudio.engineMemoryLimit` | Most memory DuckDB may use, e.g. `4GB`. Empty means a quarter of the machine's RAM. |

## Semantic models

A workspace's **Semantic models** node lists its Power BI models from the Fabric REST API, not from
OneLake, so it needs a token in the Fabric API's audience. That is a separate sign-in, asked for only
when you click *Sign in to list semantic models* — never at startup — and for the same account the rest
of the extension uses. Exporting needs permission to read the model's definition (Contributor or above
on the workspace, or write on the model), and permission to write the lakehouse's `Files/`.

The export is the one thing the extension ever writes: a single `.bim` file under
`<lakehouse>/Files/semantic_models/`, on the command, and nowhere else — any other path is refused
before a request is sent. The write goes from the extension host straight to OneLake; the panel
itself never writes, and never reads OneLake at all.

## How it works

Everything runs in the **extension host**; the panel is only a view. It holds no token,
opens no connection and loads nothing from the network — every query and every OneLake read
goes over one message channel to the host, and its few libraries ship inside the extension.

- **The engine** is DuckDB 2.0, native, not a WebAssembly build. It reads Iceberg tables
  with `iceberg_scan` on the table's metadata file, and Files/ objects by their `abfss://`
  names, with the VS Code token as its azure secret. Each query runs on its own connection,
  so Stop interrupts exactly that query, and a result past 200,000 rows is counted rather
  than carried into the panel. A lockdown keeps it off the local disk outside its own temp
  directory.
- **OneLake is cache first.** Workspaces, items, tables, Files/ listings, each table's
  metadata and its first 100 rows are kept on disk, per Microsoft account, and served from
  there at once — then refreshed behind you once they are older than
  `onelakeStudio.catalogTtlMinutes`. A table you have opened before opens without a single
  request, even after a restart; first rows are kept per snapshot, so they are never stale.
  **Refresh** re-reads in the foreground.

Requires desktop VS Code on x64 or arm64 Windows, macOS or Linux: the engine is a native
library, so this does not run on vscode.dev.
