# Missing features

What a user would expect OneLake Studio to support and it does not yet, ranked within each section.

Read from the code at `46e39a1`, with dax-sql 0.1.2. Nothing was run. An item marked *decide* needs a
call on a rule first. A `dax-sql/` path is in the [dax-sql](https://github.com/djouallah/dax-sql)
repository.

## Where the product's own promise falls short

| # | Expected | Today | Evidence |
| --- | --- | --- | --- |
| 1 | **`SHOW ALL TABLES` lists the tenant.** The README says it "lists them all", and the pitch is one catalog. | It, `information_schema`, completion and Go To list only what the tree has already seen. There is no command to load the rest, so a new install lists almost nothing. Proposed: a **Load Whole Catalog** command, cached, also on the command line. | [`README.md:18`](../README.md#L18), [`ARCHITECTURE.md:130`](ARCHITECTURE.md#L130), [`src/engine-host.js:169`](../src/engine-host.js#L169) |
| 2 | **A query says how old its data is.** | Table metadata is served from cache for up to 24 hours, so a query can read a day-old snapshot. The panel gives only a cache or OneLake count for the last wait. The command line does say "as of". Proposed: "data as of …" on the result, with a one-click re-read. | [`src/extension.js:307`](../src/extension.js#L307), [`app/app.js:1268`](../app/app.js#L1268), [`src/agent.js:646`](../src/agent.js#L646) |
| 3 | **Export warns when a model has security roles.** | Roles are never passed to dax-sql, nothing checks for them, and object-level security is ignored with no error. An exported app reads the tables with a SAS, so its viewers can see rows the model's roles would hide. Only the git-ignored blog mentions this. Proposed: warn at export and on the Model page, and state it in ARCHITECTURE. dax-sql already takes `options.roles`, so **View as Role** is a cheap follow-up. | [`src/exportapp.js`](../src/exportapp.js), [`ARCHITECTURE.md:305`](ARCHITECTURE.md#L305), `dax-sql/src/index.js:97`, `dax-sql/README.md:42`, `blog/onelake-studio-tutorial.md:234` |
| 4 | **A table whose Iceberg conversion failed can still be read.** | The Delta files are there, but the only read path is the Iceberg catalog, so the table is an error with no fallback. *Decide:* a `delta_scan` fallback, and how that sits with the one read path. | [`app/data.js:464`](../app/data.js#L464), [`ARCHITECTURE.md:400`](ARCHITECTURE.md#L400) |
| 5 | **A model's measures say if they compile.** | A measure dax-sql cannot compile is found only when someone runs it. Proposed: compile each measure on open and mark the failures on the Model page, with the reason. Export can use the same list. | no such check in [`app/`](../app/) |

## Semantic models

| # | Expected | Today | Evidence |
| --- | --- | --- | --- |
| 6 | **Sort by column:** months in calendar order. | `sortByColumn` is not read by dax-sql or Explore. Pivot orders by the column's own values, so January sorts after April. It must also survive the conversion to Ossie. | [`app/explore/explore.js:116`](../app/explore/explore.js#L116); no match in `app/`, `src/`, `dax-sql/src`, `dax-sql/formats` |
| 7 | **Display folders and hierarchies** in the field list, and a hierarchy dropped on Rows. | Not read. A model with hundreds of measures is a flat list. | `dax-sql/formats/tmsl.js:13` |
| 8 | **An Import or DirectQuery model can at least be read.** | Refused whole, with nothing kept, though its tables, measures, DAX and relationships need no data. Proposed: open the Model page with Pivot off. To check: whether Import tables written to OneLake could also be queried. | [`app/semantic.js:93`](../app/semantic.js#L93), [`ARCHITECTURE.md:210`](ARCHITECTURE.md#L210) |
| 9 | **The SQL everyone types first works over a model.** | `SELECT *`, `SELECT DISTINCT` and `COUNT(*)` are refused. Proposed: `DISTINCT` as `GROUP BY ALL`, `COUNT(*)` as a row count, and `SELECT *` refused with a list of the fields. In dax-sql, then move the pin. | `dax-sql/src/sql.js:118`, `:122`, `:551` |
| 10 | **Newer and common DAX.** | Not handled: user-defined functions, calendars and week-based time intelligence, `XIRR`, `XNPV`, `PMT`, `YEARFRAC`, `SIN`, `COS`, `TAN`, `GEOMEAN`, `APPROXIMATEDISTINCTCOUNT`, `USEROBJECTID`, `CUSTOMDATA`. `GEOMEANX` is documented but not registered. | `dax-sql/src/compiler.js:478`, `:746`, `dax-sql/src/parser.js:62`, `dax-sql/src/functions/aggregate.js:318`, `dax-sql/DESIGN.md:662` |
| 11 | **Errors are not hidden.** | `IFERROR` returns its first argument and `ISERROR` is always false, with no notice in a result. Proposed: mark a measure that uses them in item 5's list. | `dax-sql/src/functions/scalar.js:242`, `:254` |
| 12 | **Named Pivot views.** | One set of shelves is kept per model. A second view overwrites the first. | [`app/explore/explore.js:248`](../app/explore/explore.js#L248) |

## The query workflow

| # | Expected | Today | Evidence |
| --- | --- | --- | --- |
| 13 | **Run a whole script**, with one result per statement. | One statement per run, one result pane. Proposed: the host still takes one at a time, and Run All sends them in turn. | [`src/sql.js:118`](../src/sql.js#L118), [`app/paths.js:218`](../app/paths.js#L218) |
| 14 | **Run a `.sql` from my repo.** | Only saved queries and untitled ones the extension opened can run, so queries kept in git cannot. Proposed: an explicit **Open as OneLake Query**, which leaves other `.sql` files alone. | [`src/extension.js:816`](../src/extension.js#L816), [`ARCHITECTURE.md:171`](ARCHITECTURE.md#L171) |
| 15 | **Stop from the keyboard.** | Only the panel's button stops a query. No command, no key. | [`app/index.html:200`](../app/index.html#L200) |
| 16 | **An editor that knows SQL:** keywords and functions, a hover with a column's type or a measure's DAX, go to definition, format document. | Only CodeLens and name completion are registered. | [`src/queryeditor.js:193`](../src/queryeditor.js#L193) |
| 17 | **Grid columns resize, hide and freeze.** | No column resizing in the grid. | [`app/grid.js`](../app/grid.js) |
| 18 | **Temporary views while working.** | The host allows `CREATE TEMP VIEW` and the command line reaches it, but the editor refuses it, so the two differ. *Decide:* allow it in the editor, and whether temporary tables count as a write. | [`src/sql.js:129`](../src/sql.js#L129), [`app/paths.js:209`](../app/paths.js#L209) |
| 19 | **Join a local CSV to a OneLake table.** | Local paths are locked down. *Decide:* one folder allowed by a setting, read only. | [`src/engine-host.js:342`](../src/engine-host.js#L342) |
| 20 | **Left from the old list.** | Results kept across sessions, a histogram per column in Profile, and time travel from a Delta commit. | `git show 1b7354f^:docs/NICE_TO_HAVE.md` |

## The explorer and files

| # | Expected | Today | Evidence |
| --- | --- | --- | --- |
| 21 | **A file has a right-click.** A file's name is its `abfss://` URL, yet nothing copies it. | No menu on files or folders: no Copy URL, no Select Top Rows. Go To does not search files. | [`package.json:329`](../package.json#L329), [`NAMING.md:119`](NAMING.md#L119) |
| 22 | **Read a folder as one table**, with partitions. | Only one file opens from the tree. A glob has to be typed by hand. | [`src/tree.js:324`](../src/tree.js#L324) |
| 23 | **A table expands to its columns.** | A table has no children, so no column can be seen, copied or dragged from the tree. | [`src/tree.js:255`](../src/tree.js#L255) |
| 24 | **Open in Fabric** for a workspace, item or model. | The only link out is an exported app. | [`src/extension.js:1523`](../src/extension.js#L1523) |
| 25 | **An item that can't be read says so.** | A mirrored Databricks catalog or an Eventhouse is simply absent. Proposed: list it with the reason. To check: an Eventhouse with OneLake availability on. | [`src/names.js:46`](../src/names.js#L46) |

## Reach

| # | Expected | Today | Evidence |
| --- | --- | --- | --- |
| 26 | **The command line without VS Code**, for CI or a remote agent. | VS Code must be open and signed in. No service principal. *Decide:* this is the current design. | [`bin/cli.mjs:10`](../bin/cli.mjs#L10) |
| 27 | **National clouds.** | The OneLake host is hard-coded and only the public Microsoft sign-in is used. | [`src/names.js:26`](../src/names.js#L26), [`src/extension.js:59`](../src/extension.js#L59) |

## Where the docs and code disagree

- Pivot's summaries include median in [`ARCHITECTURE.md:254`](ARCHITECTURE.md#L254); the code has none
  ([`app/explore/explore.js:33`](../app/explore/explore.js#L33)).
- A model over several lakehouses is called refused in [`src/extension.js:1100`](../src/extension.js#L1100)
  and [`src/tree.js:270`](../src/tree.js#L270); only zero is
  ([`src/extension.js:1162`](../src/extension.js#L1162)).
- Export… re-runs the SQL, so it drops the grid's sort, while a comment says the CSV keeps the order on
  screen ([`app/app.js:749`](../app/app.js#L749), [`app/app.js:1256`](../app/app.js#L1256)).
- [`package.json:43`](../package.json#L43) declares `virtualWorkspaces: true`, while
  [`ARCHITECTURE.md:43`](ARCHITECTURE.md#L43) needs desktop VS Code.

## Ruled out, so not proposed

DAX queries, writes, DDL and grid editing, `CREATE`/`DROP SEMANTIC VIEW`, a TDS connection (so no
warehouse views or stored procedures), ER diagrams for lakehouse tables, vscode.dev, short names,
dataset refresh and model deploy (writes), query history (removed: not wanted), and anything more on a
table's Pivot than Edit SQL and Close.
