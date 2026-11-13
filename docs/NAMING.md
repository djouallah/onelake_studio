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
| A table | `<kind>.<workspace>.<item>.<schema>.<table>` | `lakehouse.aemo.data.dbo.dim_duid` |
| A semantic model | `semanticmodel.<workspace>.<model>` | `semanticmodel.aemo.nem` |
| A file | `'lakehouse.<workspace>.<item>/Files/<path>'` | `'lakehouse.aemo.data/Files/x.parquet'` |

`<kind>` is one of `lakehouse`, `warehouse`, `sqldatabase` or `mirroreddatabase`.

| Written | Means |
| --- | --- |
| `lakehouse.aemo.data.dbo.dim_duid` | A table. |
| `LAKEHOUSE.AEMO.DATA.DBO.DIM_DUID` | The same table: case does not matter. |
| `warehouse.aemo.data.dbo.dim_duid` | A different table: the item is a warehouse. |
| `warehouse."ANZ Retail"."gold-1".sales."order"` | A table: a part with a space, a hyphen or a reserved word is quoted. |
| `lakehouse.aemo.data.dbo.dim_duid.region` | Column `region` of that table. |
| `lakehouse.aemo.data.dim_duid` | Not a table: four parts. A lakehouse without schemas still writes `dbo`. |
| `dbo.dim_duid`, `dim_duid` | Not a OneLake table: no kind, workspace or item. |
| `semanticmodel.aemo.nem` | A semantic model. |

## The rule

**A name is where Fabric keeps the object, with the object's type moved to the front.** The two shapes
are one rule applied to two kinds of object:

| Object | Where Fabric keeps it | Its name |
| --- | --- | --- |
| A table | `<workspace>/<item>.<Kind>/Tables/<schema>/<table>` | `<kind>.<workspace>.<item>.<schema>.<table>` |
| A semantic model | an item directly in `<workspace>` | `semanticmodel.<workspace>.<model>` |

No two objects have the same address, so no two have the same name. Nothing has to be attached or
declared before a statement uses one:

```sql
SELECT *
FROM lakehouse.aemo.data.dbo.dim_duid d
JOIN warehouse.sales.gold.dbo.fact_orders f ON f.duid = d.duid;

SELECT dim_region.Region, AGG("Registered MW") FROM semanticmodel.aemo.nem GROUP BY ALL;
```

## Tables: five parts

| Part | Holds | Comes from | Why it is there |
| --- | --- | --- | --- |
| `kind` | `lakehouse`, `warehouse`, `sqldatabase` or `mirroreddatabase` | the type on the item's OneLake folder | Two items of different types can share a name in one workspace, so `lakehouse.aemo.data` and `warehouse.aemo.data` are two items. It is also the DuckDB catalog the name lives in. |
| `workspace` | the workspace's display name | OneLake's listing | Two workspaces can both have `dbo.t`. |
| `item` | the item's display name, without its type | OneLake's listing | One workspace holds many items. |
| `schema` | the table's schema | OneLake's catalog | Warehouses and schema-enabled lakehouses have real schemas. |
| `table` | the table's name | OneLake's catalog | The object itself. |

**The kind is Fabric's spelling, not the folder's.** `SQLDbNative` is `sqldatabase`, and
`MountedRelationalDatabase` and any `Mirrored*` type are `mirroreddatabase`. An item of any other type
holds no tables SQL can name, and is refused.

**The schema is always written.** A lakehouse without schemas is `dbo`, the one schema OneLake's catalog
reports for it. Every table therefore has the same shape, and there is no four-part form to learn or to
parse.

**Five parts are nested schemas, not a parser trick.** The kind is a DuckDB catalog (`ATTACH ':memory:'`,
one per kind) and the workspace, item and schema are schemas nested inside it, made as a statement names
them. The table is a view there, over `iceberg_scan` of the table's current metadata. The name is
therefore real SQL, which DuckDB resolves itself.

## Semantic models: three parts

**A semantic model is `semanticmodel.<workspace>.<model>`, however it was made.** That holds for a Power
BI model in Fabric, and for a model created from a `.bim` or `.yaml`, whether for Fabric or only for a
Fabric app.

**Every workspace has one model of a name, so the name is unique by design.** Fabric guarantees one
workspace of a name in the tenant and one semantic model of a name in a workspace. A model created from a
file must use this name too, and it does not get a second one: if the name is taken in that workspace, the
newer model overwrites what we have under it. The name therefore identifies exactly one model at a time.

