---
name: onelake
description: Answer questions about Microsoft Fabric OneLake data and Power BI semantic models — list workspaces, lakehouses, warehouses, tables and semantic models, read a model's measures and their DAX, compute measures by any column, or run read-only SQL over lakehouse tables. Use whenever the user asks about OneLake, a Fabric workspace/lakehouse/warehouse, a semantic model, a measure, or "what is X by Y" over their Fabric data — and whenever they ask about what is on their screen or open in VS Code: "can you see this", "what am I looking at", "this table", "these rows", "this model", "this chart" — the OneLake Studio panel writes what it shows to a file this skill reads; never answer that you cannot see the screen before reading it.
---

<!-- Installed by the OneLake Studio extension, which rewrites this file when it updates. -->

# OneLake and semantic models, from the shell

One command, read only. It asks the OneLake Studio extension running in VS Code, which answers
with its own sign-in and cache — so VS Code must be open with OneLake Studio signed in (if the
command says it is not running, ask the user to open it). Needs Node.js on PATH:

```
node --no-warnings "{{cli}}" <command>
```

| command | answers |
|---|---|
| `screen` | what the panel shows: what is open, the SQL or DAX it ran, the rows on screen |
| `screen --rerun` | runs that same query again and prints the whole result, not the saved first rows |
| `ls` | workspaces |
| `ls <ws>` | its lakehouses/warehouses, and its semantic models (marked *downloaded* if local) |
| `ls <ws> <item>` | its tables, and their names in `sql --in` (`<item>_<schema>.<table>`); `<item>` may omit its `.Lakehouse` suffix |
| `table <ws> <item> <schema.table>` | rows, files, size, last write, columns — metadata only, no scan |
| `model <ws> <model>` | relationships, columns, measures with their DAX, and an example query; downloads the `.bim` once |
| `sql "<sql>"` | read-only SQL. Every semantic view is a table: `AGG("measure")` is the measure; and `CREATE / DROP / SHOW SEMANTIC VIEW` (below) |
| `sql "<sql>" --in <ws>/<item>` | the lakehouse's tables, as `<item>_<schema>.<table>` — e.g. `data_mart.dim_duid` — and its files as `'Files/…'`: `read_parquet('Files/log.parquet')` |
| `dax "EVALUATE …"` | a DAX query against the model on screen (or `--model <name>`) — Explore's DAX runs as is |

Options: `--limit N` (rows printed, default 100), `--csv`, `--fresh` (re-read instead of the cache),
`--show-sql` (print the SQL a model query or DAX compiles to — the answer to "is this SQL right?").

## What the user has on screen

When the user says *this*, *here*, *open*, *on screen*, *what I'm looking at*, *these numbers*, or
names nothing, run `screen` first: it prints what is open, the SQL or DAX last run, and the rows on
screen as a table — or, when the user pressed Show plan or ran an EXPLAIN, the query plan on
screen and the SQL it compiled to: analyse that plan as saved, never re-run EXPLAIN to get it.
When it says only the first rows were saved and the question needs all of them
(totals, gaps, a check across the whole result), run `screen --rerun`.

`screen` reads `{{panel}}/panel-*.json` (one per VS Code window, the most recently `updated`); read
those files directly only to pick a window other than the newest.

- `open`: the table, file or semantic model in the OneLake Studio panel. A table or model
  carries `cli`: the commands that reach it — run those rather than guessing names.
- `query`: the last SQL the main editor ran, its row count, and `sample` — the first rows on
  screen. Answer from `sample` when it is enough; re-run through `sql` when it is not.
- `model`: for a semantic model, which page is in front (`model`, `sql`, `explore`), the SQL
  page's last query and Explore's last DAX, each with its first rows; `plan` (and `compiled`)
  instead of rows when a query plan is what is on screen.

The panel's SQL names a table as the panel does (`"schema"."table"`); through `sql --in`, it is
`<item>_<schema>.<table>` (`open.cli.sql` shows it). No file means the panel is closed: ask.

## Answering a semantic-model question

1. Find the model: `ls <ws>` (ask which workspace only if you cannot find it by listing).
2. Read it: `model <ws> <model>` — use the measure names and columns exactly as listed.
3. Compute with the model's own measures, never by re-deriving them from the fact table:

   ```
   sql 'SELECT dim_customer.Region, AGG("Total Sales") AS sales FROM sales_model GROUP BY ALL ORDER BY 1'
   ```

   A model is a semantic view named after its file (`sales_model.bim` is `sales_model`); `model`
   prints a ready-made example for it. Columns are `table.column`; quote names with spaces:
   `AGG("Avg Price")`. Filters go in WHERE as usual.

## Semantic views

`sql` also takes dax-sql's semantic-view statements:

```
sql "SHOW SEMANTIC VIEWS"
sql "SHOW SEMANTIC METRICS IN sales_model"            measures, with their DAX
sql "SHOW SEMANTIC DIMENSIONS IN sales_model FOR METRIC \"Total Sales\""   what can slice it
sql "CREATE SEMANTIC VIEW sales FROM 'Files/models/sales.bim'" --in <ws>/<item>
sql "DROP SEMANTIC VIEW sales"
```

A `.bim` path is local, `abfss://…`, or `Files/…` with `--in`. Views are kept by the extension
(shared with the VS Code panel) and survive restarts; nothing is written to Fabric or OneLake.

## Things to know

- Results are DAX compiled to SQL by dax-sql — say so if exactness against Power BI matters.
- To check a measure against its raw data, `model` lists each table as the engine names it
  (`"mart_1a2b3c4d"."fct_summary"`); plain SQL naming that reads the table as stored — no `--in`.
- Notes and timings go to stderr: keep `2>&1` off a `--csv` you mean to parse.
- Everything is cached on disk (listings, metadata, the table data DuckDB reads), so a first
  query over a big table can take a minute or two and the next is seconds. Use `--fresh` only
  when the user says the data just changed.
- Read only by construction: anything but a read is refused.
- The same downloads are shared with the OneLake Studio VS Code extension
  (`~/OneLakeStudio/semantic-models/<ws>/<model>.bim`).
