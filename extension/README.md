# OneLake Studio for VS Code

Browse your Fabric workspaces and query OneLake Iceberg tables with DuckDB, in a panel
inside VS Code. Open it from the OneLake Studio icon in the activity bar, or run
**OneLake Studio: Open** from the command palette.

Sign-in is the VS Code Microsoft account you already use — there is nothing to register.
The web version needs an Entra app registration in your own tenant, because a browser has
no other way to get a OneLake token; VS Code does, so this does not ask.

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

## Settings

| Setting | What it does |
| --- | --- |
| `onelakeStudio.tenantId` | Directory (tenant) GUID to sign in against. Leave empty for your home tenant; set it to reach a tenant you are a guest in. |
| `onelakeStudio.dataCacheGB` | Disk to spend caching OneLake data files, in GB (default 20). A new snapshot writes new files, so a cached one can never be stale. `0` caches nothing. |
| `onelakeStudio.catalogTtlMinutes` | How old a catalog answer may be before it is refreshed (default 5). The last known answer is always served instantly and refreshed behind you, so a table you have opened before opens without waiting. |

## How it works

The query engine is **DuckDB running natively in the extension host** — a real DuckDB, not
a WebAssembly build in the page. It reads Iceberg tables straight out of OneLake.

DuckDB's HTTP reads cannot set an Authorization header, so something has to attach the
bearer token. In the browser that is a service worker. A webview has no service worker —
`navigator.serviceWorker` is undefined there — so the extension host runs a proxy on
`127.0.0.1` instead, and the engine is pointed at it.

The token stays in the extension host and never enters the webview, which is one better
than the browser version, where the page holds it. The port is bound to loopback only and
every request must carry a random per-session secret in its path.

Requires desktop VS Code on x64 or arm64 Windows, macOS or Linux: the engine is a native
library, so this does not run on vscode.dev.
