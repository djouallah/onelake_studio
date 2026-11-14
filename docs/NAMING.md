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
| A lakehouse table | `<workspace>.<lakehouse>.<schema>.<table>` | `aemo.data.dbo.dim_duid` |
| Any other item's table | `<workspace>.<item>_<kind>.<schema>.<table>` | `aemo.gold_warehouse.sales.orders` |
| A table by GUIDs | `"<workspace id>"."<item id>".<schema>.<table>` | `"0f3c1a2b-…"."9a1b2c3d-…".dbo.dim_duid` |
| A semantic model | `<workspace>.<model>_semanticmodel` | `aemo.nem_semanticmodel` |
| A file | `'<workspace>.<lakehouse>/Files/<path>'` | `'aemo.data/Files/x.parquet'` |

`<kind>` is `warehouse`, `sqldatabase` or `mirroreddatabase`. A lakehouse needs none, and `_lakehouse` after its
name reads too.

| Written | Means |
| --- | --- |
| `aemo.data.dbo.dim_duid` | A lakehouse table, named as Fabric's Spark names it. |
| `AEMO.DATA.DBO.DIM_DUID` | The same table: case does not matter. |
| `aemo.data_lakehouse.dbo.dim_duid` | The same table: a lakehouse can have its kind after its name, as any other item has. |
| `aemo.data_warehouse.dbo.dim_duid` | A different table: the item is a warehouse named `data`. |
| `"ANZ Retail"."gold-1".sales."order"` | A table: a part with a space, a hyphen or a reserved word is quoted. |
| `` `ANZ Retail`.`gold-1`.sales.`order` `` | The same table: backticks quote a part too, as Spark writes it. |
| `aemo.data.dbo.dim_duid.region` | Column `region` of that table. |
| `aemo.data.dim_duid` | Not a table: three parts. A lakehouse without schemas still writes `dbo`. |
| `lakehouse.aemo.data.dbo.dim_duid` | Refused: the old way. The error gives the name it has now. |
| `dbo.dim_duid`, `dim_duid` | Not a OneLake table: no workspace or lakehouse. |
| `aemo.nem_semanticmodel` | A semantic model. |
| `USE aemo.data.dbo`, then `dim_duid` | `aemo.data.dbo.dim_duid`: after a USE, a table of that schema can be named alone. |

## The rule

**A name is where Fabric keeps the object.** OneLake keeps a table at
`<workspace>/<item>.<Kind>/Tables/<schema>/<table>`, and its name follows that path. A lakehouse is most of
what SQL reads and writes, so its name is the one Fabric's Spark uses, with nothing added. Any other item
has its kind after its name, because Fabric lets a lakehouse and a warehouse share a name in a workspace:
`aemo.data` and `aemo.data_warehouse` are two items.

| Object | Where Fabric keeps it | Its name |
| --- | --- | --- |
| A lakehouse table | `<workspace>/<lakehouse>.Lakehouse/Tables/<schema>/<table>` | `<workspace>.<lakehouse>.<schema>.<table>` |
| Another item's table | `<workspace>/<item>.<Kind>/Tables/<schema>/<table>` | `<workspace>.<item>_<kind>.<schema>.<table>` |
| A semantic model | an item directly in `<workspace>` | `<workspace>.<model>_semanticmodel` |

Nothing has to be attached or declared before a statement uses a name:

```sql
SELECT *
FROM aemo.data.dbo.dim_duid d
JOIN sales.gold_warehouse.dbo.fact_orders f ON f.duid = d.duid;

SELECT dim_region.Region, AGG("Registered MW") FROM aemo.nem_semanticmodel GROUP BY ALL;
```

## Tables: four parts

| Part | Holds | Comes from | Why it is there |
| --- | --- | --- | --- |
| `workspace` | the workspace's display name | OneLake's listing | Two workspaces can both have `dbo.t`. |
| `item` | a lakehouse's display name, or another item's with `_<kind>` after it | OneLake's listing | One workspace holds many items, of several kinds. |
| `schema` | the table's schema | OneLake's catalog | Warehouses and schema-enabled lakehouses have real schemas. |
| `table` | the table's name | OneLake's catalog | The object itself. |

**The kind is Fabric's spelling, not the folder's.** `SQLDbNative` is `sqldatabase`, and
`MountedRelationalDatabase` and any `Mirrored*` type are `mirroreddatabase`. An item of any other type
holds no tables SQL can name, and is refused.

