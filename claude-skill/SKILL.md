---
name: onelake
description: Answer questions about Microsoft Fabric OneLake data and Power BI semantic models — list workspaces, lakehouses, warehouses, tables and semantic models, read a model's measures and their DAX, compute measures by any column, or run read-only SQL over lakehouse tables. Use whenever the user asks about OneLake, a Fabric workspace/lakehouse/warehouse, a semantic model, a measure, or "what is X by Y" over their Fabric data.
---

<!-- Installed by the OneLake Studio extension, which rewrites this file when it updates. -->

# OneLake and semantic models, from the shell

One command, read only but for `export`. It asks the OneLake Studio extension running in VS Code, which answers
with its own sign-in and cache — so VS Code must be open with OneLake Studio signed in (if the
command says it is not running, ask the user to open it). Needs Node.js on PATH:

```
node --no-warnings "{{cli}}" <command>
```

| command | answers |
|---|---|
| `ls` | workspaces |
| `ls <ws>` | its lakehouses/warehouses, and its semantic models (marked *downloaded* if local) |
| `models [<ws>]` | every semantic model in every workspace (or one), with description and *downloaded*, and how many — for "how many models", "which workspace has X" |
| `find <text>` | every cached name containing it — items, tables, columns, semantic models, and a downloaded model's tables, columns and measures — for "which table has customer_id", "where is the Sales model" |
| `files <ws> <item> [<dir>]` | a lakehouse's Files/ listing, with sizes |
| `items [<ws>]` | every lakehouse and warehouse in every workspace (or one), counted by kind |
| `ls <ws> <item>` | its tables with rows, size, files and last write, and their SQL names (`Lakehouse.<ws>.<item>.<schema>.<table>`); `<item>` may omit its `.Lakehouse` suffix |
| `table <ws> <item> <schema.table>` | rows, files, size, last write, columns — metadata only, no scan |
| `model <ws> <model>` | relationships, columns, measures with their DAX, and an example query. A model not downloaded yet exits 4: add `--fresh` to download it |
| `sql "<sql>"` | read-only SQL. A table is `Kind.workspace.item.schema.table` — `lakehouse.aemo.data.dbo.dim_duid`; Kind is `lakehouse`, `warehouse`, `sqldatabase` or `mirroreddatabase` (any case), a lakehouse without schemas is `dbo`, a part with spaces is `"quoted"` — any table, any workspace, joined freely. Every semantic model is a table too, `semanticmodel.<ws>.<model>`: `AGG("measure")` is the measure; and `SHOW SEMANTIC …` (below) |
| `sql -` | the SQL from stdin. Prefer it for anything with quotes in it: `AGG("Total Sales")` does not survive every shell, PowerShell's above all |
| `sql "<sql>" --in <ws>/<item>` | the lakehouse's files as `'Files/…'`: `read_parquet('Files/log.parquet')` |
| `export <ws> <model>` | Export to Fabric, as Explore's button does it: publishes the model's Explore as a Fabric app. The model must have been downloaded once (opened in the tree, or `model <ws> <model> --fresh`); the export writes its `.yaml` into its lakehouse |
| `export <ws> <item> <Files/path>` | the same, for a model file (`.bim`, Ossie `.yaml`) in a lakehouse's Files/ |

Options: `--limit N` (rows printed, default 100), `--csv`, `--json`, `--fresh` (ask OneLake/Fabric instead of the cache — see below),
`--show-sql` (print the SQL a model query compiles to — the answer to "is this SQL right?"),
`--timeout SEC` (give up and stop the query; default 600, `0` waits; `export` waits unless told otherwise),
`--` (what follows is not an option: `find -- -x`). `<command> --help` says what one command takes.

## Reading the answer

Branch on the exit code, never on the wording:

| exit | code | means | what to do |
|---|---|---|---|
| 0 | `OK` | answered, though perhaps not all of it: see below | use it |
| 1 | `FAILED` | the query or OneLake failed, or a `--csv` had more rows than a query keeps | fix the query, or report it |
| 2 | `USAGE` | a wrong command, option or argument | fix the call |
| 3 | `UNAVAILABLE` | VS Code not open, not signed in, or Fabric refused the sign-in | ask the user |
| 4 | `NOT_CACHED` | not in the cache | ask, or add `--fresh` |
| 5 | `DECLINED` | the user said no to an export | stop |
| 6 | `TIMEOUT` | `--timeout` reached, and the query stopped | narrow it, or give it longer |

