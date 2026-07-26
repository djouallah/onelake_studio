# OneLake Studio

**[Open the app →](https://djouallah.github.io/onelake_studio/)**

Read-only SQL over **your own** OneLake, running entirely in your browser. Sign in with your Microsoft
work or school account, pick a workspace and a lakehouse or warehouse from a catalog the app discovers
itself, and query its Iceberg tables and lakehouse files with **DuckDB-WASM**.

There is no backend. Nothing is uploaded, nothing is proxied, and there is nothing for you to install or
register — you see exactly the data your own identity already has access to.

- **Everything runs locally.** The query engine is DuckDB-WASM, in the tab.
- **Your data is never copied.** Parquet is read straight from OneLake into the browser, mostly as HTTP
  range requests — only the row groups and columns a query touches.
- **One permission.** Azure Storage `user_impersonation`, used solely to read OneLake as you.
- **Read-only.** Only `SELECT` / `WITH` / `DESCRIBE` / `SHOW` / `EXPLAIN` / `SUMMARIZE` are accepted.
- **No analytics, no telemetry.** The access token stays in your browser and goes only to Microsoft.

It's built by generalizing two references:
- [rayfin-duckdb-wasm](https://github.com/djouallah/rayfin-duckdb-wasm) — DuckDB-WASM in a static Fabric app, MSAL auth.
- [dbt_fabric_python_iceberg dashboard](https://github.com/djouallah/dbt_fabric_python_iceberg/blob/main/dashboard/index.html) — reading Iceberg (`read_avro` manifests → `read_parquet` data files) in DuckDB-WASM.

## How it works

```
sign in       │  (OneLake storage token from your Entra identity)
   ▼
pick workspace→ DFS "list filesystems" at the account root = your workspaces
pick item     → DFS list of the workspace root, filtered to Lakehouse/Warehouse/…
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

It would bring delete-file handling, schema evolution and manifest-level pruning, and it *is* usable
here — but it returns wrong answers on Fabric tables, so it isn't used.

Fabric records **absolute** `abfs://<workspace-guid>@onelake.dfs…` URIs inside the metadata (note the
single `s`, and GUIDs rather than the friendly names), and DuckDB-WASM has no `abfs` filesystem. The
documented escape hatch doesn't help — `allow_moved_paths` only rebases paths it considers *relative*
and refuses an absolute URI:

```
iceberg_scan('<table root>', allow_moved_paths = true)
  -> Invalid Configuration Error: Could not create full path from Iceberg Path
     (https://onelake.dfs…/Tables/CH01/nation) and the relative path
     (abfs://…@onelake.dfs…/Tables/CH01/nation/ducklake-….parquet)
```

What *does* work is registering each `abfs://` path as a **file name** aliased to its https URL
(`registerFileURL(abfsPath, httpsUrl, HTTP, false)`); DuckDB-WASM's file registry resolves the alias
before it ever tries to parse the scheme, and `iceberg_scan` then reads the table fine.

The blocker is elsewhere. Measured in the browser against a real table:

| query | result |
| --- | --- |
| `SELECT count(*)` | **0** |
| materialized, then counted | 25 (correct) |

`count(*)` is answered from manifest statistics, and Fabric's Iceberg conversion writes
`record_count = 0`. Silently returning zero for the most common query in this app is a worse trade than
the pruning the extension would buy — and pruning reads those same zeroed statistics, so it wouldn't
deliver either. The one thing it gave us for free, delete files, is handled directly instead
(see below).

## Sign-in, consent, and what to do if it says "Need admin approval"

Reading OneLake from a browser needs an Entra access token for
`https://storage.azure.com/user_impersonation`. The app uses an Entra **SPA public client** (PKCE, no
secret), registered once by the publisher and **multi-tenant**, so any work or school account can sign
in against its own directory. Its `clientId` is committed in [`site/config.js`](site/config.js): public
by design (MSAL puts it in every sign-in URL), and committing it is what makes a fresh clone deploy a
working app instead of a silently unauthenticated one.

Whether your first sign-in is one click or a stop sign depends on **your tenant's consent policy**, not
on this app:

- Tenants that allow user consent to any app: you accept one prompt and you're in.
- Tenants on the *recommended* policy (`microsoft-user-default-recommended`, the common default): user
  consent is allowed only for *"apps from verified publishers and apps registered in your tenant"*.
  This app is **not publisher-verified yet**, so you'll see **"Need admin approval"**.

That is designed behaviour for an unverified multi-tenant app, and the sign-in screen hands you both
fixes rather than stopping there:

1. **An admin grants consent once** for the whole tenant (see below).
2. **Use your own app registration** — no admin, no fork, no deploy.

### Use your own app registration

Register an app in your own tenant (a foreign app is what the policy blocks; your own directory's app is
not), then open the app with it:

```
https://djouallah.github.io/onelake_studio/?clientId=<application-id>&tenantId=<directory-id>
```

The choice is stored in this browser's `localStorage`, so it survives the sign-in redirect and later
visits; the gate has a link to switch back. The registration needs exactly:

- Platform **Single-page application** with redirect URI `https://djouallah.github.io/onelake_studio/`
  — the platform type matters, a "Web" or "Mobile & desktop" entry fails from browser JS with
  `AADSTS9002326`.
- API permission **Azure Storage → Delegated → `user_impersonation`**.
- No client secret; "Allow public client flows" stays off.

### For admins

You are being asked to consent to a third-party app that reads OneLake **as the signed-in user**. What
that means concretely:

- **Permission requested:** Azure Storage `user_impersonation` (delegated) — and nothing else. No Graph,
  no directory read, no application permissions, no offline background access beyond MSAL's normal
  refresh token in the user's browser.
- **Delegated, so it can never exceed the user.** Every OneLake read carries that user's token; the app
  cannot see a workspace they can't already open, and it issues no writes.
- **No backend.** The app is static files on GitHub Pages; data goes from OneLake to the user's browser
  directly. There is no server of ours in the path, and no telemetry.
- **Grant it once, for everyone:**

  ```
  https://login.microsoftonline.com/organizations/adminconsent?client_id=cbc29592-5f49-45ac-8a69-ca6d7030ab74&redirect_uri=https%3A%2F%2Fdjouallah.github.io%2Fonelake_studio%2F
  ```

- **Review or revoke later:** Entra admin center → *Enterprise applications* → **OneLake Studio** →
  *Permissions* / *Properties → Delete*. Users can also revoke their own grant at
  [myapps.microsoft.com](https://myapps.microsoft.com).
- **It is not publisher-verified.** There's no blue "verified" badge, and the consent screen says so.
  Verification requires a Microsoft Cloud Partner Program account as the Partner Global Account; it's a
  planned upgrade, not a claim being made today. Read the source before granting — that's the point of
  the repo being public.

If you'd rather not consent at all, users in your tenant can point the app at a registration of your own
with the `?clientId=` route above.

## Deploy your own copy

The app is static files; any HTTPS host works. This repo publishes itself with
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) — `npm run build` copies `site/` → `dist/`,
and `actions/deploy-pages` serves it.

To run your own instance, fork it, register an SPA app as described above with **your** Pages URL as the
redirect URI, put its `clientId` in [`site/config.js`](site/config.js) (use `authority: "organizations"`
for multi-tenant, or your tenant GUID to pin it to one directory), and enable Pages with
*Settings → Pages → Source: GitHub Actions*.

## Local development

```bash
npm install
npm run dev
```

Serves `site/` on `http://localhost:5173`, which is already a registered SPA redirect URI, so sign-in
works locally with the same committed `config.js`. There's no bundler — the page loads DuckDB-WASM and
MSAL from a CDN — so the only dev dependency is a static file server.

## Usage

1. Sign in.
2. Pick a **workspace**, then a **lakehouse or warehouse**. Both lists come from OneLake itself.
3. Pick a table in the sidebar → it loads and auto-previews (`SELECT * … LIMIT 100`). Switch the
   sidebar to **Files** to browse the lakehouse's `Files/` tree instead and query a parquet, CSV or
   JSON file the same way.
4. Edit the SQL and press **Run** (or `Ctrl/Cmd+Enter`). Loaded tables can be joined together.
5. **Download CSV** exports the current result.

## Notes & limitations

- **Iceberg only** under `Tables/`. Delta tables are listed but greyed out (not queryable here yet).
- **Under `Files/`**, parquet / csv / tsv / json / jsonl are queryable and everything else is greyed out. Only parquet is read lazily — CSV and JSON have no footer or row groups, so DuckDB streams the whole file whatever its size, and the status line says so rather than claiming "read on demand".
- **Read-only.** Only `SELECT` / `WITH` / `DESCRIBE` / `SHOW` / `EXPLAIN` / `SUMMARIZE` are allowed; there is no write path to OneLake.
- **No Iceberg-level pruning** on Fabric tables (see above): every data file in the snapshot is in the view, and pruning is whatever DuckDB gets from parquet row-group statistics and column projection. Fabric's converted manifests carry `record_count = 0` anyway, so there is little to prune on.
- **Merge-on-read delete files are not applied** by the manifest walk — they're detected and excluded from the scan, but their deletions aren't subtracted. Fabric's Iceberg conversions are copy-on-write (manifest entries are all `content = 0`), so this doesn't affect them and nothing is printed; if a table does have delete files the status line warns that deleted rows may still appear.
- The target folder must be a real Iceberg table (has a `Tables/…/metadata/` directory).
- **The catalog needs no extra permission.** Workspaces come from the ADLS Gen2 *List Filesystems* call at the OneLake account root and items from a listing of the workspace root, both on the same `storage.azure.com` token the data reads use — so there's no Fabric REST API call, no extra Entra scope and no second consent prompt. You see exactly the workspaces your identity can already reach.
- **Not inside an iframe.** Microsoft sign-in is blocked in an embedded frame; the app detects this and offers an "Open in new tab" link.

## Project layout

```
site/
  index.html            UI shell (sign-in gate + trust panel, catalog bar, sidebar, SQL editor, results)
  app.js                DOM wiring + auth gate (consent help, own-registration override)
  auth.js               MSAL provider (storage scope, redirect flow, silent renewal, registration override)
  data.js               Iceberg engine on DuckDB-WASM (list/resolve/manifest/load/query)
  sw.js                 service worker: COOP/COEP shim + OneLake token on DuckDB's range reads
  sw-register.js        registers sw.js, one reload so the first load is controlled
  config.js             clientId + authority (tracked — public identifiers, no secret)
build.mjs               static build: copies site/ -> dist/
.github/workflows/pages.yml   builds and deploys to GitHub Pages on push to main
```