**The schema is always written.** A lakehouse without schemas is `dbo`, the one schema OneLake's catalog
reports for it, and the one Microsoft tells Spark to write too. Every table therefore has the same shape.

**Two clashes are possible.** A lakehouse named `gold_warehouse` and a warehouse named `gold` in the same
workspace would both be `ws.gold_warehouse`, and lakehouses named `data` and `data_lakehouse` would both be
`ws.data_lakehouse`. The name then means two items, so it is refused, and the error says to name the table by
its GUIDs. With only one of the two, the name is that one.

**Four parts are nested schemas, not a parser trick.** The workspace, the item and the schema are schemas
nested in the engine's catalog, made as a statement names them. The table is a view there, over its lake
table. The name is therefore real SQL, which DuckDB resolves itself.

## By GUIDs

**A table can also be named by its workspace's and its item's GUIDs:**
`"0f3c1a2b-1111-2222-3333-444455556666"."9a1b2c3d-aaaa-bbbb-cccc-ddddeeeeffff".dbo.dim_duid`. A GUID has hyphens,
so it is quoted. The GUIDs say the kind, so the item has no `_<kind>`.

- **It is the same table.** The engine asks Fabric once what the GUIDs are called and keeps the answer, so
  it resolves offline after that.
- **It is for input.** The tree, Copy name, listings and errors give the display name. A GUID name still
  reads after an item or a workspace is renamed, which a display name does not.
- **It reaches what a name can't.** A workspace named like a database of the engine (`system`, `temp`,
  `lake`, or a database file a tab attached) is found as that database, since DuckDB looks for a
  catalog before a schema, and one named like a schema DuckDB keeps (`main`, `pg_catalog`,
  `information_schema`) is not found at all. Their tables are refused by name, and the error says to name
  them by GUIDs.

## USE: a schema for bare names

**`USE <workspace>.<item>.<schema>` lets a tab name that schema's tables by their names alone**, as Fabric's
Spark does:

```sql
USE aemo.data.dbo;
SELECT * FROM dim_duid;     -- aemo.data.dbo.dim_duid
SELECT * FROM mart.sales;   -- aemo.data.mart.sales
```

- `USE aemo.data` is its `dbo`, and a warehouse's is `USE aemo.gold_warehouse.sales`. `USE onelake` ends it. The
  item is looked for in OneLake when the USE runs, and an item that isn't there is refused.
- It holds for the tab, until the next USE, and for the statements of one `sql` command on the command line.
  Another tab has its own.
- A bare name is a table's name, as DuckDB's parser reads the statement: a column, an alias or a function is
  never one, and a CTE's name is the CTE. The engine writes each one's whole name before DuckDB runs it.
- A name the engine has itself stays its own: a file's view, `information_schema.tables`, a database file's
  `shop.orders`. One that is a table of the schema too is refused, as a name that means two tables.
- A write's target can be bare too: `INSERT INTO monthly …`, `CREATE TABLE monthly AS …`, `CREATE SCHEMA raw`.
- `SHOW TABLES` lists the schema.
- The tree, Copy name, listings and errors give the whole name.

**Why the engine does it, not DuckDB.** DuckDB 2.0 can't put a nested schema in its search path (*nested schemas
cannot be used in the search path*), and each statement here runs on a connection of its own, which a USE
would not outlive.

## Semantic models: two parts

**A semantic model is `<workspace>.<model>_semanticmodel`, however it was made.** That holds for a Power BI
model in Fabric, and for a model created from a `.bim` or `.yaml`, whether for Fabric or only for a Fabric
app. It is an item directly in its workspace, so it has no schema of its own.

**Every workspace has one model of a name, so the name is unique by design.** Fabric guarantees one
workspace of a name in the tenant and one semantic model of a name in a workspace. A model created from a
file must use this name too, and it does not get a second one: if the name is taken in that workspace, the
newer model overwrites what we have under it. The name therefore identifies exactly one model at a time.

**Opening and exporting never reach the Power BI item.** A model opened from a file replaces only our own view of
that name, and an export replaces only our own copy and app. Only **Create Semantic Model** writes a semantic model
item in Fabric, and it asks first. Until the Fabric item is downloaded again, `<workspace>.<model>_semanticmodel` is the one
created last.

Why two parts and not four:

- **A model has no item or schema above it.** It sits directly in its workspace.
- **A model reads as one table.** A query names the model once and reaches what is inside it from there:
  `dim_region.Region` is a table and column within the query, not more of the model's name. Its tables are
  lakehouse tables, which have names of their own.
