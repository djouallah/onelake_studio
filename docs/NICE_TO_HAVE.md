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
5. ~~**Column profile of a result**~~ Done (`SUMMARIZE`). Left: a small histogram per column.
6. ~~**Time travel from History**~~ Done for Iceberg snapshots (Query, rows and columns vs now).
   Left: a Delta commit, which needs the Iceberg snapshot Fabric converted it to (the metadata names
   only the latest Delta version it synced).
7. ~~**Export to a local file**~~ Done.
8. ~~**SQL from the tree**~~ Done (tables and models; the tree lists no columns to drag).

## Later
9. ~~**Quick chart of any result**~~ Done.
10. ~~**Query parameters**~~ Done.
11. ~~**How old a result is**~~ Done: each query editor keeps its last result for the session, shown
    again with when it ran. Left: keeping them across sessions, and how old the table metadata
    behind a result was (from the cache, read N min ago).

## Out of scope
- DAX queries (`EVALUATE`): the contract is SQL only. A semantic model is read with
  `AGG("measure")` in SQL.
- Writing to OneLake, DDL, or editing data in the grid.
- A TDS connection to the SQL endpoint.
- ER diagrams for lakehouse tables: they declare no keys.
