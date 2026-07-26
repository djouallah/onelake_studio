# OneLake Studio

**[Open the app →](https://studio.projectscontrols.com/)**

Read-only SQL over your own OneLake, running entirely in your browser. Sign in with your Microsoft work
or school account, pick a workspace and a lakehouse or warehouse, and query its tables and files.

- **Fully local.** DuckDB-WASM runs in the tab. No backend, nothing uploaded, nothing copied.
- **Your identity, your data.** One delegated permission — Azure Storage `user_impersonation` — so you
  see exactly what you already have access to.
- **Read-only.** `SELECT` / `WITH` / `DESCRIBE` / `SHOW` / `EXPLAIN` / `SUMMARIZE`, nothing else.
- **No analytics, no telemetry.** Your token stays in this browser and goes only to Microsoft.

## Signing in

The app is registered as a multi-tenant Entra SPA (PKCE, no secret), so any work or school account can
sign in against its own directory. Its `clientId` is committed in [`site/config.js`](site/config.js) —
public by design, since MSAL puts it in every sign-in URL.

Whether your first sign-in is one click or a stop sign depends on **your tenant's consent policy**, not
on this app. Most tenants allow user consent only for *"apps from verified publishers and apps registered
in your tenant"*. This app isn't publisher-verified, so you may get **"Need admin approval"**. The
sign-in screen offers both ways through:

### For admins

One click grants it for the whole tenant:

```
https://login.microsoftonline.com/organizations/adminconsent?client_id=cbc29592-5f49-45ac-8a69-ca6d7030ab74&redirect_uri=https%3A%2F%2Fstudio.projectscontrols.com%2F
```

What you're approving: **Azure Storage `user_impersonation`, delegated, and nothing else** — no Graph, no
directory access, no application permissions. Every read carries the signed-in user's own token, so the
app can't reach anything they couldn't already open, and it never writes. Review or revoke later under
*Enterprise applications → OneLake Studio*; users can revoke their own grant at
[myapps.microsoft.com](https://myapps.microsoft.com).

### Use your own app registration

No admin needed — an app from your own tenant isn't what the policy blocks:

```
https://studio.projectscontrols.com/?clientId=<application-id>&tenantId=<directory-id>
```

Saved in this browser, so it's a one-off. The registration needs only: platform **Single-page
application** with redirect URI `https://studio.projectscontrols.com/` (the platform type matters — a
"Web" entry fails with `AADSTS9002326`), and **Azure Storage → Delegated → `user_impersonation`**. No
client secret.

## How it works

```
sign in       → OneLake storage token from your Entra identity
pick workspace→ DFS "list filesystems" at the account root = your workspaces
pick item     → DFS list of the workspace root = its lakehouses and warehouses
list tables   → OneLake's Iceberg REST catalog (same token, 3 requests);
                falls back to walking Tables/ over DFS if it's unreachable
select table  → metadata document from the catalog (or metadata.json over DFS)
              → snapshot → manifest list (Avro) → parquet data-file paths
              → register each as a URL; DuckDB range-reads it (sw.js adds the token)
preview/query → read-only SQL in your browser → results + CSV export
```

**Nothing is downloaded whole.** Data files are registered as URLs, so DuckDB issues HTTP range requests
and pulls only the row groups and columns a query touches — OneLake answers `206 Partial Content`, and
`SELECT … LIMIT 100` is roughly constant-time however big the table is. The service worker
([`site/sw.js`](site/sw.js)) attaches your token to those reads, because DuckDB's file APIs can't set
headers. It also supplies the COOP/COEP headers that GitHub Pages can't, which is why the first load
reloads itself once.

**Iceberg is the read path for everything.** OneLake publishes lakehouse tables in both formats,
generating Iceberg metadata on demand — the first request triggers it and loses the race, so resolution
retries with a backoff sized to the documented 5s–2min conversion window. A table whose metadata hasn't
been generated yet shows as *converting* but stays clickable: opening it waits, and if conversion failed
the app reads Fabric's conversion log and shows the actual reason (most often the tenant/workspace
Delta-to-Iceberg setting being off).

## Limitations

- **Merge-on-read equality deletes are not applied.** They're detected and the status line warns; Fabric's
  own conversions are copy-on-write, so this doesn't affect them. Position deletes *are* applied (and
  verified — deletes that match no data file raise a warning instead of silently returning dead rows).
- **Column renames aren't merged.** Iceberg renames are metadata-only, and this reader matches parquet
  columns by name, not field ID — a renamed column shows up as two half-NULL columns, with a warning.
  Added columns are handled (`union_by_name`).
- **No Iceberg-level pruning** — Fabric's conversion writes zeroed manifest statistics, so there'd be
  nothing to prune on. Pruning is whatever parquet row-group stats and column projection give you.
- **Only parquet is read lazily.** CSV, JSON, avro, xlsx and plain text have no footer or row groups, so
  DuckDB pulls the whole file; the status line says so rather than claiming "read on demand".
- **Results are capped at 200,000 materialised rows** (the status line says when a query hits it) — the
  browser tab is the database, and an uncapped `SELECT *` on a 50M-row table would take it down.

## Run it yourself

```bash
npm install
npm run dev        # serves site/ on http://localhost:5173, an already-registered redirect URI
npm test           # node --test over the engine's pure logic (paths, SQL guard, cache keys)
```

No bundler — DuckDB-WASM and MSAL come from a CDN, and `npm run build` copies `site/` → `dist/` and
stamps the commit into `version.js` (shown bottom-right in the app, so a cached build identifies itself).
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs the tests and deploys to GitHub Pages
on every push. [`test/sql-integration.html`](test/sql-integration.html) is a manual harness that runs the
engine's generated SQL against real DuckDB-WASM — copy it into `site/`, `npm run dev`, and open it.

To host your own copy: fork it, register an SPA app with **your** URL as the redirect URI, put its
`clientId` in [`site/config.js`](site/config.js), and set *Settings → Pages → Source: GitHub Actions*.

**Don't serve it from `*.github.io`.** Measured, not theoretical: Windows Enhanced Phishing Protection
blocked the `github.io` URL outright — that feature watches for Microsoft credential entry on
non-Microsoft sites, and `github.io` is a shared domain with a long phishing history. Use a hostname on a
domain you control ([`site/CNAME`](site/CNAME) plus a DNS CNAME to `<user>.github.io`), ideally an
established one — a brand-new domain has no reputation either.

## Layout

```
site/index.html   UI shell + sign-in gate      site/data.js   Iceberg engine on DuckDB-WASM
site/app.js       DOM wiring                   site/paths.js  pure logic (paths, SQL, cache keys)
site/auth.js      MSAL provider                site/sw.js     COOP/COEP + token injection
site/config.js    clientId + authority         test/          node --test suite for paths.js
```
