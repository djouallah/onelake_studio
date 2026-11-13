# Naming convention

This is the contract for how every object in OneLake Studio is named. Change the code to fit it, not the
other way round. The code that holds it is [`core/names.js`](../core/names.js) and
[`core/sql.js`](../core/sql.js) on the host, and [`page/semantic.js`](../page/semantic.js) and
[`page/paths.js`](../page/paths.js) in the page.

## The point

**The tenant acts as a single catalog.** Every table and semantic model in it has one name, and any
statement can use any of them. It can join across items, workspaces and kinds with no setup.

**This works because a name means exactly one object.** Fabric guarantees it: a workspace's name is
unique in the tenant, an item's name is unique for its type in a workspace, and a table's name is unique
in its schema. The convention is built on that guarantee, and it is what makes a cross join safe. If a
name could mean two objects, a query could read the wrong data with no error, and nobody could trust the
catalog.

## Quick reference

| Object | Its name | Example |
| --- | --- | --- |
| A table | `<workspace>.<item>_<kind>.<schema>.<table>` | `aemo.data_lakehouse.dbo.dim_duid` |
| The same table, by GUIDs | `"<workspace id>"."<item id>".<schema>.<table>` | `"0f3c1a2b-…"."9a1b2c3d-…".dbo.dim_duid` |
| A semantic model | `<workspace>.<model>_semanticmodel` | `aemo.nem_semanticmodel` |
| A file | `'<workspace>.<item>_lakehouse/Files/<path>'` | `'aemo.data_lakehouse/Files/x.parquet'` |

`<kind>` is one of `lakehouse`, `warehouse`, `sqldatabase` or `mirroreddatabase`.

| Written | Means |
| --- | --- |
| `aemo.data_lakehouse.dbo.dim_duid` | A table. |
| `AEMO.DATA_LAKEHOUSE.DBO.DIM_DUID` | The same table: case does not matter. |
| `aemo.data_warehouse.dbo.dim_duid` | A different table: the item is a warehouse. |
| `"ANZ Retail"."gold-1_warehouse".sales."order"` | A table: a part with a space, a hyphen or a reserved word is quoted. |
| `aemo.data_lakehouse.dbo.dim_duid.region` | Column `region` of that table. |
| `memory.aemo.data_lakehouse.dbo.dim_duid` | The same table, with the engine's catalog in front. |
| `aemo.data_lakehouse.dim_duid` | Not a table: three parts. A lakehouse without schemas still writes `dbo`. |
| `aemo.data.dbo.dim_duid` | Not a table: the item has no kind. |
| `lakehouse.aemo.data.dbo.dim_duid` | Refused: the old way. The error gives the name it has now. |
| `dbo.dim_duid`, `dim_duid` | Not a OneLake table: no workspace or item. |
| `aemo.nem_semanticmodel` | A semantic model. |

## The rule

**A name is where Fabric keeps the object, with the item's type written after the item's name.** OneLake
keeps a table at `<workspace>/<item>.<Kind>/Tables/<schema>/<table>`, and its name follows that path:

| Object | Where Fabric keeps it | Its name |
| --- | --- | --- |
| A table | `<workspace>/<item>.<Kind>/Tables/<schema>/<table>` | `<workspace>.<item>_<kind>.<schema>.<table>` |
| A semantic model | an item directly in `<workspace>` | `<workspace>.<model>_semanticmodel` |

No two objects have the same address, so no two have the same name. Nothing has to be attached or
declared before a statement uses one:

```sql
SELECT *
FROM aemo.data_lakehouse.dbo.dim_duid d
JOIN sales.gold_warehouse.dbo.fact_orders f ON f.duid = d.duid;

SELECT dim_region.Region, AGG("Registered MW") FROM aemo.nem_semanticmodel GROUP BY ALL;
```

## Tables: four parts

| Part | Holds | Comes from | Why it is there |
| --- | --- | --- | --- |
| `workspace` | the workspace's display name | OneLake's listing | Two workspaces can both have `dbo.t`. |
| `item_kind` | the item's display name, `_`, then its kind | OneLake's listing | One workspace holds many items, and two items of different types can share a name: `data_lakehouse` and `data_warehouse` are two items. |
| `schema` | the table's schema | OneLake's catalog | Warehouses and schema-enabled lakehouses have real schemas. |
| `table` | the table's name | OneLake's catalog | The object itself. |