A failure leaves stdout empty and says why on stderr. What each format gives you:

- **Markdown** (the default) is for reading: `1,234`, `2.5 MB`, `—`. Row counts and "first 100 shown" are in it.
- **`--csv`** is one table of raw values (bytes, ISO times, an empty cell for nothing) with always a header row, all
  its rows unless `--limit` says otherwise. It never leaves rows out unasked: past what a query keeps, it fails.
  `ls <ws>` and `model` are several tables, so they take no `--csv`.
- **`--json`** is for acting on: `{ ok, columns, rows, total, truncated, complete, cachedAt, notes }`, with `tables`
  by name in place of `columns` and `rows` for `ls <ws>` and `model`, and `data` for what is not a table. A failure is
  `{ ok: false, error: { code, message, retry }, notes }`. Everything is in it, stderr stays empty, and `2>&1` is safe.
  It shows `--limit` rows like Markdown does: check `truncated` before counting them.

An answer can be exit 0 and still short. A listing of every workspace that could not read some says `complete: false`
in `--json`, and a note on stderr otherwise (`--csv` has nowhere else to say it): do not report its counts as the total.
A workspace asked for by name fails instead.

## Answering a semantic-model question

1. Find the model: `ls <ws>` (ask which workspace only if you cannot find it by listing).
2. Read it: `model <ws> <model>` — use the measure names and columns exactly as listed.
3. Compute with the model's own measures, never by re-deriving them from the fact table:

   ```
   sql 'SELECT dim_customer.Region, AGG("Total Sales") AS sales FROM semanticmodel.sales.sales_model GROUP BY ALL ORDER BY 1'
   ```

   A model is named `semanticmodel.<workspace>.<model>` (`sales_model` in workspace `sales` is
   `semanticmodel.sales.sales_model`). A query that names a model not downloaded yet downloads it
   first. `SHOW ALL TABLES` lists every model and table the cache knows. `model` prints a ready-made example for it. Columns are `table.column`; quote names with spaces:
   `AGG("Avg Price")`. Filters go in WHERE as usual.

## Semantic views

`sql` also takes dax-sql's statements that read semantic views:

```
sql "SHOW SEMANTIC VIEWS"
sql "SHOW SEMANTIC METRICS IN semanticmodel.sales.sales_model"            measures, with their DAX
sql "SHOW SEMANTIC DIMENSIONS IN semanticmodel.sales.sales_model FOR METRIC \"Total Sales\""   what can slice it
```

A semantic model is never made or dropped in SQL: it is there because Fabric has it. A query that
names one opens it (its definition downloaded to this machine the first time, shared with the
VS Code panel); nothing is written to Fabric or OneLake.

## Things to know

- Results are DAX compiled to SQL by dax-sql — say so if exactness against Power BI matters.
- To check a measure against its raw data, `model` lists each table by its SQL name
  (`lakehouse.sales.mart.dbo.fct_summary`); plain SQL naming it reads the table as stored.
- Notes, timings and `--show-sql` under `--csv` go to stderr: keep `2>&1` off a `--csv` you mean to parse. A killed
  or timed-out command stops its query.
- Listings and metadata (`ls`, `models`, `items`, `table`, `model`) come only from what the
  extension has already cached — what the user has opened in its tree — and never from
  OneLake or Fabric; stderr says how old the answer is. Something not cached says so: tell the
  user, and add `--fresh` (which reads OneLake/Fabric now, and exports a model not downloaded
  yet) only when they agree or say the data just changed.
- A query (`sql`) reads OneLake, cached on disk too: a first query over a big table can
  take a minute or two, the next is seconds.
- Read only by construction: anything but a read is refused. The exception is `export`, and
  only when the user asks for it. VS Code then asks the user where the local copy goes and
  waits for their OK, so the command waits too. It prints the app's URL, or exits 5 and says why
  nothing was published. The app opens on Explore's default view.
- The same downloads are shared with the OneLake Studio VS Code extension
  (`~/OneLakeStudio/semantic-models/<ws>/<model>.yaml`).
