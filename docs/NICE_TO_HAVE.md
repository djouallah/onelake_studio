# Nice to have

Ranked by value for the work. Every item keeps the contract: SQL only, read only, cache first,
the panel holds no token, and table Pivot is only a SQL starter.

## Editing and results
1. ~~**Queries in VS Code's own editor.**~~ Done: see the changelog.
2. ~~**Query history**~~ Done. Left: whether DuckDB read the data from its disk cache or from
   OneLake (the host counts its own requests only; it needs the engine's read statistics).
3. ~~**Go to a table, column or measure**~~ Done.
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
10. **Query parameters:** `SET VARIABLE` / `getvariable()`, with a prompt for any value the query
    leaves unset.
11. **How old a result is** ("from cache, 3 min old"). Keep the last result of each saved query, so
    reopening the query shows its result at once.

## Out of scope
- DAX queries (`EVALUATE`): the contract is SQL only. A semantic model is read with
  `AGG("measure")` in SQL.
- Writing to OneLake, DDL, or editing data in the grid.
- A TDS connection to the SQL endpoint.
- ER diagrams for lakehouse tables: they declare no keys.