**The kind is Fabric's spelling, not the folder's.** `SQLDbNative` is `sqldatabase`, and
`MountedRelationalDatabase` and any `Mirrored*` type are `mirroreddatabase`. An item of any other type
holds no tables SQL can name, and is refused.

**The kind is always written.** A lakehouse named `x_lakehouse` is `x_lakehouse_lakehouse`. The kind is
read back from the last `_<kind>` of the part, so no two items share a part.

**The schema is always written.** A lakehouse without schemas is `dbo`, the one schema OneLake's catalog
reports for it. Every table therefore has the same shape, and there is no three-part form to learn or to
parse.

**Four parts are nested schemas, not a parser trick.** The workspace, the item and the schema are schemas
nested in the engine's own catalog, `memory`, made as a statement names them. The table is a view there,
over its lake table. The name is therefore real SQL, which DuckDB resolves itself, and
`memory.aemo.data_lakehouse.dbo.dim_duid` is the same table.

## By GUIDs

**A table can also be named by its workspace's and its item's GUIDs:**
`"0f3c1a2b-1111-2222-3333-444455556666"."9a1b2c3d-aaaa-bbbb-cccc-ddddeeeeffff".dbo.dim_duid`. A GUID has hyphens,
so it is quoted. The GUIDs say the kind, so the item has no `_<kind>`.

- **It is the same table.** The engine asks Fabric once what the GUIDs are called and keeps the answer, so
  it resolves offline after that. It reads the table those names name.
- **It is for input.** The tree, Copy name, listings and errors give the display name. A GUID name still
  reads after an item or a workspace is renamed, which a display name does not.
- **It reaches what a name can't.** A workspace named like a database of the engine (`memory`, `system`,
  `temp`, `lake`, or a database file a tab attached) is found as that database, since DuckDB looks for a
  catalog before a schema, and one named like a schema DuckDB keeps (`main`, `pg_catalog`,
  `information_schema`) is not found at all. Their tables are refused by name, and the error says to name
  them by GUIDs.

## Semantic models: two parts

**A semantic model is `<workspace>.<model>_semanticmodel`, however it was made.** That holds for a Power BI
model in Fabric, and for a model created from a `.bim` or `.yaml`, whether for Fabric or only for a Fabric
app.

**Every workspace has one model of a name, so the name is unique by design.** Fabric guarantees one
workspace of a name in the tenant and one semantic model of a name in a workspace. A model created from a
file must use this name too, and it does not get a second one: if the name is taken in that workspace, the
newer model overwrites what we have under it. The name therefore identifies exactly one model at a time.

**Overwriting never reaches the Power BI item.** Nothing here writes a semantic model item in Fabric, so a
model created from a file replaces only our own view of that name, and an export replaces only our own
copy and app. Until the Fabric item is downloaded again, `<workspace>.<model>_semanticmodel` is the one
created last.

Why two parts and not four:

- **A model has no item or schema above it.** It sits directly in its workspace, so the rule leaves the
  workspace and the model with its kind. There is nothing for the other two parts to name.
- **A model reads as one table.** A query names the model once and reaches what is inside it from there:
  `dim_region.Region` is a table and column within the query, not more of the model's name. Adding a part
  for a model's table would split one object into many names, and the join between them is the model's
  job.
- **A model's source cannot be part of its name.** A Direct Lake model can read several lakehouses, so no
  single item is its parent. `SHOW SEMANTIC VIEWS` reports what it reads as `tables_from`.

**It is a view in its workspace's schema**, `memory.<workspace>.<model>_semanticmodel`, which is where the
engine lists it. dax-sql, which compiles the model before DuckDB sees the statement, reaches a view by
`db.schema.name` alone, so the page puts `memory.` in front of a model's name before dax-sql reads it.

## Files

**A file is its lakehouse's name, then its path under `Files/`, and it can be anything.** An item is
always `<workspace>.<item>_lakehouse`: a `.` leads to its tables, and `/Files/` leads to its files. Only a
lakehouse has `Files/`. The name means one file from anywhere, with no default lakehouse and nothing
attached.

