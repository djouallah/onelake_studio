# OneLake Iceberg Viewer

A **serverless, in-browser** tool to run read-only SQL against **any Apache Iceberg table in OneLake**.
You type a lakehouse path — `workspace/lakehouse.Lakehouse` — the app lists that lakehouse's Iceberg
tables, lets you **preview** any of them, and run **DuckDB SQL** directly in your browser. No backend,
no data copied to a server, and **nothing for your users to register** — they sign in with their own
Entra identity and see exactly what they already have access to.

It's built by generalizing two references:
- [rayfin-duckdb-wasm](https://github.com/djouallah/rayfin-duckdb-wasm) — Rayfin static hosting on Fabric, DuckDB-WASM, MSAL auth.
- [dbt_fabric_python_iceberg dashboard](https://github.com/djouallah/dbt_fabric_python_iceberg/blob/main/dashboard/index.html) — reading Iceberg (`read_avro` manifests → `read_parquet` data files) in DuckDB-WASM.

## How it works

```
type: workspace/lakehouse.Lakehouse
   │  (OneLake storage token from your Entra identity)
   ▼
list tables   → DFS list of Tables/  (finds folders with a metadata/ dir = Iceberg)
select table  → resolve current metadata.json → snapshot → manifest-list (Avro)
              → read manifests with read_avro → parquet data-file paths
              → register each path as a URL; DuckDB range-reads it (sw.js adds the token)
              → CREATE VIEW "schema"."table" AS read_parquet([...])
preview/query → read-only SQL in your browser → results table + CSV export
```

Everything runs client-side, and **nothing is downloaded whole**. Data files are registered as URLs, so
DuckDB issues HTTP range requests and pulls only the row groups and columns a query touches — verified
against OneLake, which answers `206 Partial Content`. `SELECT … LIMIT 100` is roughly constant-time no
matter how big the table is. The service worker ([`site/sw.js`](site/sw.js)) attaches your OneLake token
to those reads, because DuckDB's file APIs have no way to set request headers. If range reads don't work
the app fails with the reason rather than falling back to a multi-minute download.

### Why not DuckDB's `iceberg` extension?

It's available for WASM and it would bring delete-file handling and manifest-level pruning, but it
cannot resolve Fabric's paths. Fabric records **absolute** `abfs://<workspace-guid>@onelake.dfs…` URIs
inside the metadata (note the single `s`, and GUIDs rather than the friendly names you typed), and
DuckDB-WASM has no `abfs` filesystem. Measured against a real table with DuckDB 1.5.2:

```
iceberg_scan('<table root>', allow_moved_paths = true)
  -> Invalid Configuration Error: Could not create full path from Iceberg Path
     (https://onelake.dfs…/Tables/CH01/nation) and the relative path
     (abfs://…@onelake.dfs…/Tables/CH01/nation/ducklake-….parquet)
```

`allow_moved_paths` only rebases paths it considers *relative*; it refuses an absolute `abfs://` URI.
Passing the `metadata.json` instead is worse — the option treats its argument as a directory and appends
`/metadata/snap-….avro` to it (404). So the reader is attempted **only** when a table's metadata uses
relative paths (tables written by other engines); Fabric-written tables go straight to the manifest walk
instead of burning a query on a predictable failure.

## Auth: one registration, none for your users

Reading OneLake from the browser needs an Entra access token for
`https://storage.azure.com/user_impersonation`. **Rayfin cannot supply that token.** Its Fabric auth
(`services.auth.fabric.enabled`) signs the user in through the Fabric portal and returns an *opaque
Rayfin session* for Rayfin's own Data API — the SDK deliberately never exposes an Entra access token
to application code. Static hosting also serves `dist/` verbatim; nothing is injected at serve time.

So the app uses its own Entra **SPA public client** (PKCE, no secret), registered **once by whoever
publishes the app**, in the same tenant as the OneLake data. Users register nothing — they click
*Sign in*, accept a one-time consent prompt, and read OneLake with their own identity and their own
permissions. Its `clientId`/`tenantId` are committed in [`site/config.js`](site/config.js): public by
design (MSAL puts them in the sign-in URL), and committing them means a fresh clone deploys a working
app rather than a silently unauthenticated one.

### Consent — and why the app must be single-tenant

First sign-in shows **"OneLake Iceberg Viewer wants to access Azure Storage as you"**. One click, per
user, no admin.

That only holds because the registration lives **in the same tenant as the user**. This tenant's
consent policy is `microsoft-user-default-recommended`, which lets a user self-consent to an app
registered in their own directory but refuses unverified apps from any other directory with *"Need
admin approval — only an admin can grant."* A multi-tenant app registered elsewhere is therefore a
dead end here: no one can sign in until an Entra admin consents for the whole tenant.

So if you fork this into another tenant, register the SPA app **in that tenant** and put its ids in
`config.js`. Don't try to share one multi-tenant registration across organizations.

An admin who wants to suppress the per-user prompt org-wide can grant tenant-wide consent once on the
registration (**API permissions → Grant admin consent**), but nothing requires it.

### If you re-register or re-deploy

The hosting origin must be a **Single-page application** redirect URI on the registration — the
platform type matters, a "Web" or "Mobile & desktop" redirect fails from browser JS with
`AADSTS9002326`. Currently registered (bare origins, no trailing slash):

- `https://still-hawk-86bc044b26-westeurope.webapp.fabricapps.net`
- `http://localhost:5173`

If the Fabric item is recreated the hosting URL changes, and the new origin has to be added there.
The only API permission needed is **Azure Storage → Delegated → `user_impersonation`**; no client
secret, and "Allow public client flows" stays off.

## Deploy to Fabric (Rayfin)

```bash
npm install
npx rayfin up
```

After the first deploy, copy the printed webapp URL into `allowedRedirectUris` in
[`rayfin/rayfin.yml`](rayfin/rayfin.yml), run `npx rayfin up` again, and add the same URL as an SPA
redirect URI on the Entra app (see *If you re-register or re-deploy* above).

> **Open it standalone, not inside the Fabric portal iframe.** The Microsoft sign-in is blocked in the
> embedded frame; the app detects this and shows an "Open in new tab" prompt.

## Local development

```bash
npx serve site -l 5173
```

Same `site/config.js`, so nothing to fill in — `http://localhost:5173` is already an SPA redirect URI
on the registration.

## Usage

1. Sign in.
2. Type a lakehouse path, e.g. `Sales/Analytics.Lakehouse`, and press **Connect**.
3. Pick a table in the sidebar → it loads and auto-previews (`SELECT * … LIMIT 100`).
4. Edit the SQL and press **Run** (or `Ctrl/Cmd+Enter`). Loaded tables can be joined together.
5. **Download CSV** exports the current result.

## Notes & limitations

- **Iceberg only.** Delta tables are listed but greyed out (not queryable here yet).
- **Read-only.** Only `SELECT` / `WITH` / `DESCRIBE` / `SHOW` / `EXPLAIN` / `SUMMARIZE` are allowed; there is no write path to OneLake.
- **No Iceberg-level pruning** on Fabric tables (see above): every data file in the snapshot is in the view, and pruning is whatever DuckDB gets from parquet row-group statistics and column projection. Fabric's converted manifests carry `record_count = 0` anyway, so there is little to prune on.
- **Merge-on-read delete files are not applied** by the manifest walk. Fabric's Iceberg conversions are copy-on-write (manifest entries are all `content = 0`), so this doesn't affect them; a table written by Spark with positional deletes would show deleted rows. The status line names the reader that ran.
- The target folder must be a real Iceberg table (has a `Tables/…/metadata/` directory).

## Project layout

```
site/
  index.html            UI shell (lakehouse bar, table sidebar, SQL editor, results)
  app.js                DOM wiring + auth gate
  auth.js               MSAL provider (storage scope, redirect flow, silent renewal)
  data.js               Iceberg engine on DuckDB-WASM (list/resolve/manifest/load/query)
  sw.js                 service worker: COOP/COEP shim + OneLake token on DuckDB's range reads
  sw-register.js        registers sw.js, one reload so the first load is controlled
  config.js             clientId + tenantId (tracked — public identifiers, no secret)
build.mjs               static build: copies site/ -> dist/
rayfin/rayfin.yml       Rayfin service config (managed Fabric auth + static hosting)
```
