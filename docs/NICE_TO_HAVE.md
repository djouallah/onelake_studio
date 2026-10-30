# Nice to have

Ranked by value for the work. Every item keeps the contract: SQL only, read only, cache first,
the panel holds no token, and table Pivot is only a SQL starter.

## Editing and results
1. ~~**Queries in VS Code's own editor.**~~ Done: see the changelog.
2. ~~**Query history**~~ Done. Left: whether DuckDB read the data from its disk cache or from
   OneLake (the host counts its own requests only; it needs the engine's read statistics).
3. ~~**Go to a table, column or measure**~~ Done.
4. ~~**Results grid.**~~ Done.

## Fits "a catalog read with SQL"
5. **Column profile of a result:** `SUMMARIZE` over it, with null %, distinct count, min, max and a
   small histogram per column.
6. **Time travel from History:** "Query this version" on a Delta commit or an Iceberg snapshot, and
   "Diff with current" for row count and schema.
7. ~~**Export to a local file**~~ Done.
8. ~~**SQL from the tree**~~ Done (tables and models; the tree lists no columns to drag).

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