- **A model's source cannot be part of its name.** A Direct Lake model can read several lakehouses, so no
  single item is its parent. `SHOW SEMANTIC VIEWS` reports what it reads as `tables_from`.

**It is a view in its workspace's schema**, which is where the engine lists it. dax-sql compiles the model
before DuckDB sees the statement.

## Files

**A file is its lakehouse's name, then its path under `Files/`, and it can be anything.** A lakehouse is
`<workspace>.<lakehouse>`: a `.` leads to its tables, and `/Files/` leads to its files. Only a lakehouse has
`Files/`. The name means one file from anywhere, with no default lakehouse and nothing attached.

| Written | Means |
| --- | --- |
| `'aemo.data/Files/x.parquet'` | A file. |
| `'AEMO.DATA/Files/x.parquet'` | The same file: case does not matter before the `/`. |
| `'aemo.data_lakehouse/Files/x.parquet'` | The same file, as a table's name can have `_lakehouse`. |
| `'aemo.data/Files/X.parquet'` | A different file: the path is exact. |
| `'"ANZ Retail".data/Files/a b.csv'` | A file: a part is quoted as it is in a table's name, and the path never is. |
| `'aemo.data/Files/raw/*.csv'` | Every `.csv` directly in `raw/`. `**` goes through its subfolders. |
| `'zip://aemo.data/Files/a.zip/b.csv'` | An entry in a zip. |
| `'aemo.data/Files'` | The folder itself, for `glob('aemo.data/Files/*')`. |
| `'aemo.*/Files/x.parquet'` | Refused: a wildcard goes in the path, and a name means one item. |
| `'aemo.data/Tables/dbo/t/x.parquet'` | Refused: a table has its own name. |
| `'aemo.data_warehouse/Files/x.parquet'` | Refused: only a lakehouse has `Files/`. |
| `'lakehouse.aemo.data/Files/x.parquet'` | Refused: the old way. The error gives the name it has now. |
| `'Files/x.parquet'` | Not a OneLake file: no workspace or lakehouse. |

```sql
SELECT * FROM 'aemo.data/Files/x.parquet';
SELECT * FROM read_csv('aemo.data/Files/raw/*.csv', header = true);
```

**The quotes are required.** DuckDB reads a file only from a string, and a bare `/` is a syntax error. They
also say that this is a file and not a table.

**This one is a parser's work, unlike a table's name.** DuckDB can't read it, so the engine gives it the
file's `abfss://` URL before the statement runs, finding the workspace and lakehouse in the kept listings as
it does for a table (`fileRefs` in [`core/sql.js`](../core/sql.js), `withFileUrls` in
[`core/engine/engine-host.js`](../core/engine/engine-host.js)). So that nothing is read from the wrong place:

- **It is only a file where SQL reads one:** after `FROM`, `JOIN`, `DESCRIBE`, `SUMMARIZE` or `PIVOT`, or as
  the first argument of a table function, alone or in a list. `WHERE p = 'aemo.data/Files/c'` is a string.
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
| `INSERT INTO aemo.data.dbo.monthly …` | The table `monthly` in `dbo` of lakehouse `data`, in workspace `aemo`. |
| `CREATE SCHEMA aemo.data.raw` | The schema `raw` in that lakehouse. |
| `COPY (…) TO 'aemo.data/Files/out/x.parquet'` | A file in that lakehouse's `Files/`. |
| `INSERT INTO aemo.data_warehouse.dbo.t …` | Refused: only a lakehouse is written. |
| `INSERT INTO aemo.data.monthly …` | Refused: a target is a table's whole name. |

## Spelling a name

