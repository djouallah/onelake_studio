# OneLake Studio for VS Code — architecture

- **Read only.** Nothing is ever written to Fabric or OneLake — not by the host, not by DuckDB,
  not by SQL the page sends: the host refuses any statement that could write.
- **Cache as much as possible.** Every answer OneLake or Fabric gave is kept on this machine and
  served from there first; the network is asked only when nothing is cached, or the cached
  answer is past its window.

The extension host in [`src/`](src/) does sign-in, every OneLake read (cache first) and the query
engine; its panel, [`app/`](app/), is only a view.

This app shares no code with the web app in [`../web/`](../web/): `app/` keeps its own copy of
everything it needs, and nothing here is imported from outside `vscode/`.

## Sign-in, the engine and the cache

[**OneLake Studio**](https://marketplace.visualstudio.com/items?itemName=djouallah.onelake-studio) needs
no app registration: VS Code's own Microsoft account provider is a first-party application, so
`getSession` returns the OneLake token directly. Commands and settings are listed in
[`README.md`](README.md), which is also the Marketplace page.

The query engine is **DuckDB 2.0 running natively in the extension host**
([`src/engine-host.js`](src/engine-host.js)) — a real DuckDB, not a WebAssembly
build in the page. It reads OneLake itself through its `iceberg` and `azure` extensions: a table is
read with `iceberg_scan` on the metadata file the host's cache holds — the catalog is never asked at
query time — and `Files/` objects are read as `abfss://` URLs. DuckDB therefore does the Iceberg
work itself — snapshot resolution, manifest filtering, position and equality deletes,
schema evolution. Each query runs on its own connection, so Stop interrupts exactly that query, and a
result past 200,000 rows is counted rather than carried into the panel.

The token lives only in the extension host, in a DuckDB storage secret; when VS Code hands back a new
one, the secret is reissued. The page holds no credential and makes no
OneLake request: it reaches the host through one message channel, and only through `query`, `stream`,
`cancel`, `info` and the host's OneLake reads ([`src/host.js`](src/host.js)).
File access is locked down to the temp directory, `https://`, `abfss://` and `zip://` over a remote
archive, and the page's SQL is checked in the host ([`src/sql.js`](src/sql.js)): one statement,
a read, or the page's own views, schemas and `READ_ONLY` attaches — never `COPY`, `INSERT`,
`EXPORT` or anything else that writes.

Listings (workspaces, items, tables, `Files/`, semantic models), table metadata and first rows
are served cache-first from disk ([`src/onelake.js`](src/onelake.js)) and refreshed behind you.
The bytes of a `Files/` object (an image, a `.bim`, a SQLite copy, a saved file) are kept under
the etag its cached listing gave, so a rewritten file is read again and an unchanged one never
is. Table data — Iceberg files never change once written — is kept by DuckDB's disk cache
(cache_httpfs). The cache is kept per Microsoft account, so switching accounts never serves
one account's data to another; it survives a sign-out (signing back in finds it warm), and only
**Clear Cached OneLake Data** deletes it.

The extension also lists each workspace's **Power BI semantic models** in its tree. Clicking one
downloads its TMSL definition (the Fabric REST API's `getDefinition`) to a `.bim` on this machine —
`~/OneLakeStudio/semantic-models/<workspace>/<model>.bim`, or `onelakeStudio.semanticModelsFolder` —
and opens it as its model (below). That file is the cache: later clicks open it without asking Fabric,
the tree marks the model *cached*, and **Download Again** fetches it fresh. That needs a second token, in the Fabric API's audience, which VS
Code asks for only when you first expand *Semantic models*. The extension is read only by design: it
writes nothing to Fabric or OneLake.

Requires desktop VS Code on x64 or arm64 Windows, macOS or Linux: the engine is a native library, so
this does not run on vscode.dev.

## Semantic models

**A `.bim` under `Files/` opens as its semantic model**, in place of the editor, on three pages.
So does an [Apache Ossie](https://github.com/apache/ossie) model whose metrics are DAX: a `.yaml`
or `.yml` whose top level has `version:` and `datasets:` (any other YAML is a document).
dax-sql's `formats/ossie.js` turns it into the `.bim` it stands for, with the vendored `yaml`
parser, and from there the two are one ([`app/semantic.js`](app/semantic.js)). The pages:

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
[`src/vendored.js`](src/vendored.js)); nothing here re-implements them:

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
is `nem`). Views are kept by the extension ([`src/semviews.js`](src/semviews.js)) as pointers —
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
app/      the panel: a view over the host (its own page, no sign-in, no network)
media/    icons
test/     node --test suite (npm test) and the browser runners
cli.mjs   the command line: hands ls, table, model, sql to the running extension (bridge.js -> agent.js)
claude-skill/  the agent skill (Claude Code, GitHub Copilot) that runs cli.mjs, installed by Install Agent Skill
*.mjs     packaging: stage-webview, vendor, fetch-extensions, check-binding, fetch-binding, make-icon
```
