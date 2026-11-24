---
name: onelake
description: Answer questions about Microsoft Fabric OneLake data and Power BI semantic models — list workspaces, lakehouses, warehouses, tables and semantic models, read a model's measures and their DAX, compute measures by any column, or run read-only SQL over lakehouse tables. Use whenever the user asks about OneLake, a Fabric workspace/lakehouse/warehouse, a semantic model, a measure, or "what is X by Y" over their Fabric data.
---

<!-- Installed by the OneLake Studio extension, which rewrites this file when it updates. -->

# OneLake and semantic models, from the shell

One command. It asks the OneLake Studio extension running in VS Code, which answers
with its own sign-in and cache. With VS Code closed, on Windows with Node 22.5 or later, it answers by itself from the
same cache, after one `signin` (exit code 3 says so). Needs Node.js on PATH:

```
node --no-warnings "{{cli}}" <command>
```

| command | answers |
|---|---|
| `ls` | workspaces |
| `ls <ws>` | its lakehouses/warehouses, and its semantic models (marked *downloaded* if local) |
| `models [<ws>]` | every semantic model in every workspace (or one), with description, *downloaded* and *staging*, and how many — for "how many models", "which workspace has X". `--downloaded`: only those on this machine, readable with no download |
| `find <text>` | every cached name containing it — items, tables, columns, semantic models, and a downloaded model's tables, columns and measures — for "which table has customer_id", "where is the Sales model". `--fresh` reads every listing first, which is slow on a large tenant; what it read stays cached if `--timeout` stops it |
| `files <ws> <item> [<dir>]` | a lakehouse's Files/ listing, with sizes and SQL names; a `<dir>` of `Context/…` or `SystemContext/…` lists those (semantic views' YAML, and the TMDL Fabric makes of it; read-only) |
| `items [<ws>]` | every lakehouse and warehouse in every workspace (or one), counted by kind, with *staging* |
| `ls <ws> <item>` | its tables with rows, size, files and last write, and their SQL names (`<ws>.<lakehouse>.<schema>.<table>`, another item's `<ws>.<item>_<kind>.<schema>.<table>`); `<item>` may omit its `.Lakehouse` suffix |
| `table <ws> <item> <schema.table>` | rows, files, size, last write, columns — metadata only, no scan |
| `exists <ws> <item> <schema.table>` | whether a table is there, in milliseconds, from the listings. Exit 0 yes, exit 1 no with the closest names (`--json`: `error.exists` is false, and `error.closest`), exit 4 never listed, so unknown. A folder found to have neither a Delta log nor Iceberg metadata is a no too (`error.notValid`). A bare name finds it in any schema. Prefer it to `table` or a query for this |
| `health <ws> <item>` | each table's file layout and what it says: files, average size, deleted rows, and findings — many small files, many deleted rows, big files without V-Order, big files cut into small row groups, a Delta checkpoint far behind; a small table has none — each with an action to consider. From what this machine holds of each table, with no OneLake request: a table no query has read yet is *not read* |
| `model <ws> <model>` | relationships, columns, measures with their DAX, and an example query. A model not downloaded yet exits 4: add `--fresh` to download it |
| `sql "<sql>"` | read-only SQL. A lakehouse table is `workspace.lakehouse.schema.table` — `aemo.data.dbo.dim_duid`, as Fabric's Spark names it (`aemo.data_lakehouse.dbo.dim_duid` reads it too); any other item has its kind after its name, `_warehouse`, `_sqldatabase` or `_mirroreddatabase` (`aemo.gold_warehouse.sales.orders`, any case), or `"<workspace id>"."<item id>".schema.table` by GUIDs, a lakehouse without schemas is `dbo`, a part with spaces is `"quoted"` or in backticks; `USE <ws>.<lakehouse>.<schema>;` first lets the statements after it in that `sql` name its tables alone — any table, any workspace, joined freely. Every semantic model is a table too, `<ws>.<model>_semanticmodel`: `AGG("measure")` is the measure; and `SHOW SEMANTIC …` (below) |
| `sql -` | the SQL from stdin. Prefer it for anything with quotes in it: `AGG("Total Sales")` does not survive every shell, PowerShell's above all |
| `sql "SELECT * FROM '<ws>.<lakehouse>/Files/x.parquet'"` | a file is `'<ws>.<lakehouse>/Files/<path>'`, in single quotes, with its workspace and item spelled as in a table's name. Wildcards go in the path: `read_csv('aemo.data/Files/raw/*.csv', header=true)` |
| `status` | this window on itself, for debugging the extension: its build, session, startup timeline, catalog, sync, and where its files are. Answers signed out too |
| `log [<text>]` | this window's own log, the lines holding `<text>` if given, newest last. Prefixes: `start:`, `session:`, `move:`, `catalog:`, `sync:`. Default 200 lines, `--limit N` for more |

Options: `--limit N` (rows printed, default 100), `--csv`, `--json`, `--fresh` (ask OneLake/Fabric instead of the cache — see below),
`--show-sql` (print the SQL a model query compiles to — the answer to "is this SQL right?"),
`--timeout SEC` (give up and stop the query; default 600, `0` waits),
`--` (what follows is not an option: `find -- -x`). `<command> --help` says what one command takes.

## Reading the answer

Branch on the exit code, never on the wording:

| exit | code | means | what to do |
|---|---|---|---|
| 0 | `OK` | answered, though perhaps not all of it: see below | use it |
| 1 | `FAILED` | the query or OneLake failed, a `--csv` had more rows than a query keeps, `exists` or `table` found no such table in a listing, or it is *not a valid table*: a folder under `Tables/` with neither a Delta log nor Iceberg metadata, which can't be read | fix the query, or report it |
| 2 | `USAGE` | a wrong command, option or argument | fix the call |
| 3 | `UNAVAILABLE` | Not signed in, or Fabric refused the sign-in | ask the user to run `signin` |
| 4 | `NOT_CACHED` | not in the cache; offline (no internet, or nobody signed in), `--fresh` and a table or file never read end here too, and `retry` is absent | ask, or add `--fresh` unless offline |
| 6 | `TIMEOUT` | `--timeout` reached, and the query stopped | narrow it, or give it longer |

A failure leaves stdout empty and says why on stderr. What each format gives you:

- **Markdown** (the default) is for reading. The listings (`ls`, `models`, `items`, `files`, `table`) format theirs:
  `1,234`, `2.5 MB`, `—`. `sql` prints raw values: `1234567.891`, `NULL` for a null, and a blank for an empty string.
  Row counts and "first 100 shown" are in it. `SHOW ALL TABLES` gives each table's column count here; `--json`,
  `--csv` or `table` give the columns. A count of 0 means its columns haven't been read yet, not that it has none:
  `table <ws> <item> <schema.table> --fresh` reads them, and a query that names the table works as usual.
- **`--csv`** is one table of raw values (bytes, ISO times, an empty cell for NULL, `""` for an empty string) with
  always a header row, all its rows unless `--limit` says otherwise. It never leaves rows out unasked: past what a
  query keeps, it fails. `ls <ws>` and `model` are several tables, so they take no `--csv`. Many CSV readers lose the
  difference between NULL and `""`: DuckDB's `read_csv` needs `allow_quoted_nulls=false`, and Python's `csv` can't
  keep it. Use `--json` when it matters.
- **How old an answer is:** a table's metadata is kept for a day by default, so `sql` can read an older snapshot with
  no error. `cachedAt` says when its oldest table was last read from OneLake, a note says so past an hour, and
  `sql --fresh` reads their metadata first.
- **`--json`** is for acting on: `{ ok, columns, rows, total, truncated, complete, cachedAt, notes }`, with `tables`
  by name in place of `columns` and `rows` for `ls <ws>` and `model`, and `data` for what is not a table. A failure is
  `{ ok: false, error: { code, message, retry }, notes }`. Everything is in it, stderr stays empty, and `2>&1` is safe.
  It shows `--limit` rows like Markdown does: check `truncated` before counting them.

An answer can be exit 0 and still short. A listing of every workspace that could not read some says `complete: false`
in `--json`, and a note on stderr otherwise (`--csv` has nowhere else to say it): do not report its counts as the total.
A workspace asked for by name fails instead. `find` says `complete: false` too when it could not search something: a
listing not cached, or the columns of a table whose metadata was never read.

*staging* marks what a dataflow made for its own staging (`DataflowsStaging*`, `StagingLakehouseForDataflows_*`,
`StagingWarehouseForDataflows_*`). It is judged by the name. Leave these out when counting what people built.

## Answering a semantic-model question

1. Find the model: `ls <ws>` (ask which workspace only if you cannot find it by listing).
2. Read it: `model <ws> <model>` — use the measure names and columns exactly as listed.
3. Compute with the model's own measures, never by re-deriving them from the fact table:

   ```
   sql 'SELECT dim_customer.Region, AGG("Total Sales") AS sales FROM sales.sales_model_semanticmodel GROUP BY ALL ORDER BY 1'
   ```

   A model is named `<workspace>.<model>_semanticmodel` (`sales_model` in workspace `sales` is
   `sales.sales_model_semanticmodel`). A query that names a model not downloaded yet downloads it
   first. `SHOW ALL TABLES` lists every model and table the cache knows. `model` prints a ready-made example for it. Columns are `table.column`; quote names with spaces:
   `AGG("Avg Price")`. Filters go in WHERE as usual.

## Semantic views

`sql` also takes dax-sql's statements that read semantic views:

```
sql "SHOW SEMANTIC VIEWS"
sql "SHOW SEMANTIC METRICS IN sales.sales_model_semanticmodel"            measures, with their DAX
sql "SHOW SEMANTIC DIMENSIONS IN sales.sales_model_semanticmodel FOR METRIC \"Total Sales\""   what can slice it
```

A semantic model is never made or dropped in SQL: it is there because Fabric has it. A query that
names one opens it (its definition downloaded to this machine the first time, shared with the
VS Code extension); nothing is written to Fabric or OneLake.

## Things to know

- Results are DAX compiled to SQL by dax-sql — say so if exactness against Power BI matters.
- To check a measure against its raw data, `model` lists each table by its SQL name
  (`sales.mart.dbo.fct_summary`); plain SQL naming it reads the table as stored.
- Notes, timings and `--show-sql` under `--csv` go to stderr: keep `2>&1` off a `--csv` you mean to parse. A killed
  or timed-out command stops its query.
- Listings and metadata (`ls`, `models`, `items`, `find`, `table`, `model`) come only from what the
  extension has already cached — what the user has opened in its tree — and never from
  OneLake or Fabric; stderr says how old the answer is. Something not cached says so: tell the
  user, and add `--fresh` (which reads OneLake/Fabric now, and downloads a model not downloaded
  yet) only when they agree or say the data just changed.
- A query (`sql`) reads OneLake, cached on disk too: a first query over a big table can
  take a minute or two, the next is seconds.
- A table with OneLake security (roles with rules on its rows or columns) that OneLake refuses the user is read
  through OneLake's table read API: the answer has only the rows and columns their roles allow, so it can differ from
  what someone else sees. Each new read uses the workspace's capacity, so the answer is kept and read again after a day
  or a Refresh, not on every query. `table` may fail with a 403 for it while `sql` still reads it.
- `sql` reads, and writes to a lakehouse, with no question asked: its tables only once the user turns on Allow
  Table Writes (`onelakeStudio.allowTableWrites`, off by default; a write says so when it is off), and its `Files/`
  while Allow Copy to Files is on (on by default). Its tables (`CREATE TABLE`,
  `CREATE TABLE … AS`, `INSERT`, `UPDATE`, `DELETE`, `MERGE INTO`, `ALTER TABLE`, `CREATE SCHEMA`) and its
  `Files/` by `COPY (…) TO '<ws>.<lh>/Files/<path>'`. A target is `<ws>.<lh>.<schema>.<table>`. Each table
  is written in its own format, and a new one is made as Iceberg. A Delta table takes `INSERT` only.
  `DROP TABLE` (an Iceberg table) and `DROP SCHEMA` run only with Allow Drop Table on as well; any other `DROP` is refused, and so
  is a write to a warehouse or anything
  not in a lakehouse. Write only when the user asks for it.
- Several statements, separated by `;`, run in turn: the first that fails stops them, and the last one's rows are
  the answer.
- The same downloads are shared with the OneLake Studio VS Code extension
  (in the extension's cache folder, under `models/<account>/<ws>/<model>.ossie.yaml`).
