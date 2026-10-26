---
name: onelake
description: Answer questions about Microsoft Fabric OneLake data and Power BI semantic models — list workspaces, lakehouses, warehouses, tables and semantic models, read a model's measures and their DAX, compute measures by any column, or run read-only SQL over lakehouse tables. Use whenever the user asks about OneLake, a Fabric workspace/lakehouse/warehouse, a semantic model, a measure, or "what is X by Y" over their Fabric data.
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
| `ls` | workspaces |
| `ls <ws>` | its lakehouses/warehouses, and its semantic models (marked *downloaded* if local) |
| `ls <ws> <item>` | its tables, and their names in `sql --in` (`<item>_<schema>.<table>`); `<item>` may omit its `.Lakehouse` suffix |
| `table <ws> <item> <schema.table>` | rows, files, size, last write, columns — metadata only, no scan |
| `model <ws> <model>` | relationships, columns, measures with their DAX, and an example query; downloads the `.bim` once |
| `sql "<sql>"` | read-only SQL. Every semantic view is a table: `AGG("measure")` is the measure; and `CREATE / DROP / SHOW SEMANTIC VIEW` (below) |
| `sql "<sql>" --in <ws>/<item>` | the lakehouse's tables, as `<item>_<schema>.<table>` — e.g. `data_mart.dim_duid` — and its files as `'Files/…'`: `read_parquet('Files/log.parquet')` |
| `dax "EVALUATE …" --model <name>` | a DAX query against a semantic view (`--model` may be left out when only one is defined) |

Options: `--limit N` (rows printed, default 100), `--csv`, `--fresh` (re-read instead of the cache),
`--show-sql` (print the SQL a model query or DAX compiles to — the answer to "is this SQL right?").

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
