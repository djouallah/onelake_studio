# OneLake Studio for VS Code

Browse your Fabric workspaces and query OneLake Iceberg tables with DuckDB, in a panel
inside VS Code. Run **OneLake Studio: Open** from the command palette.

Sign-in is the VS Code Microsoft account you already use — there is nothing to register.
The web version needs an Entra app registration in your own tenant, because a browser has
no other way to get a OneLake token; VS Code does, so this does not ask.

The query engine is the same one that runs at
[studio.projectscontrols.com](https://studio.projectscontrols.com/) — this loads `site/`
directly rather than forking it.

## Settings

| Setting | What it does |
| --- | --- |
| `onelakeStudio.tenantId` | Directory (tenant) GUID to sign in against. Leave empty for your home tenant; set it to reach a tenant you are a guest in. |

## How it reaches OneLake

DuckDB-WASM reads data files over HTTP and its file API cannot set a header, so something
has to attach the bearer token. In the browser that is a service worker. A webview has no
service worker — `navigator.serviceWorker` is undefined there — so the extension host runs
a proxy on `127.0.0.1` instead, and the panel is pointed at it.

The token stays in the extension host and never enters the webview, which is one better
than the browser version, where the page holds it. The port is bound to loopback only and
every request must carry a random per-session secret in its path.

Requires desktop VS Code: the proxy needs Node, so this does not run on vscode.dev.
