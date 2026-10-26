---
name: onelake
description: Answer questions about Microsoft Fabric OneLake data and Power BI semantic models — list workspaces, lakehouses, warehouses, tables and semantic models, read a model's measures and their DAX, compute measures by any column, or run read-only SQL over lakehouse tables. Use whenever the user asks about OneLake, a Fabric workspace/lakehouse/warehouse, a semantic model, a measure, or "what is X by Y" over their Fabric data.
---

<!-- Installed by the OneLake Studio extension, which rewrites this file when it updates. -->

# OneLake and semantic models, from the shell

One command, read only, from the OneLake Studio VS Code extension. It signs in with the Azure CLI
(if it says so, ask the user to run `az login`) and needs Node.js 20+ on PATH:

```
node --no-warnings "{{cli}}" <command>
```

| command | answers |
|---|---|
| `ls` | workspaces |
| `ls <ws>` | its lakehouses/warehouses, and its semantic models (marked *downloaded* if local) |
| `ls <ws> <item>` | its tables (`schema.table`); `<item>` may omit its `.Lakehouse` suffix |
| `table <ws> <item> <schema.table>` | rows, files, size, last write, columns — metadata only, no scan |
| `model <ws> <model>` | relationships, columns, measures with their DAX, and an example query; downloads the `.bim` once |
| `sql "<sql>"` | read-only SQL. Every downloaded model is a table: `AGG("measure")` is the measure |
| `sql "<sql>" --in <ws>/<item>` | the lakehouse's tables, as `schema.table` (or bare `table` when unique) |

Options: `--limit N` (rows printed, default 100), `--csv`, `--fresh` (re-read instead of the cache).

## Answering a semantic-model question

1. Find the model: `ls <ws>` (ask which workspace only if you cannot find it by listing).
2. Read it: `model <ws> <model>` — use the measure names and columns exactly as listed.
3. Compute with the model's own measures, never by re-deriving them from the fact table:

   ```
   sql 'SELECT dim_customer.Region, AGG("Total Sales") AS sales FROM sales_model GROUP BY ALL ORDER BY 1'
   ```

   The model is named after its file (`sales_model.bim` is `sales_model`); `model` prints a
   ready-made example for it. Columns are `table.column`; quote names with spaces:
   `AGG("Avg Price")`. Filters go in WHERE as usual. `DESCRIBE <model>` also works inside `sql`.

## Things to know

- Results are DAX compiled to SQL by dax-sql — say so if exactness against Power BI matters.
- Everything is cached on disk (listings, metadata, the table data DuckDB reads), so a first
  query over a big table can take a minute or two and the next is seconds. Use `--fresh` only
  when the user says the data just changed.
- Read only by construction: anything but a read is refused.
- The same downloads are shared with the OneLake Studio VS Code extension
  (`~/OneLakeStudio/semantic-models/<ws>/<model>.bim`).