**Bare when it can be, quoted when it must.** A part stays bare only if it matches
`[A-Za-z_][A-Za-z0-9_]*` and is not one of DuckDB's reserved words. Anything else is double-quoted, with
`"` doubled: `"ANZ Retail"."gold-1_warehouse"."select"."a""b"`. A dot inside quotes belongs to the part. An
item's kind is part of the item's part, so it goes inside the quotes: `"gold-1_warehouse"`. Backticks quote
a part as double quotes do, with `` ` `` doubled, so a name written for Spark reads as it is.

**Case does not matter.** The kind is written lowercase, the other parts as OneLake spells them, and any
case reads the same object: DuckDB matches names ignoring case, and so does the lookup against OneLake's
listings.

**Display names, GUIDs only on request.** A name has to be readable and writable by hand and by an agent.
A Direct Lake model's definition holds GUIDs, and they are turned into names when it opens. The cost of
display names is that renaming an item or workspace changes the names under it, so a saved query that uses
the old name stops resolving. A query that must survive a rename names its tables by GUIDs.

## How a name is read

**A table is a dotted name of four or more parts.** `tableRefs` finds them in any statement, including
`DESCRIBE`, `EXPLAIN` and a view's body, and the engine opens each one before the statement runs.
- A second part ending in `_<kind>` is that kind of item. Two GUIDs first are a name by GUIDs. Anything else
  is a lakehouse, and one ending in `_lakehouse` is the lakehouse named without it, unless the workspace has only
  a lakehouse of the whole name.
- A lakehouse name is a OneLake table only in a workspace OneLake has. Anything else, a struct's field
  (`s.col.a.b`) or a table of an attached database file, is DuckDB's, and goes to it as written. A workspace
  the kept listing doesn't have is looked for again, at most once a minute.
- A name that starts with one of the engine's own databases is DuckDB's.
- A fifth part on is a column of that table.
- Comments and string literals are skipped, and whitespace around the dots is allowed.
- A name written the old way, `lakehouse.<workspace>.<item>.<schema>.<table>`, is refused with its name now
  (`oldTableName`). An item that isn't there says what the name may have meant: an item of that name of
  another kind.

**A model is a two-part name whose second part ends in `_semanticmodel`.** `unopenedModels` finds the ones
not open yet and the host opens them first. dax-sql then compiles the statement.

**A listing keeps the whole path, and names only what a user names.** DuckDB's own listings name only the
innermost of the nested schemas, which would merge two workspaces' `dbo.t` into one row, and its parser takes
two parts at most in `SHOW TABLES FROM`. `catalogStatement` rewrites those statements, so a listing reports
names that run as written: `SHOW ALL TABLES` gives schema `aemo.data.dbo` and name `dim_duid`. The listings
leave out DuckDB's own `system` and `temp`, the `lake` the engine reads tables from, and a write's catalog.

## Why nothing shorter

**A short name resolves to whatever carries it**, so a bare name is a OneLake table only after a USE, and
never when something else carries it too. A model table used to be read by its short name when it
had no Direct Lake source. That name resolved in the engine's `main` schema, where `Files/` views live, so an
open `Files/` view of the same name was read as the model's table, with no error: the answer looked right and
came from the wrong data.

Now a model table with no OneLake table behind it is refused when a query reads it: *"is not a OneLake
table, so it has no workspace.lakehouse.schema.table name to read"*. An Import, DirectQuery or composite
model is refused for the same reason.

## Known gaps

These do not meet the contract yet:

- **Two features read outside these names.** An app from Export to Fabric uses its own `v_<table>` views
  (`fabric_app/site/app.js`), and Time travel writes `iceberg_scan` directly (`page/app.js`).
- **A write names its table by display names only.** A GUID name reads, but is not a write's target, and
  neither is a lakehouse whose own name ends in `_warehouse` or another kind.

## Tests that hold this

| Test | What it holds |
| --- | --- |
| `test/js/names.test.mjs` | Building names, the `dbo` default, the kind mapping and suffix, quoting, and the host and page `sqlPart` staying equal |
| `test/js/sql.test.mjs` | `useOf` and bare names under a USE, reads and writes; `tableRefs`: case, quotes, backticks, GUIDs, the fifth part as a column, the old way, the engine's own catalogs; `fileRefs`: where a file's name counts, and what is refused; `SHOW` rewriting; write targets |
| `test/js/semantic.test.mjs` | `modelSqlName`, `unopenedModels`, and a model with no workspace refused |
| `test/js/sqltables.test.mjs` | A GUID name resolved by the item it stands for; a bare name outside OneLake's workspaces; `_lakehouse` after a lakehouse's name; the clash with a suffixed name; what a missing item may have meant |
| `test/js/cli-engine.test.mjs` | Listed names run as SQL; an Import model is refused |
| `test/js/engine-host.test.mjs` | Tables opened by name across kinds, spaces, case, backticks and GUIDs; USE in one tab, with a CTE, DESCRIBE, SHOW TABLES and a file's view of the same name; whole-path listings; a workspace named like a database refused; a database file renamed off a workspace's name |
| `test/sql/tables.test`, `catalog.test`, `semantic.test` | SQL statements and their answers, through the command line |