| Written | Means |
| --- | --- |
| `'aemo.data_lakehouse/Files/x.parquet'` | A file. |
| `'AEMO.DATA_LAKEHOUSE/Files/x.parquet'` | The same file: case does not matter before the `/`. |
| `'aemo.data_lakehouse/Files/X.parquet'` | A different file: the path is exact. |
| `'"ANZ Retail".data_lakehouse/Files/a b.csv'` | A file: a part is quoted as it is in a table's name, and the path never is. |
| `'aemo.data_lakehouse/Files/raw/*.csv'` | Every `.csv` directly in `raw/`. `**` goes through its subfolders. |
| `'zip://aemo.data_lakehouse/Files/a.zip/b.csv'` | An entry in a zip. |
| `'aemo.data_lakehouse/Files'` | The folder itself, for `glob('aemo.data_lakehouse/Files/*')`. |
| `'aemo.*/Files/x.parquet'` | Refused: a wildcard goes in the path, and a name means one item. |
| `'aemo.data_lakehouse/Tables/dbo/t/x.parquet'` | Refused: a table has its own name. |
| `'aemo.data_warehouse/Files/x.parquet'` | Refused: only a lakehouse has `Files/`. |
| `'lakehouse.aemo.data/Files/x.parquet'` | Refused: the old way. The error gives the name it has now. |
| `'Files/x.parquet'` | Not a OneLake file: no workspace or item. |

```sql
SELECT * FROM 'aemo.data_lakehouse/Files/x.parquet';
SELECT * FROM read_csv('aemo.data_lakehouse/Files/raw/*.csv', header = true);
```

**The quotes are required.** DuckDB reads a file only from a string, and a bare `/` is a syntax error. They
also say that this is a file and not a table.

**This one is a parser's work, unlike a table's name.** DuckDB can't read it, so the engine gives it the
file's `abfss://` URL before the statement runs, finding the workspace and item in the kept listings as it
does for a table (`fileRefs` in [`core/sql.js`](../core/sql.js), `withFileUrls` in
[`core/engine/engine-host.js`](../core/engine/engine-host.js)). So that nothing is read from the wrong place:

- **It is only a file where SQL reads one:** after `FROM`, `JOIN`, `DESCRIBE`, `SUMMARIZE` or `PIVOT`, or as
  the first argument of a table function, alone or in a list. `WHERE p = 'aemo.data_lakehouse/Files/c'` is a string.
- **A wrong name fails.** It never reaches DuckDB, which would look on the local disk, and whose `glob()` would
  answer no rows with no error.

**`abfss://` still reads.** It is what DuckDB reads, and what `glob()` and `filename = true` answer, so what
they return can be pasted back. A URL by GUIDs reads too. Nothing else shows one: an error and **Logs** say a
file as it was written.

**A `.bim` or `.yaml` is a file too.** It is a representation of a model, not the model. It can be stored
anywhere, and a lakehouse can hold thousands of them across its subfolders, even with the same file
name. A file has no model name.

**Creating a model from a file is what takes a name.** The model, whether for Fabric or only for a Fabric
app, must be `<workspace>.<model>_semanticmodel`, wherever the file was stored. An export overwrites
whatever we have under that name. It asks first when that means replacing a different file at the model's
path in `Files/`, or an app no export created.

**A database file is still a file.** Once attached, its tables are `<name>.<schema>.<table>`, which is not
a OneLake table's name. A file whose name is a workspace's is attached as `<name>_file`, so that the
workspace's tables can still be named.

## A write's target

