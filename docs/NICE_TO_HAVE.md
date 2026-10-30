# Nice to have

Ranked by value for the work. Every item keeps the contract: SQL only, read only, cache first,
the panel holds no token, and table Pivot is only a SQL starter.

## Editing and results
1. **Queries in VS Code's own editor.** Saved queries are already `.sql` files: open them as normal
   documents, with:
   - completion from the cache: workspaces, items, schemas, tables, columns, models, measures
   - Ctrl+Enter runs the statement under the cursor, or the selection
   - a "▶ Run" CodeLens above each statement
   - DuckDB errors as diagnostics at their line and column

   Results still show in the panel.
2. **Query history**, kept per account: SQL, time, duration, row count, and whether it was answered
   from the cache or from OneLake. Searchable from a quick pick or a tree node.
3. **Go to a table, column or measure:** a quick pick over the cache (what `find` already searches).
   The tree has no search today.
4. **Results grid.**
   - Virtualized, so every held row scrolls, not only the first 2,000.
   - Copy a cell or a range, and "Copy as" TSV, CSV, Markdown or JSON.
   - An inspector for long text and for structs, lists and JSON.
   - A quick filter box.

## Fits "a catalog read with SQL"
5. **Column profile of a result:** `SUMMARIZE` over it, with null %, distinct count, min, max and a
   small histogram per column.
6. **Time travel from History:** "Query this version" on a Delta commit or an Iceberg snapshot, and
   "Diff with current" for row count and schema.
7. **Export to a local file** as Parquet, CSV or Excel, without the 200,000-row cap. The host writes
   the file; user SQL is still refused `COPY`. Also: open the result as an untitled CSV or JSON
   document.
8. **SQL from the tree:**
   - "New query: SELECT * … LIMIT 100"
   - "Copy column list"
   - drag a table or a column into the editor to insert its SQL name

## Later
9. **Quick chart of any result**, with no model needed. Kept apart from table Pivot.
10. **SQL notebook** (VS Code Notebook API): one query per cell, its result under it. Choose
    between this and item 1; don't build both.
11. **Query parameters:** `SET VARIABLE` / `getvariable()`, with a prompt for any value the query
    leaves unset.
12. **How old a result is** ("from cache, 3 min old"). Keep the last result of each saved query, so
    reopening the query shows its result at once.

## Out of scope
- DAX queries (`EVALUATE`): the contract is SQL only. A semantic model is read with
  `AGG("measure")` in SQL.
- Writing to OneLake, DDL, or editing data in the grid.
- A TDS connection to the SQL endpoint.
- ER diagrams for lakehouse tables: they declare no keys.
