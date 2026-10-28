# OneLake Studio for VS Code — architecture

- **Read only.** Nothing is ever written to Fabric or OneLake — not by the host, not by DuckDB,
  not by SQL the page sends: the host refuses any statement that could write.
- **Cache as much as possible.** Every answer OneLake or Fabric gave is kept on this machine and
  served from there first; the network is asked only when nothing is cached, or the cached
  answer is past its window.

The extension host in [`src/`](../src/) does sign-in, every OneLake read (cache first) and the query
engine; its panel, [`app/`](../app/), is only a view.

## Commands

| Command | What it does |
| --- | --- |
| **OneLake Studio: Open** | Opens the panel, signing in if needed. |
| **OneLake Studio: Sign in to OneLake** | Signs in and fills the explorer, without opening the panel. |
| **OneLake Studio: Switch Microsoft Account** | Asks which account to use instead of reusing the remembered one, and reopens the panel so the previous account's tables do not survive the switch. To sign out altogether, use the Accounts menu in the bottom left — that is VS Code's to own, not an extension's. |
| **OneLake Studio: Refresh** | Re-reads a workspace, item or folder from OneLake in the foreground. Everything else is served from the cache first and refreshed behind you. |
| **OneLake Studio: Group by Type** / **Group by Workspace** | The explorer's title-bar toggle. By type, the top level is one heading per type — Lakehouses, Warehouses, SQL databases…, Semantic models, Apps — over every workspace, each item with its workspace beside it. The first time, it lists each workspace once; after that it is drawn from the cache. Remembered. |
| **OneLake Studio: Show Read Log** | Every OneLake request the extension made, with sizes and timings. |
| **OneLake Studio: Clear Cached OneLake Data** | Empties the on-disk cache (listings, table metadata, first rows, files, table data) and reports what it freed. It is the only thing that does: the cache survives a sign-out. |
| **OneLake Studio: Install Agent Skill (Claude Code, GitHub Copilot)** | Lets Claude Code or GitHub Copilot answer questions about your OneLake data and semantic models (below). |

Saving a result as CSV, or a file from `Files/`, goes through VS Code's own save dialog.

## Generate Report

To start a report, right-click an Apache Ossie model (`.yaml`) in a lakehouse's `Files/` and choose
**Generate Report…**. It writes a folder to this machine with a Fabric app you can deploy. The app
is a Rayfin project that runs DuckDB-WASM in the browser and reads the model's tables from the
lakehouse's OneLake Iceberg catalog. Its page has one chart: the model's first measure, by a
column that slices it.

**What you need**
- **The model is the only input.** Its Direct Lake expression must hold
  `https://onelake.dfs.fabric.microsoft.com/<workspace id>/<lakehouse id>`, which gives the
  catalog the app reads.
- A model that names no lakehouse, or names two, is refused.

