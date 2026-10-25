# OneLake Studio for VS Code

Browse your Fabric workspaces and query OneLake Iceberg tables with DuckDB, in a panel
inside VS Code. Open it from the OneLake Studio icon in the activity bar, or run
**OneLake Studio: Open** from the command palette.

Sign-in is the VS Code Microsoft account you already use — there is nothing to register.
The extension can also **lend that sign-in to the website**, so the browser version needs
no app registration either while VS Code is running (see *The website, signed in with VS
Code* below).

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
| **OneLake Studio: Refresh** | Re-reads a workspace, item or folder from OneLake instead of serving the cached listing. |
| **OneLake Studio: Show Read Log** | Every OneLake request the extension made, with sizes and timings. |
| **OneLake Studio: Clear Cached OneLake Data** | Empties the on-disk data cache and reports what it freed. |
| **OneLake Studio: Open the Website, Signed In with VS Code** | Opens the website in your browser, already pointed at this window's sign-in. |
| **OneLake Studio: Forget Websites Allowed to Use the VS Code Sign-in** | Takes back every *Always Allow*, and invalidates what an open page was handed. |
| **Export .bim to Lakehouse Files and Open** | On a semantic model in the explorer (right-click, or the inline button). Reads its TMSL definition from the Fabric API, writes it to `Files/semantic_models/<model>.bim` in a lakehouse of the model's workspace — asking which, if there are several, and before replacing an existing file — and opens it in the panel. |

## Settings

| Setting | What it does |
| --- | --- |
| `onelakeStudio.tenantId` | Directory (tenant) GUID to sign in against. Leave empty for your home tenant; set it to reach a tenant you are a guest in. |
| `onelakeStudio.dataCacheGB` | Disk to spend caching OneLake data files, in GB (default 20). A new snapshot writes new files, so a cached one can never be stale. `0` caches nothing. |
| `onelakeStudio.catalogTtlMinutes` | How old a catalog answer may be before it is refreshed (default 5). The last known answer is always served instantly and refreshed behind you, so a table you have opened before opens without waiting. |
| `onelakeStudio.engineMemoryLimit` | Most memory DuckDB may use, e.g. `4GB`. Empty means a quarter of the machine's RAM. |
| `onelakeStudio.bridge.enabled` | Let the website use this window's sign-in (default on). |
| `onelakeStudio.bridge.port` | The loopback port the website looks for VS Code on (default 47731). |
| `onelakeStudio.bridge.origins` | Exact website origins that may ask (default the demo site). Add your own deployment, or `http://localhost:5173` for development. |

## The website, signed in with VS Code

While this extension is running, it listens on `127.0.0.1:47731` for the OneLake Studio
website. When the site asks — from **Sign in with VS Code** on its sign-in screen, or after
**Open the Website, Signed In with VS Code** — VS Code shows which site wants to read
OneLake as which account, and you allow it once or always. The site then sends its OneLake
reads to the extension, which signs and forwards them. The token never leaves VS Code; the
page only gets loopback URLs carrying a secret that changes whenever VS Code restarts or the
account changes.

The listener answers only the origins in `onelakeStudio.bridge.origins` and refuses any
request not addressed to the loopback port by name (no DNS rebinding). It serves only
OneLake reads. If another VS Code window already holds the port, that window serves the
website and this one does not. Chrome, Edge and Firefox can reach it; Safari cannot, so the
website falls back to its own app-registration sign-in there.

## Semantic models

A workspace's **Semantic models** node lists its Power BI models from the Fabric REST API, not from
OneLake, so it needs a token in the Fabric API's audience. That is a separate sign-in, asked for only
when you click *Sign in to list semantic models* — never at startup — and for the same account the rest
of the extension uses. Exporting needs permission to read the model's definition (Contributor or above
on the workspace, or write on the model), and permission to write the lakehouse's `Files/`.

The export is the one thing the extension ever writes: a single `.bim` file under
`<lakehouse>/Files/semantic_models/`, on the command, and nowhere else — any other path is refused
before a request is sent. The write goes from the extension host straight to OneLake; the panel's
proxy still serves reads only.

## How it works

The query engine is **DuckDB 2.0 running natively in the extension host** — a real DuckDB,
not a WebAssembly build in the page. It reads Iceberg tables straight out of OneLake. Each
query runs on its own connection, so Stop interrupts exactly that query, and a result past
200,000 rows is counted rather than carried into the panel.

DuckDB's HTTP reads cannot set an Authorization header, so something has to attach the
bearer token. In the browser that is a service worker. A webview has no service worker —
`navigator.serviceWorker` is undefined there — so the extension host runs a proxy on
`127.0.0.1` instead, and the engine is pointed at it.

The token stays in the extension host and never enters the webview, which is one better
than the browser version, where the page holds it. The port is bound to loopback only and
every request must carry a random per-session secret in its path. The on-disk cache is kept
per Microsoft account, so switching accounts never serves one account's data to another.

Requires desktop VS Code on x64 or arm64 Windows, macOS or Linux: the engine is a native
library, so this does not run on vscode.dev.
