# OneLake Studio

> **A personal project, built for learning.** It is not a Microsoft product, is not supported by
> Microsoft, the views and choices in it are my own, and there is no guarantee that DAX compiled to
> SQL here gives the same results as Power BI.

A static web app — a folder of HTML and JavaScript with no backend — so it runs from anywhere that
serves files: GitHub Pages, a blob container, a company intranet, or `npx serve` on your own machine.
[**studio.projectscontrols.com**](https://studio.projectscontrols.com/) is just a demo instance to try
it on; host your own and it behaves identically.

Read-only SQL over your own OneLake, running entirely in your browser. The SQL editor works the moment
the page loads — no account needed (DuckDB with the h3 spatial extension, fully local). Sign in with
your Microsoft work or school account to browse OneLake: pick a workspace and a lakehouse or warehouse,
and query its tables and files.

- **Fully local.** DuckDB-WASM runs in the tab. No backend, nothing uploaded, nothing copied.
- **Your identity, your data.** One delegated permission — Azure Storage `user_impersonation` — so you
  see exactly what you already have access to.
- **Read-only.** `SELECT` / `WITH` / `DESCRIBE` / `SHOW` / `EXPLAIN` / `SUMMARIZE`, nothing else.
- **No analytics, no telemetry.** Your token stays in this browser and goes only to Microsoft.

## In VS Code

[**OneLake Studio**](https://marketplace.visualstudio.com/items?itemName=djouallah.onelake-studio) on
the Marketplace is the same app in a VS Code panel, on native DuckDB 2.0, and it needs no app
registration: VS Code's own Microsoft account provider is a first-party application, so `getSession`
returns the OneLake token directly. Install it, then run **OneLake Studio: Open**.

The panel runs [`extension/app/`](extension/app/), the extension's own tracked fork of the web app —
`site/` stays the deployed website, and the fork is where the panel diverges: sign-in is VS Code's
account, the engine is native DuckDB in the extension host, and `extension/src/proxy.js` signs
OneLake reads from the host instead of a service worker, so the token never enters the page at all.

The extension also lists each workspace's **Power BI semantic models** in its tree, and
**Export .bim to Lakehouse Files and Open** turns one into a file the app can open: it reads the
model's TMSL definition with the Fabric REST API's `getDefinition`, writes it to
`Files/semantic_models/<model>.bim` in a lakehouse of the model's own workspace, and opens it as its
model (below). That needs a second token, in the Fabric API's audience, which VS Code asks for only when
you first expand *Semantic models*; and it is the extension's one write — that file, on that command,
nothing else. The website does neither: it stays read-only on its single Storage scope.

## Signing in

Signing in is only needed to reach OneLake — the editor and engine run without it.

### With your own app registration

The app signs in through an Entra app registration in **your own tenant**.
Create one, paste its two GUIDs into the sign-in screen, and this browser remembers them — a one-off.
They also go in the URL — and the page asks before using a registration a link proposes, because whoever
owns a registration decides what your sign-in may be used for:

```
https://studio.projectscontrols.com/?clientId=<application-id>&tenantId=<directory-id>
```

The registration needs exactly two things:

- Platform **Single-page application**, with the address you serve the app from as the redirect URI —
  `https://studio.projectscontrols.com/` for the demo, `http://localhost:5173/` for `npm run dev`, your
  own URL for your own copy. Entra matches it exactly, trailing slash included, and one registration can
  list several. The platform type matters: a *Web* entry fails with `AADSTS9002326`.
- API permission **Azure Storage → Delegated → `user_impersonation`**.

Nothing else: no client secret (SPA + PKCE doesn't use one), no Graph, no directory access, no
application permissions. Every read carries your own token, so the app reaches only what you can already
open, and it never writes.

With the Azure CLI, both GUIDs in one go — swap the redirect URIs for wherever you serve the app:

```bash
az rest --method POST --uri https://graph.microsoft.com/v1.0/applications \
  --headers "Content-Type=application/json" \
  --body '{
    "displayName": "OneLake Studio",
    "signInAudience": "AzureADMyOrg",
    "spa": { "redirectUris": ["https://studio.projectscontrols.com/", "http://localhost:5173/"] },
    "requiredResourceAccess": [{
      "resourceAppId": "e406a681-f3d4-42a8-90b6-c2b029497af1",
      "resourceAccess": [{ "id": "03e0da56-190b-40ad-a80c-ea378c433f7f", "type": "Scope" }]
    }]
  }' --query appId -o tsv                 # clientId
az account show --query tenantId -o tsv   # tenantId
```

`e406a681-…` is the Azure Storage resource and `03e0da56-…` its `user_impersonation` scope — the same
two constants in every tenant. This goes through Graph rather than `az ad app create` because that
command can only write `web` and `publicClient` redirect URIs; a `web` entry is the `AADSTS9002326`
case above, and `spa` is the one that works.

Whether that first sign-in is one click or waits on an approval is your tenant's consent policy, not this
app. A registration in your own directory isn't what the strict policy blocks, but a tenant can still
require admin consent for everything — an admin then grants it once from the registration's
*API permissions* page.

## How it works

```
sign in       → OneLake storage token from your Entra identity
pick workspace→ DFS "list filesystems" at the account root = your workspaces
pick item     → DFS list of the workspace root = its lakehouses and warehouses
list tables   → OneLake's Iceberg REST catalog (same token, 3 requests for a whole item)
select table  → metadata document from the catalog, inline → statistics only, no data read
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

**Repeat reads come from a local cache.** Browsers refuse to HTTP-cache `206` responses, so the service
worker caches range reads itself (Cache Storage, 512 MB cap, oldest evicted first) — but only Iceberg
data files and manifests under `Tables/`, which are immutable by design: a new snapshot writes new
files, so a cached one can never be stale. Listings, metadata pointers and anything under `Files/` are
always fetched fresh. Signing out deletes the cache along with the token, so neither the credential nor
the data it fetched outlives the session on a shared machine.

**Iceberg is the read path for everything, and the catalog is the only way in.** OneLake publishes
lakehouse and warehouse tables through a read-only Iceberg REST catalog that takes the same storage
token: three requests list a whole item, and opening a table gets its metadata document inline. Nothing
walks `Tables/` over DFS. That walk cost one directory listing per table, never worked for warehouses
(they have no `metadata/` directory at all), and the only thing it ever added — measured across every
item kind this app opens — was an empty leftover directory shown as a table that could not be opened.
Fabric generates that metadata lazily, so a first request can in principle lose the race to its own
conversion; resolution retries with a backoff sized to the documented 5s–2min window, says so on the
status line, and Stop works throughout. If the catalog refuses, the app shows what it said rather than
guessing.

**A `.bim` under `Files/` opens as its semantic model** — on the website and in VS Code — in place of the editor, on
three pages:

- **Model**: its tables as a star, dimensions in the middle and facts around them, with its
  relationships. Click a table for its columns, measures (with their DAX) and relationships.
- **SQL**: SQL in which `SELECT … FROM <model>` asks the model. `AGG(m)` is measure `m`, computed
  with DAX's semantics by [dax-sql](https://github.com/djouallah/dax-sql), which compiles the
  query to plain SQL in the tab:

  ```sql
  SELECT dim_region.Region, AGG("Registered MW") AS mw FROM nem GROUP BY ALL
  ```

  A model query can also be a subquery or CTE inside SQL of your own. Preview, Show plan and
  Download CSV.
- **Explore**: drag the model's columns onto Rows, Columns and Filters, and its measures onto
  Values, to get a pivot table or a chart.

The model is named after its file (`nem.bim` is `nem`), and the main editor can query it too, as
can `DESCRIBE nem`. A Direct Lake table is read from the lakehouse its model names, through the
same Iceberg catalog, whichever item is selected, and only when a query actually reads it. The
model comes from the file: in VS Code, export it from the tree (above); for the website, export it once
with Fabric's `getDefinition` (TMSL) — the website itself never calls the Fabric API.

## Limitations

- **A lakehouse with no schemas of its own lists its tables under `dbo`.** That's the synthetic
  namespace OneLake's catalog reports for those items, so generated SQL reads `FROM "dbo"."sales"`.
- **An item its catalog can't serve shows an error rather than a table list.** There is no DFS
  fallback; re-picking the item tries again.
- **Merge-on-read equality deletes are not applied.** They're detected and the status line warns; Fabric's
  own conversions are copy-on-write, so this doesn't affect them. Position deletes *are* applied (and
  verified — deletes that match no data file raise a warning instead of silently returning dead rows).
- **Column renames aren't merged.** Iceberg renames are metadata-only, and this reader matches parquet
  columns by name, not field ID — a renamed column shows up as two half-NULL columns, with a warning.
  Added columns are handled (`union_by_name`).
- **No Iceberg-level pruning** — Fabric's conversion writes zeroed manifest statistics, so there'd be
  nothing to prune on. Pruning is whatever parquet row-group stats and column projection give you.
- **Only parquet, DuckDB databases and zip directories are read lazily.** A database file under `Files/` (`.duckdb`,
  `.ddb`, `.db`, `.sqlite`) is opened by sniffing its header, never its extension. A DuckDB file is
  ATTACHed read-only and block-read on demand — tables queryable as `<name>.<schema>.<table>`. A SQLite
  file is read by sql.js and **copied** into DuckDB tables (`<name>.<table>`, capped at 200 MB, BLOBs
  come through as NULL) — DuckDB's own sqlite extension cannot open any browser-supplied file in WASM.
  CSV, JSON, avro, xlsx and plain text have no block structure either, so DuckDB pulls those whole; the
  status line says so rather than claiming "read on demand". A `.zip` under `Files/` is listed via its
  central directory (a range read at the tail — the archive is not downloaded) and every readable entry
  becomes a view; entries decompress when queried.
- **Results are capped at 200,000 materialised rows** (the status line says when a query hits it) — the
  browser tab is the database, and an uncapped `SELECT *` on a 50M-row table would take it down.

## Run it yourself

```bash
npm install
npm run dev        # serves site/ on http://localhost:5173 — add that as a redirect URI to sign in
npm test           # node --test over the engine's pure logic (paths, SQL guard, cache keys)
```

No bundler — DuckDB-WASM and MSAL come from a CDN, and `npm run build` copies `site/` → `dist/` and
stamps the commit into `version.js` (shown bottom-right in the app, so a cached build identifies itself).
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs the tests and deploys to GitHub Pages
on every push. [`test/sql-integration.html`](test/sql-integration.html) is a manual harness that runs the
engine's generated SQL against real DuckDB-WASM — copy it into `site/`, `npm run dev`, and open it.

To host your own copy: fork it, register an SPA app with **your** URL as the redirect URI, and set
*Settings → Pages → Source: GitHub Actions*. Users can name that registration on the sign-in screen; an
internal deploy can skip the asking by putting its `clientId` — and a tenant GUID in `authority` to pin
it — in [`site/config.js`](site/config.js), which ships empty here.

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
site/semantic.js  .bim models -> dax-sql       site/analyze/  a .bim's view: Model, SQL, Explore
```