**Where the files come from** ([`src/report.js`](../src/report.js))
- The template is [analytics-as-code](https://github.com/djouallah/analytics-as-code)'s
  `dashboard/fabric_app/iceberg`, plus the generic modules of its page.
- It is vendored at a pinned commit (`PINS.reportTemplate` in
  [`src/vendored.js`](../src/vendored.js)), so generating needs no network.
- The DAX compiler is the extension's own dax-sql.

**Deploying**
- Nothing is deployed for you: the folder's `npm run deploy` is yours to run.
- The folder's `AGENTS.md` is written for an agent that grows the report from there.

## Explore and Logs

A semantic model opens as **Explore** ([`app/explore/`](../app/explore/)), on three pages:
- **Model:** the star of its tables and relationships.
- **Pivot:** the model's fields dragged onto shelves, drawn as a pivot or a chart.
  - Every view is one **SELECT … FROM <model>** in dax-sql's SQL (`modelSql`): columns,
    `AGG("measure")`, summarised columns, and `ROLLUP` totals.
  - **Show SQL** swaps the pivot for that SQL in a box you can edit and run.
  - **Show plan** profiles it (`profile.js`: DuckDB's `EXPLAIN ANALYZE` as totals, a timeline and
    the costly operators) next to its plan tree.
- **Logs:** what the session ran, with timings (`logs.js`, `perflog.js`).

These files are owned here. analytics-as-code takes its Explore and Logs from this repo, not the
other way round; its dashboard stays its own. `view.js` is host-neutral: the host passes in the
compiler, how to run SQL, and where ECharts comes from.
- **The panel** runs on the native engine in the extension host (multithreaded, reading OneLake with
  your token). The engine sets the profile's metrics before it locks its configuration.
- **The Fabric app** runs the same files on DuckDB-WASM.

## Export to Fabric

Explore's **Export to Fabric** button publishes that model's Explore and Logs, nothing else, as a
Fabric app (item type `AppBackend`, named `<model>-explore`). It also writes a local copy: to the
folder approved last time for that model, or else `<the folder VS Code has open>/<model>-explore/`,
or else one you pick. Before anything is written it shows where, and waits for *Export* or *Choose
Another Folder…*. VS Code and the extension are all it needs: no CLI, no Node, no GitHub.

**What you need**
- **The model is a OneLake file** in a lakehouse's `Files/`.
- **It names exactly one lakehouse** in its Direct Lake expression. Without that, the button isn't
  shown.
- **Every table names its source as `schema.table`**, with a table name of letters, digits and `_`.
- **The workspace allows OneLake user-delegated SAS tokens.**

**How it behaves**
- **Protected:** the site loads only for people who may open the app item.
- **The model is read in place:** the app never holds a copy. Its function reads the model file
  from the lakehouse at run time (its `MODEL_URL` secret), so the app shows the model as it is
  there.
- **No silent takeover:** a re-export updates the item the last export created (its id is kept in
  the local copy). If an app of that name already exists and no export created it, the export
  stops and asks before replacing it.
- **Local edits are never overwritten unasked.** The local copy's marker keeps a hash of each of
  its files as last published (`site/`, `rayfin/`, `AGENTS.md`, `.gitignore`, without
  `node_modules` or `dist/`). If any changed, the export asks: *Overwrite Local Changes* (rewrite it
  from this Explore), *Publish Folder As Is* (publish your changes, leave the folder alone), or
  cancel.
- **A newer deploy is never overwritten unasked.** The marker keeps the app's last deploy time, by
  Fabric's clock (`__private/deploy/status`). If the app was deployed again since, from anywhere
  else, the export asks before replacing it.
- **A folder the export didn't write** is refused.
- All the questions come before anything is written, locally or in Fabric.

**The template** ([`fabric_app/`](../fabric_app/), tracked here)
- **`site/`:** the page, black always. Its data source (`storage/`) does three things:
  - signs in with Rayfin's Fabric SSO;
  - takes the model and the tables' locations from the app's function, with a read-only SAS;
  - downloads the tables' files into the browser, where DuckDB-WASM 1.5 (from jsDelivr) reads them
    as `v_<table>` views.
- **`rayfin/`:** `rayfin.yml` and the function (`openCatalog`).

[`src/exportapp.js`](../src/exportapp.js) writes the local copy from `fabric_app/`, Studio's
`app/explore/` and dax-sql. Its `dist/` is `site/` stamped with the build, plus
`rayfin.config.json`, zipped in-process.

**Publishing** ([`src/fabricapp.js`](../src/fabricapp.js)) is the REST sequence that `rayfin up`
runs, in the same order, using the user's Fabric-audience token:
1. Find the item, or create it.
2. Wait for its backend, then fetch the publishable key.
3. Apply the runtime settings.
4. Set the `CATALOG_URL` and `MODEL_URL` secrets.
5. Upload the site.
6. Deploy the function and poll it until it is done.
7. Add the hosting URL to the sign-in redirects.

The function's deploy package (an esbuild bundle plus its metadata) is built once, at package time,
by [`scripts/function-bundle.mjs`](../scripts/function-bundle.mjs) with Rayfin's own packager, from
`fabric_app/rayfin`. It ships in the vsix under `fabric-function/`.

## Settings

| Setting | What it does |
| --- | --- |
| `onelakeStudio.tenantId` | Directory (tenant) GUID to sign in against. Leave empty for your home tenant; set it to reach a tenant you are a guest in. |
| `onelakeStudio.catalogTtlMinutes` | How old a listing may be before it is refreshed (default 5). The last known answer is always served instantly from disk and refreshed behind you. |
| `onelakeStudio.tableMetadataTtlHours` | How old a table's Iceberg metadata may be before it is refreshed (default 24), so a table you have opened before opens without asking the catalog — even after a restart. **Refresh** on its lakehouse re-reads it at once. |
| `onelakeStudio.prefetchMetadata` | Read every table's metadata in the background once a lakehouse's Tables node is opened, so the first click is a disk read (default on). |
| `onelakeStudio.semanticModelsFolder` | Where a semantic model's `.bim` is downloaded (`<folder>/<workspace>/<model>.bim`) and opened from after that. Empty means `OneLakeStudio/semantic-models` in your home directory. |
| `onelakeStudio.diskCacheMaxGB` | How much table data read from OneLake is kept on disk, per account, so it is read from this machine afterwards, even after a restart (default 10). |
| `onelakeStudio.engineMemoryLimit` | Most memory DuckDB may use, e.g. `4GB`. Empty means a quarter of the machine's RAM. |

## Ask Claude Code or GitHub Copilot about your data

**Install Agent Skill** writes a skill to `~/.claude/skills/onelake/`, where both Claude Code and
GitHub Copilot in VS Code (agent mode) look for personal skills. Either then
answers questions about OneLake and Power BI semantic models itself: it lists workspaces,
lakehouses and models, reads a model's measures and their DAX, and computes measures by any
column — `SELECT dim_customer.Region, AGG("Total Sales") FROM sales_model GROUP BY ALL` — on the
same sign-in, cache, DuckDB and DAX compiler as the panel, read only. The skill runs the
extension's `bin/cli.mjs` with Node.js, which only hands the question to the extension running in
VS Code and prints its answer — so VS Code has to be open, signed in. The skill follows the
extension through updates. It can also run a DAX query against a model, print the SQL a
model query or DAX compiles to, and check a measure against its raw table.

## Sign-in, the engine and the cache

[**OneLake Studio**](https://marketplace.visualstudio.com/items?itemName=djouallah.onelake-studio) needs
no app registration: VS Code's own Microsoft account provider is a first-party application, so
`getSession` returns the OneLake token directly.

The query engine is **DuckDB 2.0 running natively in the extension host**
([`src/engine-host.js`](../src/engine-host.js)) — a real DuckDB, not a WebAssembly
build in the page. It reads OneLake itself through its `iceberg` and `azure` extensions: a table is
read with `iceberg_scan` on the metadata file the host's cache holds — the catalog is never asked at
query time — and `Files/` objects are read as `abfss://` URLs. DuckDB therefore does the Iceberg
work itself — snapshot resolution, manifest filtering, position and equality deletes,
schema evolution. Each query runs on its own connection, so Stop interrupts exactly that query, and a
result past 200,000 rows is counted rather than carried into the panel.

The token lives only in the extension host, in a DuckDB storage secret; when VS Code hands back a new
one, the secret is reissued. The page holds no credential and makes no
OneLake request: it reaches the host through one message channel, and only through `query`, `stream`,
`cancel`, `info` and the host's OneLake reads ([`src/host.js`](../src/host.js)).
File access is locked down to the temp directory, `https://`, `abfss://` and `zip://` over a remote
archive, and the page's SQL is checked in the host ([`src/sql.js`](../src/sql.js)): one statement,
a read, or the page's own views, schemas and `READ_ONLY` attaches — never `COPY`, `INSERT`,
`EXPORT` or anything else that writes.

Listings (workspaces, items, tables, `Files/`, semantic models), table metadata and first rows
are served cache-first from disk ([`src/onelake.js`](../src/onelake.js)) and refreshed behind you.
The bytes of a `Files/` object (an image, a `.bim`, a SQLite copy, a saved file) are kept under
the etag its cached listing gave, so a rewritten file is read again and an unchanged one never
is. Table data — Iceberg files never change once written — is kept by DuckDB's disk cache
(cache_httpfs); the vsix carries a build of it with a Windows fix not yet released upstream
(without it, nothing is cached on disk on Windows), which DuckDB loads as an unsigned extension
until the fix ships. The cache is kept per Microsoft account, so switching accounts never serves
one account's data to another; it survives a sign-out (signing back in finds it warm), and only
**Clear Cached OneLake Data** deletes it.

The extension also lists each workspace's **Power BI semantic models** in its tree. Clicking one
downloads its TMSL definition (the Fabric REST API's `getDefinition`) to a `.bim` on this machine —
`~/OneLakeStudio/semantic-models/<workspace>/<model>.bim`, or `onelakeStudio.semanticModelsFolder` —
and opens it as its model (below). That file is the cache: later clicks open it without asking Fabric,
the tree marks the model *cached*, and **Download Again** fetches it fresh. That needs a second token, in the Fabric API's audience, which VS
Code asks for only when you first expand *Semantic models*. Downloading a model needs permission to
read its definition (Contributor or above on the workspace, or write on the model). The extension
is read only by design: it
writes nothing to Fabric or OneLake.

Each workspace also has an **Apps** node: its Fabric apps (`AppBackend` items), however they were
made, listed with the Fabric API's item listing. Each shows its URL and when it was last deployed,
from the app's deploy status (`GET …/appBackends/<id>/__private/deploy/status`), and whether its site
is **public** or **protected**, from its runtime settings (`GET …/__private/projectRuntimeSettings`,
`staticHosting.anonymousAccess`; nothing else from that answer is kept). Public means anyone with the
URL loads the site without signing in, and its icon is an orange open lock; protected means Fabric asks
for a sign-in and permission on the app first, a lock. Two reads per app, when *Apps* is expanded, then
cached. A button copies the URL. Nothing is opened or changed.

Requires desktop VS Code on x64 or arm64 Windows, macOS or Linux: the engine is a native library, so
this does not run on vscode.dev.

## Semantic models

**A `.bim` under `Files/` opens as its semantic model**, in place of the editor, on three pages.
So does an [Apache Ossie](https://github.com/apache/ossie) model whose metrics are DAX: a `.yaml`
or `.yml` whose top level has `version:` and `datasets:` (any other YAML is a document).
dax-sql's `formats/ossie.js` turns it into the `.bim` it stands for, with the vendored `yaml`
parser, and from there the two are one ([`app/semantic.js`](../app/semantic.js)). The pages:

- **Model**: its tables as a star, dimensions in the middle and facts around them, with its
  relationships. Click a table for its columns, measures (with their DAX) and relationships.
- **Explore**: drag the model's columns onto Rows, Columns and Filters, and its measures onto
  Values, to get a pivot table or a chart. A column dropped on Values is summarised, as in Power
  BI: a number is summed and anything else counted, and its chip switches to average, median,
  min, max, count or distinct count. Totals are off until you tick them, and a view cut at
  5,000 rows leaves them out.
- **SQL**: SQL in which `SELECT … FROM <model>` asks the model. `AGG(m)` is measure `m`, computed
  with DAX's semantics by [dax-sql](https://github.com/djouallah/dax-sql), which compiles the
  query to plain SQL:

  ```sql
  SELECT dim_region.Region, AGG("Registered MW") AS mw FROM nem GROUP BY ALL
  ```

  A model query can also be a subquery or CTE inside SQL of your own. Preview, Show plan and
  Download CSV.

A model is a **semantic view**, and SQL names it — in the main editor, the model's SQL tab and
the command line alike. The statements are dax-sql's (`createViews()`, vendored at the pin in
[`src/vendored.js`](../src/vendored.js)); nothing here re-implements them:

```sql
CREATE [OR REPLACE] SEMANTIC VIEW [IF NOT EXISTS] sales FROM '<a .bim or Ossie .yaml: local, abfss://… or Files/…>';
DROP SEMANTIC VIEW [IF EXISTS] sales;
SHOW SEMANTIC VIEWS;
SHOW SEMANTIC DIMENSIONS IN sales [FOR METRIC m];
SHOW SEMANTIC METRICS IN sales;
DESCRIBE sales;
SELECT * FROM (SHOW SEMANTIC METRICS IN sales) WHERE ...;
```

A model opened from the tree or from `Files/` becomes the view named after its file (`nem.bim`
is `nem`). Views are kept by the extension ([`src/semviews.js`](../src/semviews.js)) as pointers —
name, model file path, when — in one file per Microsoft account in its own storage, so they
survive a restart; the file stays where it is. Creating one writes nothing to Fabric or OneLake. A
Direct Lake table is read from the lakehouse its model names, through the same Iceberg catalog,
whichever item is selected, and only when a query actually reads it.

To change the syntax, change dax-sql and move the pin: the extension carries no copy of it.

There is no guarantee that DAX compiled to SQL here gives the same results as Power BI.

## Limitations

- **A lakehouse with no schemas of its own lists its tables under `dbo`.** That's the synthetic
  namespace OneLake's catalog reports for those items, so generated SQL reads `FROM "dbo"."sales"`.
- **An item its catalog can't serve shows an error rather than a table list.** There is no DFS
  fallback; re-picking the item tries again.
- **A database file under `Files/` is opened by sniffing its header**, never its extension (`.duckdb`,
  `.ddb`, `.db`, `.sqlite`). A DuckDB file is ATTACHed read-only and block-read on demand — tables
  queryable as `<name>.<schema>.<table>`. A SQLite file is copied by the host into the engine's temp
  directory and DuckDB's sqlite extension attaches it read-only (`<name>.main.<table>`, capped at
  200 MB). CSV, JSON, avro, xlsx and plain text have no block structure, so DuckDB pulls those whole. A
  `.zip` under `Files/` is listed via its central directory (a range read at the tail — the archive is not
  downloaded) and every readable entry becomes a view; entries decompress when queried.
- **A result past 200,000 rows is counted rather than carried into the panel.**

## Layout

```
src/      extension host: sign-in, cache-first OneLake, tree, native DuckDB, Fabric API
          (ships bundled, with @duckdb/node-api, as dist/extension.js)
app/      the panel: a view over the host (its own page, no sign-in, no network)
media/    icons
test/     node --test suite (npm test) and the browser runners
docs/     this file, the changelog, a summary of both and a screenshot
bin/      cli.mjs, the command line: hands ls, table, model, sql to the running extension (bridge.js -> agent.js)
claude-skill/  the agent skill (Claude Code, GitHub Copilot) that runs cli.mjs, installed by Install Agent Skill
scripts/  packaging: bundle, stage-webview, vendor, fetch-extensions, check-binding, fetch-binding, make-icon
```
