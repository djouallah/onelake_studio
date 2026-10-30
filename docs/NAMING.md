# Naming convention

Every table and semantic model has one SQL name, and the editor, Explore, the command line and the
agent skill all write that same name. This is the contract for those names and the reasons behind
them. The code that holds it is [`src/names.js`](../src/names.js) and
[`src/sql.js`](../src/sql.js) on the host, and [`app/semantic.js`](../app/semantic.js) and
[`app/paths.js`](../app/paths.js) in the panel.

## The rule

**A name is where Fabric keeps the object, with the object's type moved to the front.** The two
shapes are one rule applied to two kinds of object:

| Object | Where Fabric keeps it | Its SQL name |
| --- | --- | --- |
| A table | `<workspace>/<item>.<Kind>/Tables/<schema>/<table>` | `<kind>.<workspace>.<item>.<schema>.<table>` |
| A semantic model | an item directly in `<workspace>` | `semanticmodel.<workspace>.<model>` |

So a name is unique by construction: no two objects have the same address. It also needs no setup,
so a statement can join across items and workspaces without attaching or declaring anything:

```sql
SELECT *
FROM lakehouse.aemo.data.dbo.dim_duid d
JOIN warehouse.sales.gold.dbo.fact_orders f ON f.duid = d.duid;

SELECT dim_region.Region, AGG("Registered MW") FROM semanticmodel.aemo.nem GROUP BY ALL;
```

## Tables: five parts

| Part | Holds | Comes from | Why it is there |
| --- | --- | --- | --- |
| `kind` | `lakehouse`, `warehouse`, `sqldatabase` or `mirroreddatabase` | the type on the item's OneLake folder | Fabric lets two items of different types share a name in one workspace, so `lakehouse.aemo.data` and `warehouse.aemo.data` are two items. It is also the DuckDB catalog the name lives in. |
| `workspace` | the workspace's display name | OneLake's listing | Two workspaces can both have `dbo.t`. |
| `item` | the item's display name, without its type | OneLake's listing | One workspace holds many items. |
| `schema` | the table's schema | OneLake's catalog | Warehouses and schema-enabled lakehouses have real schemas. |
| `table` | the table's name | OneLake's catalog | The object itself. |

**The kind is Fabric's spelling, not the folder's.** `SQLDbNative` is `sqldatabase`, and
`MountedRelationalDatabase` and any `Mirrored*` type are `mirroreddatabase`. An item of any other
type holds no tables SQL can name, and is refused.

**The schema is always written.** A lakehouse without schemas is `dbo`, the one schema OneLake's
catalog reports for it. Every table therefore has the same shape, and there is no four-part form to
learn or to parse.

**Five parts are nested schemas, not a parser trick.** The kind is a DuckDB catalog (`ATTACH
':memory:'`, one per kind) and the workspace, item and schema are schemas nested inside it, made as
a statement names them. The table is a view there, over `iceberg_scan` of the table's current
metadata. The name is therefore real SQL, which DuckDB resolves itself.

## Semantic models: three parts

**A model has no item or schema above it.** It sits directly in its workspace, so the rule leaves
two parts after the type. The parts a table has and a model lacks are not left out; there is nothing
for them to name.

**A model reads as one table.** A query names the model once, and reaches what is inside it from
there: `dim_region.Region` is a table and column within the query, not more of the model's name.
Adding a part for a model's table would split one object into many names, and the join between them
is the model's job.

**A model's source cannot be part of its name.** A Direct Lake model can read several lakehouses, so
no single item is its parent. Its source is what it reads, not where it is:
`SHOW SEMANTIC VIEWS` reports it as `tables_from`.

**Three parts is what the layers underneath take.** It is DuckDB's ordinary `catalog.schema.name`,
and dax-sql, which compiles the model before DuckDB sees the statement, reads at most
`[db.][schema.]name`. A longer name would need nesting that nothing here asks for.

**`semanticmodel` is a catalog of its own**, as `lakehouse` is for lakehouse tables. A model and a
lakehouse can share a name, and a five-part name is never mistaken for a model.

**Where the model part comes from:**
- **From the tree, or named in a query:** the model's own Fabric name, in its own workspace.
- **From a `.bim` or `.yaml` under `Files/`:** the file's name up to its first dot, with anything
  other than `A-Za-z0-9_` replaced by `_`, and `_` in front of a leading digit. The workspace is the
  one the file is in.