**Overwriting never reaches the Power BI item.** Nothing here writes a semantic model item in Fabric, so a
model created from a file replaces only our own view of that name, and an export replaces only our own
copy and app. Until the Fabric item is downloaded again, `semanticmodel.<workspace>.<model>` is the one
created last.

Why three parts and not five:

- **A model has no item or schema above it.** It sits directly in its workspace, so the rule leaves two
  parts after the type. There is nothing for the other two parts to name.
- **A model reads as one table.** A query names the model once and reaches what is inside it from there:
  `dim_region.Region` is a table and column within the query, not more of the model's name. Adding a part
  for a model's table would split one object into many names, and the join between them is the model's
  job.
- **A model's source cannot be part of its name.** A Direct Lake model can read several lakehouses, so no
  single item is its parent. `SHOW SEMANTIC VIEWS` reports what it reads as `tables_from`.
- **Three parts is what the layers underneath take.** It is DuckDB's ordinary `catalog.schema.name`, and
  dax-sql, which compiles the model before DuckDB sees the statement, reads at most
  `[db.][schema.]name`.

**`semanticmodel` is a catalog of its own**, as `lakehouse` is for lakehouse tables. A model and a
lakehouse can share a name, and a five-part name is never mistaken for a model.

## Files

**A file is its lakehouse's name, then its path under `Files/`, and it can be anything.** An item is
always `lakehouse.<workspace>.<item>`: a `.` leads to its tables, and `/Files/` leads to its files. Only a
lakehouse has `Files/`. The name means one file from anywhere, with no default lakehouse and nothing
attached.

| Written | Means |
| --- | --- |
| `'lakehouse.aemo.data/Files/x.parquet'` | A file. |
| `'LAKEHOUSE.AEMO.DATA/Files/x.parquet'` | The same file: case does not matter before the `/`. |
| `'lakehouse.aemo.data/Files/X.parquet'` | A different file: the path is exact. |
| `'lakehouse."ANZ Retail".data/Files/a b.csv'` | A file: a part is quoted as it is in a table's name, and the path never is. |
| `'lakehouse.aemo.data/Files/raw/*.csv'` | Every `.csv` directly in `raw/`. `**` goes through its subfolders. |
| `'zip://lakehouse.aemo.data/Files/a.zip/b.csv'` | An entry in a zip. |
| `'lakehouse.aemo.data/Files'` | The folder itself, for `glob('lakehouse.aemo.data/Files/*')`. |
| `'lakehouse.aemo.*/Files/x.parquet'` | Refused: a wildcard goes in the path, and a name means one item. |
| `'lakehouse.aemo.data/Tables/dbo/t/x.parquet'` | Refused: a table has its five-part name. |
| `'warehouse.aemo.data/Files/x.parquet'` | Refused: only a lakehouse has `Files/`. |
| `'Files/x.parquet'` | Not a OneLake file: no workspace or item. |

```sql
SELECT * FROM 'lakehouse.aemo.data/Files/x.parquet';
SELECT * FROM read_csv('lakehouse.aemo.data/Files/raw/*.csv', header = true);
```

**The quotes are required.** DuckDB reads a file only from a string, and a bare `/` is a syntax error. They
also say that this is a file and not a table.

**This one is a parser's work, unlike a table's name.** DuckDB can't read it, so the engine gives it the
file's `abfss://` URL before the statement runs, finding the workspace and item in the kept listings as it
does for a table (`fileRefs` in [`core/sql.js`](../core/sql.js), `withFileUrls` in
[`core/engine/engine-host.js`](../core/engine/engine-host.js)). So that nothing is read from the wrong place:

- **It is only a file where SQL reads one:** after `FROM`, `JOIN`, `DESCRIBE`, `SUMMARIZE` or `PIVOT`, or as
  the first argument of a table function, alone or in a list. `WHERE p = 'lakehouse.a.b/Files/c'` is a string.
- **A wrong name fails.** It never reaches DuckDB, which would look on the local disk, and whose `glob()` would
  answer no rows with no error.

**`abfss://` still reads.** It is what DuckDB reads, and what `glob()` and `filename = true` answer, so what
they return can be pasted back. A URL by GUIDs reads too. Nothing else shows one: an error and **Logs** say a
file as it was written.

**A `.bim` or `.yaml` is a file too.** It is a representation of a model, not the model. It can be stored
anywhere, and a lakehouse can hold thousands of them across its subfolders, even with the same file
name. A file has no model name.

**Creating a model from a file is what takes a name.** The model, whether for Fabric or only for a Fabric
app, must be `semanticmodel.<workspace>.<model>`, wherever the file was stored. An export overwrites
whatever we have under that name. It asks first when that means replacing a different file at the model's
path in `Files/`, or an app no export created.

