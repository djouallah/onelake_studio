# Naming convention

This is the contract for how every object in OneLake Studio is named. Change the code to fit it, not the
other way round. The code that holds it is [`src/names.js`](../src/names.js) and
[`src/sql.js`](../src/sql.js) on the host, and [`app/semantic.js`](../app/semantic.js) and
[`app/paths.js`](../app/paths.js) in the panel.

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
| A file | its `abfss://` URL | `'abfss://aemo@onelake.dfs.fabric.microsoft.com/data.Lakehouse/Files/x.parquet'` |

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

**A semantic model is the Fabric item**, the Power BI model. The model part is its own Fabric name, and
the workspace part is its own workspace.

**`semanticmodel.<workspace>.<model>` is unique by design.** Fabric guarantees one workspace of a name in
the tenant and one semantic model of a name in a workspace, so the name identifies exactly one model. It
belongs to that item and to nothing else.

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

**A file uses its `abfss://` URL, and it can be anything.** The name is where the file is, in any
subfolder under `Files/`:

```sql
SELECT * FROM 'abfss://aemo@onelake.dfs.fabric.microsoft.com/data.Lakehouse/Files/x.parquet';
```

**A `.bim` or `.yaml` is a file too.** It is a representation of a model, not the model. A lakehouse can
hold thousands of them across its subfolders, and they do not get a model's name:
`semanticmodel.<workspace>.<model>` belongs to the Fabric item, and is unique by design.

**A database file is still a file.** Once attached, its tables are `<name>.<schema>.<table>`, which is not
a OneLake table's name.

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

- **An opened model file still takes a model's name.** `registerModel` in `app/semantic.js` names `nem.bim`
  `semanticmodel.<workspace>.nem`, the same name a Fabric item `nem` has in that workspace.
- **A bare model name can still compile.** `app/semantic.js` says "nothing shorter", but dax-sql resolves a
  name by its last parts, so `FROM nem` can reach an open view when only one fits.
- **The command line's help shows the short form.** `bin/cli.mjs` has `FROM model` in the `sql` help.
- **Two places capitalise the kind.** `claude-skill/SKILL.md` writes `Lakehouse.<ws>…` and the comment
  heading the section in `src/names.js` writes `Kind.workspace…`. Both still read correctly, since case
  does not matter.
- **Two features read outside these names.** An app from Export to Fabric uses its own `v_<table>` views
  (`fabric_app/site/app.js`), and Time travel writes `iceberg_scan` directly (`app/app.js`).

## Tests that hold this

| Test | What it holds |
| --- | --- |
| `test/js/names.test.mjs` | Building names, the `dbo` default, the kind mapping, quoting, and the host and panel `sqlPart` staying equal |
| `test/js/sql.test.mjs` | `tableRefs`: case, quotes, spaces, the sixth part as a column, and what is not a table; `SHOW` rewriting |
| `test/js/semantic.test.mjs` | `modelSqlName`, `unopenedModels`, and a model with no workspace refused |
| `test/js/cli-engine.test.mjs` | Listed names run as SQL; an Import model is refused with the five-part error |
| `test/js/engine-host.test.mjs` | Tables opened by name across kinds, spaces and case; whole-path listings |
| `test/sql/tables.test`, `catalog.test`, `semantic.test` | SQL statements and their answers, through the command line |