## Spelling a name

**Bare when it can be, quoted when it must.** A part stays bare only if it matches
`[A-Za-z_][A-Za-z0-9_]*` and is not one of DuckDB's reserved words. Anything else is double-quoted,
with `"` doubled: `warehouse."ANZ Retail"."gold-1"."select"."a""b"`. A dot inside quotes belongs to
the part.

**Case does not matter.** The kind is written lowercase, the other parts as OneLake spells them, and
any case reads the same object: DuckDB matches names ignoring case, and so does the lookup against
OneLake's listings.

**Display names, never GUIDs.** A name has to be readable and writable by hand and by an agent. A
Direct Lake model's definition holds GUIDs, and they are turned into names when it opens. The cost
of this choice is that renaming an item or workspace changes the names under it, so a saved query
that uses the old name stops resolving.

## Reading a name

**A table is a dotted name of five or more parts whose first part is a kind.** `tableRefs` finds
them in any statement, including `DESCRIBE`, `EXPLAIN` and a view's body, and the engine opens each
one before the statement runs.
- A sixth part on is a column of that table.
- A name of four parts is not a table reference, nor is one whose first part is not a kind.
- Comments and string literals are skipped, and whitespace around the dots is allowed.

**A model is a three-part name whose first part is `semanticmodel`.** `unopenedModels` finds the ones
not open yet and the host opens them first. dax-sql then compiles the statement.

**A listing keeps the whole path.** DuckDB's own listings name only the innermost of the nested
schemas, which would merge two workspaces' `dbo.t` into one row, and its parser takes two parts at
most in `SHOW TABLES FROM`. `catalogStatement` rewrites those statements, so a listing reports names
that run as written.

## Why nothing shorter

**A short name resolves to whatever carries it.** A model table used to be read by its short name
when it had no Direct Lake source. That name resolved in `memory.main`, where `Files/` views live,
so an open `Files/` view of the same name was read as the model's table, with no error: the answer
looked right and came from the wrong data.

Now a model table with no OneLake table behind it is refused when a query reads it: *"is not a
OneLake table, so it has no five-part name to read"*. An Import, DirectQuery or composite model is
refused for the same reason.

## What these names do not cover

- **A file** in `Files/` is named by its OneLake URL, `abfss://<workspace>@onelake.dfs.fabric.microsoft.com/<item>/Files/…`.
- **A database file** under `Files/` is attached, and its tables are `<name>.<schema>.<table>`.

## Known gaps

These do not meet the contract yet:

- **Two model files can get one name.** A `Files/` model has no item part, so two `nem.bim` files in
  different lakehouses of one workspace are both `semanticmodel.<workspace>.nem`, and the second
  replaces the first (`src/semviews.js`).
- **A bare model name can still compile.** `app/semantic.js` says "nothing shorter", but dax-sql
  resolves a name by its last parts, so `FROM nem` can reach an open view when only one fits.
- **The command line's help shows the short form.** `bin/cli.mjs` has `FROM model` in the `sql` help.
- **Two places capitalise the kind.** `claude-skill/SKILL.md` writes `Lakehouse.<ws>…` and the
  comment heading the section in `src/names.js` writes `Kind.workspace…`. Both still read correctly,
  since case does not matter.
- **Two features read outside these names.** An app from Export to Fabric uses its own `v_<table>`
  views (`fabric_app/site/app.js`), and Time travel writes `iceberg_scan` directly (`app/app.js`).

## Tests that hold this

| Test | What it holds |
| --- | --- |
| `test/js/names.test.mjs` | Building names, the `dbo` default, the kind mapping, quoting, and the host and panel `sqlPart` staying equal |
| `test/js/sql.test.mjs` | `tableRefs`: case, quotes, spaces, the sixth part as a column, and what is not a table; `SHOW` rewriting |
| `test/js/semantic.test.mjs` | `modelSqlName`, `unopenedModels`, and a model with no workspace refused |
| `test/js/cli-engine.test.mjs` | Listed names run as SQL; an Import model is refused with the five-part error |
| `test/js/engine-host.test.mjs` | Tables opened by name across kinds, spaces and case; whole-path listings |
| `test/sql/tables.test`, `catalog.test`, `semantic.test` | SQL statements and their answers, through the command line |