**A database file is still a file.** Once attached, its tables are `<name>.<schema>.<table>`, which is not
a OneLake table's name.

## A write's target

**A write goes to a lakehouse, so a write's target can leave out the kind.** Where SQL writes a table
([ARCHITECTURE.md](ARCHITECTURE.md#sql-writes)), its name is the five parts, or `<workspace>.<lakehouse>.<table>` for a
table in `dbo`:

| Written | Means |
| --- | --- |
| `INSERT INTO lakehouse.aemo.data.dbo.monthly …` | The table `monthly` in `dbo` of lakehouse `data`, in workspace `aemo`. |
| `INSERT INTO aemo.data.monthly …` | The same table. |
| `CREATE SCHEMA lakehouse.aemo.data.raw`, `CREATE SCHEMA aemo.data.raw` | The schema `raw` in that lakehouse. |
| `INSERT INTO warehouse.aemo.data.dbo.t …` | Refused: only a lakehouse is written. |
| `INSERT INTO memory.main.t …` | Refused: `memory` is the engine's own, as are `lake`, `system_internal` and the kinds. |

The three-part form is a write's target only. Anywhere else a three-part name is DuckDB's own (`memory.main.t`) or a
semantic model's (`semanticmodel.aemo.nem`), and a table is read by its five parts.

## Spelling a name

**Bare when it can be, quoted when it must.** A part stays bare only if it matches
`[A-Za-z_][A-Za-z0-9_]*` and is not one of DuckDB's reserved words. Anything else is double-quoted, with
`"` doubled: `warehouse."ANZ Retail"."gold-1"."select"."a""b"`. A dot inside quotes belongs to the part.

**Case does not matter.** The kind is written lowercase, the other parts as OneLake spells them, and any
case reads the same object: DuckDB matches names ignoring case, and so does the lookup against OneLake's
listings.

**Display names, never GUIDs.** A name has to be readable and writable by hand and by an agent. A Direct
Lake model's definition holds GUIDs, and they are turned into names when it opens. The cost of this choice
is that renaming an item or workspace changes the names under it, so a saved query that uses the old name
stops resolving.

## How a name is read

**A table is a dotted name of five or more parts whose first part is a kind.** `tableRefs` finds them in
any statement, including `DESCRIBE`, `EXPLAIN` and a view's body, and the engine opens each one before the
statement runs.
- A sixth part on is a column of that table.
- A name of four parts is not a table reference, nor is one whose first part is not a kind.
- Comments and string literals are skipped, and whitespace around the dots is allowed.

**A model is a three-part name whose first part is `semanticmodel`.** `unopenedModels` finds the ones not
open yet and the host opens them first. dax-sql then compiles the statement.

**A listing keeps the whole path.** DuckDB's own listings name only the innermost of the nested schemas,
which would merge two workspaces' `dbo.t` into one row, and its parser takes two parts at most in
`SHOW TABLES FROM`. `catalogStatement` rewrites those statements, so a listing reports names that run as
written.

## Why nothing shorter

**A short name resolves to whatever carries it.** A model table used to be read by its short name when it
had no Direct Lake source. That name resolved in `memory.main`, where `Files/` views live, so an open
`Files/` view of the same name was read as the model's table, with no error: the answer looked right and
came from the wrong data.

Now a model table with no OneLake table behind it is refused when a query reads it: *"is not a OneLake
table, so it has no five-part name to read"*. An Import, DirectQuery or composite model is refused for the
same reason.

## Known gaps

These do not meet the contract yet:

- **Two features read outside these names.** An app from Export to Fabric uses its own `v_<table>` views
  (`fabric_app/site/app.js`), and Time travel writes `iceberg_scan` directly (`page/app.js`).

## Tests that hold this

| Test | What it holds |
| --- | --- |
| `test/js/names.test.mjs` | Building names, the `dbo` default, the kind mapping, quoting, and the host and page `sqlPart` staying equal |
| `test/js/sql.test.mjs` | `tableRefs`: case, quotes, spaces, the sixth part as a column, and what is not a table; `fileRefs`: where a file's name counts, and what is refused; `SHOW` rewriting |
| `test/js/semantic.test.mjs` | `modelSqlName`, `unopenedModels`, and a model with no workspace refused |
| `test/js/cli-engine.test.mjs` | Listed names run as SQL; an Import model is refused with the five-part error |
| `test/js/engine-host.test.mjs` | Tables opened by name across kinds, spaces and case; whole-path listings |
| `test/sql/tables.test`, `catalog.test`, `semantic.test` | SQL statements and their answers, through the command line |