**A write goes to a lakehouse, by the table's four parts.** Where SQL writes a table
([ARCHITECTURE.md](ARCHITECTURE.md#sql-writes)):

| Written | Means |
| --- | --- |
| `INSERT INTO aemo.data_lakehouse.dbo.monthly …` | The table `monthly` in `dbo` of lakehouse `data`, in workspace `aemo`. |
| `CREATE SCHEMA aemo.data_lakehouse.raw` | The schema `raw` in that lakehouse. |
| `INSERT INTO aemo.data_warehouse.dbo.t …` | Refused: only a lakehouse is written. |
| `INSERT INTO aemo.data.monthly …` | Refused: a target is a table's whole name. |
| `INSERT INTO memory.main.t …` | Refused: not a lakehouse's table. |

## Spelling a name

**Bare when it can be, quoted when it must.** A part stays bare only if it matches
`[A-Za-z_][A-Za-z0-9_]*` and is not one of DuckDB's reserved words. Anything else is double-quoted, with
`"` doubled: `"ANZ Retail"."gold-1_warehouse"."select"."a""b"`. A dot inside quotes belongs to the part. The
kind is part of the item's part, so it goes inside the quotes: `"gold-1_warehouse"`.

**Case does not matter.** The kind is written lowercase, the other parts as OneLake spells them, and any
case reads the same object: DuckDB matches names ignoring case, and so does the lookup against OneLake's
listings.

**Display names, GUIDs only on request.** A name has to be readable and writable by hand and by an agent.
A Direct Lake model's definition holds GUIDs, and they are turned into names when it opens. The cost of
display names is that renaming an item or workspace changes the names under it, so a saved query that uses
the old name stops resolving. A query that must survive a rename names its tables by GUIDs.

## How a name is read

**A table is a dotted name of four or more parts whose second part ends in `_<kind>`, or whose first two
parts are GUIDs.** `tableRefs` finds them in any statement, including `DESCRIBE`, `EXPLAIN` and a view's
body, and the engine opens each one before the statement runs.
- A fifth part on is a column of that table, and `memory.` in front is the engine's catalog.
- A name of three parts is not a table reference, nor is one whose item has no kind.
- Comments and string literals are skipped, and whitespace around the dots is allowed.
- A name written the old way, `lakehouse.<workspace>.<item>.<schema>.<table>`, is refused with its name now
  (`oldTableName`).

**A model is a two-part name whose second part ends in `_semanticmodel`.** `unopenedModels` finds the ones
not open yet and the host opens them first. dax-sql then compiles the statement.

**A listing keeps the whole path.** DuckDB's own listings name only the innermost of the nested schemas,
which would merge two workspaces' `dbo.t` into one row, and its parser takes two parts at most in
`SHOW TABLES FROM`. `catalogStatement` rewrites those statements, so a listing reports names that run as
written: `SHOW ALL TABLES` says `memory`, `aemo.data_lakehouse.dbo` and `dim_duid`.

## Why nothing shorter

**A short name resolves to whatever carries it.** A model table used to be read by its short name when it
had no Direct Lake source. That name resolved in `memory.main`, where `Files/` views live, so an open
`Files/` view of the same name was read as the model's table, with no error: the answer looked right and
came from the wrong data.

Now a model table with no OneLake table behind it is refused when a query reads it: *"is not a OneLake
table, so it has no workspace.item_lakehouse.schema.table name to read"*. An Import, DirectQuery or
composite model is refused for the same reason.

## Known gaps

These do not meet the contract yet:

- **Two features read outside these names.** An app from Export to Fabric uses its own `v_<table>` views
  (`fabric_app/site/app.js`), and Time travel writes `iceberg_scan` directly (`page/app.js`).
- **A write names its table by display names only.** A GUID name reads, but is not a write's target.

## Tests that hold this

| Test | What it holds |
| --- | --- |
| `test/js/names.test.mjs` | Building names, the `dbo` default, the kind mapping and suffix, quoting, and the host and page `sqlPart` staying equal |
| `test/js/sql.test.mjs` | `tableRefs`: case, quotes, spaces, GUIDs, the fifth part as a column, the old way, and what is not a table; `fileRefs`: where a file's name counts, and what is refused; `SHOW` rewriting; write targets |
| `test/js/semantic.test.mjs` | `modelSqlName`, `unopenedModels`, and a model with no workspace refused |
| `test/js/sqltables.test.mjs` | A GUID name resolved by the item it stands for |
| `test/js/cli-engine.test.mjs` | Listed names run as SQL; an Import model is refused |
| `test/js/engine-host.test.mjs` | Tables opened by name across kinds, spaces, case and GUIDs; whole-path listings; a workspace named like a database refused; a database file renamed off a workspace's name |
| `test/sql/tables.test`, `catalog.test`, `semantic.test` | SQL statements and their answers, through the command line |
