# Changelog

## Unreleased

- **The desktop app: small fixes.** Upload Files… has Cancel, as in VS Code. Settings shows its descriptions
  without the Markdown marks. Read Log keeps to one tab, shown at its end. A tree node opens at once and says
  Loading… while its listing is read. Closing a tab shows the one next to it, not the last.
- **The desktop app: polish.** The tree takes Home, End, left to a node's parent and right to its first child, and
  moving through a large lakehouse is no longer slow. A selected row shows its buttons. The mouse wheel scrolls the
  tabs, Ctrl+F4 closes one, and a double-click on the strip's empty part starts a query. A message stays while the
  pointer is on it. Help has Open Data Folder.
- **A Report has a style: the whole look at once.** *Theme › Style* is Studio, as before, or one of three of its own:
  Paper (warm and light, titles in a serif, earth colours), Midnight (deep blue, round tiles, bright colours, lines
  that glow) and Slate (cool grey, square flat tiles, one blue then greys). A style looks the same in any editor
  theme, brings its own colours until another palette is picked, and is kept in the report (`theme.style`), so an
  exported app has it too.
- **A Report's tiles sit on their page.** A tile is a surface with a soft shadow under it and rounder corners, with
  more room inside and between tiles; a text tile is words on the page, with no surface. A tile can have a subtitle
  under its title: a double-click on the title edits both. A card's trend line has a fill that fades under it.
- **A Report has a title, and says when its data was read.** Over the pages: the report's title (a double-click
  writes one, where the Report is saved) and the time every tile last had its answer.
- **Charts are drawn with more care.** A bar's free end is rounded. A line is thicker, ends in a dot on its last
  value, and one alone in its chart has a fill that fades under it; an area alone fades the same way. Grid lines are
  dashed and lighter, a category axis has no ticks, and the series under the pointer stays bright while the others dim.
- **A Report's tiles stay on screen while a pick filters them.** A click on a bar or a row used to blank every
  other tile to "Waiting…" until its new answer came. Each now keeps what it shows, dimmed, and a chart's bars and
  lines move from the old values to the new.
- **The Model page's tables can be moved.** Drag a table anywhere and its relationships' lines follow. *Auto
  arrange*, shown once a table has moved, puts them all back. Where they are lasts while the tab is open.
- **A model that is open already is not opened twice.** A click on a semantic model, a model file or a
  `.fabricapp` that a tab shows brings that tab forward, as it is, where it used to open another.
- **A model file opened from disk has Export to Fabric.** A `.bim` or Ossie `.yaml` on this machine, such as a
  semantic model downloaded from the tree, exports as a model file in a lakehouse does: client side, in the
  workspace its tables are in, when it names one lakehouse. Its `.fabricapp` opens and exports again the same way.
- **dax-sql 0.2.0.** A query 0.1.7 answered no longer fails on Fabric's planner limits; object-level security is
  answered as Power BI answers it; a fact table is grouped by its keys before its joins under a slicer or a role too.
- **A Fabric app shares out a least and a most below the joins too.** A tile's MIN or MAX of a large table, now
  grouped by its keys before the joins, ran on one engine; its scan is shared out between the engines as a sum's is.

## 0.2.21

- **An Ossie model or a `.fabricapp` opened in VS Code opens in the desktop app, when it is installed.** This
  includes a double-click in Windows on a `*.ossie.yaml`, which Windows hands to VS Code as a `.yaml`. Without the
  app, it opens in the extension as before.
- **A semantic model downloads as Ossie or TMSL.** The tree's download button on a semantic model asks which: Ossie
  (`<model>.ossie.yaml`, experimental) or TMSL (`<model>.bim`, Power BI's default). TMSL is Fabric's own `model.bim`,
  as Fabric gives it, kept beside the Ossie copy each time the model is read from Fabric, so it downloads offline
  too. A model read before this version needs one Refresh online first.
- **The desktop app can be `.yaml`'s default program, so an Ossie model opens straight in it.** Windows lets only you
  choose it: right-click a `.yaml`, *Open with › Choose another app › OneLake Studio › Always*. A double-click on a
  model then opens in the app with no stop in VS Code. Any other YAML, such as a dbt `schema.yml`, goes on to the
  program that opened it before, VS Code first, and the app does not show.
- **An export is named after its model file.** Export to Fabric suggests `sales.fabricapp` for `sales.ossie.yaml`,
  and `<model name>.fabricapp` for a semantic model, not `sales-model-explore.fabricapp`. The app keeps its name in
  Fabric. The Visual's CSV download is `<model>.csv`.
- **A Fabric app reads a large table with all its engines.** A query over a table of ten million rows or more ran on
  one engine while the others waited. Its scan is now shared out between them, each engine reading its share of the
  table's files, and one adds the answers up. Measured on a 3.6 GB table with four engines, a sum by a column went from
  5.1 s to 1.2 s. Sums, counts, minimums and maximums are shared out; a distinct count or an average still runs on one
  engine. The app starts as many engines as half the machine's cores, two at least and four at most.
  A smaller table is read by one engine as before: sharing out costs about a tenth of a second, which its scan is too
  short to win back. `?split=0` in the app's address runs every query on one engine, to compare.
- **A Report tile's statement names the model.** Logs showed a tile's query as `FROM model`, a name no SQL box
  takes, so Open and Copy gave a statement that could not run. It now says the model's own name, as the Visual's does.
- **The Report's + adds a page again.** It answered "The report could not be read" while the new page's name was
  ready to be typed.
- **A viewer of an app on a semantic model needs Read on the model, not Build.** The app, the docs and the website
  said Build. Build is needed to publish the app; a viewer with Read alone is answered. The box a refused viewer sees
  now says to ask the model's owner for access.
- **An exported app's function builds with its own build command.** `npm run build` in the local copy's
  `rayfin/functions` failed for want of Node's type definitions, so `rayfin dev` and `rayfin up` on it would have too.
- **Closing the engine waits for what it is doing.** It let go of DuckDB while its own once-a-second look at what was
  read could still be running.
- **A Fabric app's engines start one after another.** Started together, one of them could fail to open
  ("NoModificationAllowedError … createSyncAccessHandle"): DuckDB-WASM's open tidies the browser's scratch space,
  and could take another engine's for an abandoned one. The app starts two to four engines.
- **A Fabric app on a semantic model opens again.** In 0.2.20 its page stopped at "Failed to fetch dynamically imported
  module": it asked for one of its own files where no export puts it. Export the app again to fix one already published.
- **A Fabric app's query over a large table no longer fails with "Snappy decompression failure".** When a query read
  bytes the browser had not downloaded yet, the app downloaded them and ran it again, and that second run failed until
  the page was reloaded. It now reads right.

## 0.2.20

- **The Report looks the part.** A tile's title is in the text colour and lines up with what is under it; its tools
  (move, edit, copy, remove, resize) are icons over its corner, shown while the pointer is on it, so they take no room.
  A text tile with no title has no empty row above it. A figure sits under its name, at the left. A chart's axis says
  `$10M`, not `$10,000,000.00`; the tooltip keeps the full number. A slicer's dropdown shows only what is picked.
  Bars have square ends. **Theme** has a **Background**: the editor's colours, or the Report's own Dark or Light, the
  same in any editor theme. A page's name is underlined when it is on screen, as the tabs over it are.
- **Visual has a new look.** It fills the tab, in flat panes: the fields, then the tools over a Filters card and a Show as
  card (the mark, and Values), then Columns and Rows over the view, and a status line with the row count and Top. A pill
  is plain for a column and in the measure's colour for a figure. The mark is picked
  from a list with an icon each, and its button says what Automatic picked. Swap, sort, totals, clear and Format are
  icons. An empty view shows where Columns and Rows go and takes a drop there. Bars are wider, a chart's axes are named
  from the shelves, and the pivot's table has a header band and keeps its row names in view when scrolled sideways.
  Add to report is the lit button, not Download CSV. The Report and Model pages get the same square corners.
- **A Fabric app's Report draws its tiles side by side.** They ran one after another, so the app's second engine sat
  idle and each tile's columns were downloaded on their own. Every tile now asks at once: the engines take a query
  each, and what the tiles read between them comes down as one batch. On a semantic model, four tiles ask at a time.
  `?engines=4` in the app's address gives it four engines to try on a large model.
- **A Fabric app left open past an hour keeps reading.** A download refused because its signature ran out (a laptop
  that slept) is signed again and retried. The app also asks the browser to keep its downloads when the disk is short.
- **A Fabric app tries a failed download again**, twice, where the connection or the server failed. One dropped
  request among a table's hundreds used to fail the tile. A table whose plan failed once is planned again by the next
  tile, not left failed until the page is reloaded.
- **A Fabric app starts its engines while it signs in**, and a visit whose tiles this browser already has draws
  without waiting for them.
- **A Fabric app asks OneLake less before its first tile.** The app's function already read each table's snapshot
  from the catalog and threw it away; the page then fetched it again, a request for every table of the model. The
  function now hands it over. An app exported before this fetches as it did until it is exported again.
- **A window no longer waits for the sign-in to answer.** With an account already known, a tab opens and the engine
  starts on what this machine holds. VS Code's account provider shares one thread with every other extension, and at
  startup it could take half a minute to answer: a click in that time sat on "Opening OneLake Studio…", and the
  engine started only after it. A window whose thread was held was also told it had no internet for half a minute.
- **Clicking a table reads none of its rows.** It opens on Stats, from the listing. Its rows are read when **Data** is
  clicked (or at once, with `tableOpensOn` set to `data`). The click used to read its first rows in the background,
  which synced the table and brought its files to this machine.
- **A filter skips the files its rows can't be in.** For a Delta table, each file's lowest and highest value of a
  whole-number, date or timestamp column is kept, so `WHERE id = 42` or a range of dates opens only the files that can
  hold it. It
  used to open every file of the table, each a request to OneLake. A table read before this gets them the next time
  its files change.
- **Table files come down faster.** Six at a time, not four, written as they arrive, and a download the connection
  dropped is tried once more.
- **Your sign-in goes only to OneLake.** The OneLake token used to go with any `abfss://` URL DuckDB read, whatever its
  host: one a table's own metadata named, or one a statement put together from pieces. It now goes only to OneLake's
  host and the workspaces being read, and a table that names a file anywhere else is refused, and says so.
- **The code is one folder for each part:** `core/`, `extension/`, `page/`, `cli/`, `desktop/`, `fabric_app/`,
  `xmla/`. The command line is `cli/cli.mjs` (it was `bin/cli.mjs`); the agent skill is rewritten with the new path
  when a window starts.
- **Visual has no SQL box.** Its query is always the one it makes from its fields. **Show plan** takes Show SQL's
  place: the profile and the plan tree of that query, in place of the view, and **Show visual** goes back.
- **A Report has pages.** Their names sit over the tiles: click one to show it, double-click to rename it, drag it to
  reorder, and **+** adds a page. Hover over a name for its ✕; a page with tiles asks first. Add to report puts the
  visual on the page last shown, and a tile's grip dropped on another page's name moves it there. Each page keeps its
  own picks. A report from before pages opens as one page, Page 1. The Fabric app shows the names when it has two
  pages or more.
- **Text tiles.** The Report's **Add text** adds a text tile to the page: double-click it to write headings, **bold**,
  *italic*, links and lists, then **Done**.
- **Format a Visual.** Visual's **Format** opens a pane at the right of the view: a chart's series colours, data
  labels, legend, axis titles and value range, a table's colour by value (a tint or a bar) and banded rows, a card's
  number size and colour, and each number's style (1,234, 1,234.56, 1.2K, 12%, $1,234). It is kept with the Visual's
  fields, so a Report tile draws it the same, and ✎ edits it there. Every change shows at once.
- **The Report's Theme.** The Report's **Theme** sets the colours and text size of every page, gives a column's values
  (a fuel, a region) one colour in every tile, and for each tile of the page whether its title shows, its size, and
  which filters of the filter bar it follows.
- **Every Report tile is a Visual.** A tile's query is always the one Visual writes from its fields; no tile holds SQL
  of its own. A tile of an older report that held SQL says so, and is built again in Visual.
- **Top N and filters on measures in Visual.** **Top** keeps the first 1 to 100 rows as they are sorted, ties kept. A
  measure dropped on Filters keeps the rows whose figure is in a range ("curtailed above 0").
- **Treemap, Calendar and Map** are new marks in Visual. A treemap's boxes are its Rows (one or two levels), sized by
  the measure; a calendar colours each day of a date column, one strip a year; a map puts a point for each latitude
  and longitude on Rows, sized by the measure and coloured by a column on Columns. The map's outline of the world ships
  with OneLake Studio and the app.
- **A card's trend and change.** A date on a card's Rows draws its trend under the figure. In Visual's Format pane, a
  second measure on Values can be the card's change, ▲ or ▼, green when it goes the good way.
- **A filter bar over the Report.** **+ Filter** adds a filter on a column to every page: a dropdown, a list to tick, or
  dates from and to with 3d, 7d, 30d, 1y and All. A tile can stop following one (Theme).
- **More in Format.** Several measures in one chart, each a bar, a line, an area or a dashed line, on the left axis or
  the right one; each measure's total as a line across; the highest point labelled; a zoom slider.
- **The Fabric app's look.** A header with the model's name; the page's controls in the text's colour, so colour is
  for the data; cards with a soft shadow.

## 0.2.19

- **A Fabric app downloads only the columns its Report reads.** A table larger than 32 MB used to come down whole
  before its first chart drew. Now only each file's footer and the columns the charts read come down. On a Report over
  2 of a 4 GB table's 22 columns, that is 340 MB in about 13 s instead of 4 GB in about 2 minutes. A column a chart
  reads later comes down when that chart first needs it. Tables of 32 MB or less still come down whole.

- **Edit a Report tile.** Hover over a tile for its tools. ✎ opens the visual in Visual, on its own fields, with a strip
  above it: change the fields, the mark or the title, then **Update tile**, and the tile changes where it is. **Cancel**
  leaves it as it was. Either way Visual gets back the fields it had before. ⧉ copies a tile, and a double-click on a
  tile's title renames it.
- **Card is a Visual.** Pick Card in Visual's marks to show each field on Values as one big number, then Add to report.
  On the Report, the other tiles' picks filter it. Automatic draws a card too when only Values has fields, where it
  used to draw a table of one cell.
- **A Report tile's grip, ✕ and the new tools show only while the pointer or the keyboard is on the tile**, so a
  report reads as it will in the app.
- **A model named `<name>.ossie.yaml` opens in OneLake Studio from VS Code by itself**, as Apache Ossie's own tools name
  a model; a plain `.yaml` keeps its Open in OneLake Studio button. Studio's copies of downloaded models, and the model
  inside an app's file, are named `.ossie.yaml` too: the ones already on this machine are renamed once.
- **Open a model or an app's file from disk.** In VS Code, a `.bim` or an Ossie `.yaml` has **Open in OneLake Studio**
  on the editor's title bar and on Explorer's right-click, and an app's file opens in OneLake Studio by itself. In the
  desktop app, File › Open… (Ctrl+O), a double-click on an app's file, and Windows' "Open with" on a `.yaml` or `.bim`.
  An app's file opens on its Report page.
- **The exported app is one `.fabricapp` file**, a zip as before. One saved as `.zip` is renamed the next time it is
  exported. A client-side app holds its model, `model.yaml`, and runs on it: a change to the lakehouse's file reaches
  the app when it is exported again, and an edit to `model.yaml` is published by opening the file and exporting there.
  An app on a semantic model names the model and holds no copy.
- **Saving over an app's file asks nothing more.** The question about what changed in it since it was last published is
  gone: an export from Explore rewrites the file (its report kept) and publishes it.
- **A client-side app no longer fails at start with "Unexpected token '<'"**: every site has its `engine.json` now, and
  the page takes a file the site lacks as missing.
- **An app name held by Fabric's recycle bin is said so**: delete the old app there, or restore it, and export again.
- **Export to Fabric asks only where to save the app**: a Save dialog named for it, opened where it was saved last,
  else in Documents. The confirmation that listed the workspace, the model and what the app runs on is gone, with
  its Choose Another Folder….
- **A Fabric app's download counts bytes as they come.** A large table, downloaded on a first visit, showed
  "0 of 35 files, 0 MB" for minutes: the count moved only when a whole file was in, and six files of 250 MB come
  down at once. It now shows the MB coming in, the speed, and about how long is left.
- **A Fabric app downloads only the tables its charts read.** It used to download and open every table of the model
  in the background as soon as it started, and on a slow connection those took the bandwidth from the table a chart
  was waiting for. A table now comes down when a query first reads it.
- **A semantic model has no Download Again button.** Refresh on its workspace, or on its Semantic models, reads each
  model downloaded there from Fabric again, behind, and replaces its local copy. One that can't be read keeps its
  copy, and the log says why.
- **Export to Fabric runs the app on what you opened, and asks nothing about it.** The window under the button is
  gone. A Power BI semantic model's app queries that model as it is, Direct Lake, DirectQuery or Import, and nothing
  is written to the model or for it: before, the export rewrote the model from Studio's copy of it, and wrote a
  `.yaml` of it into its lakehouse. A semantic model that names no lakehouse, or several, can be exported now too. A
  model file's app is client side, DuckDB in the browser; for one on a semantic model, Create Semantic Model first,
  then export that model. The confirmation says what the app runs on. The command line's `export` takes no `--mode`.
- **An app on a semantic model deploys no function of its own**, only the connector's that Fabric makes: its page
  never called ours, and deploying it took a few minutes of every export.
- **Create Semantic Model is on Explore's Model page too**, for a model file opened from a lakehouse's Files/: the
  same dialog as the tree's ⛁, and Explore's status line says how it went.
- **Create Semantic Model asks in one dialog**, with Direct Lake and DirectQuery as its buttons, in place of a list
  and then a second question when a model of that name is there: the dialog says so itself.
- **The desktop app reads OneLake tables with VS Code open.** Its engine did not start, since VS Code's held the lake
  (`meta.ducklake`): it has a lake of its own now, so the first read of a table there downloads its files again.

## 0.2.18

- **The lake's metadata can be queried, as `system_internal`.** `SELECT * FROM system_internal.ducklake_data_file`
  and the rest read what the lake keeps about each OneLake table: its snapshots, files and columns, and
  `studio_synced`, what each table was last synced from. It was refused before.
  It is in the tree too, after the workspaces: a click on one of its tables puts its first rows' SQL in a tab.
- **A OneLake table's files are kept whole, on this machine, as queries read them.** A Delta or Iceberg table is
  read through a DuckLake catalog made from its own log, and a file a query opens comes down whole in the background;
  after that the table reads from disk, and offline. A file no snapshot names any more is deleted on its own, and past
  the disk cache's size the least recently read go. The block cache (cache_httpfs) is gone. Keep offline and tables
  in use keep their table current, and bring down only what queries read.
- **A query on a table you have read before starts at once.** It reads the table as this machine last synced it, and
  asks OneLake nothing first, even after a restart: a table whose log has many commits used to wait over a minute
  for them. The background sync finds new snapshots: every hour for a table in use, once a day for the rest, or on
  **Refresh** of its lakehouse. A sync reads only the commits since the last one, 16 at a time.
- **The disk cache keeps 256 GB by default, up from 64.** `onelakeStudio.diskCacheMaxGB` still sets it.
- **A model has a Report, after Model and Visual.** It starts empty, and you build it from Visual (below). The
  model view still opens on Model. Export to Fabric, now on the Report, publishes the Report alone as the app.
- **Build the Report from Visual.** **Add to report** puts the pivot on screen on the Report as a tile, drawn as Visual
  draws it, with any mark, and a click on it filters the other tiles. Each tile has a ✕ that takes it out. The Report
  is kept on this machine until the model's first Export to Fabric, which publishes it; after that it is the zip's
  `site/report.json`, which Add to report and ✕ write. Export to Fabric's app draws the tiles, and only reads them.
- **Place and size the Report's tiles freely.** The Report is a grid of 12 columns. Drag a tile's grip ⠿ anywhere on
  it, and drag the ◢ in its corner to size it (or focus either and use the arrow keys). The other tiles move out of
  the way and float up into the room left, so a tile can sit under a short slicer beside a tall chart. Nothing runs
  again, the filters stay, and the layout is kept.
- **Pivot is now Visual**, for a model and for a table: it draws tables and charts alike.
- **Each page's buttons are in the bar, at the right.** Model has Keep offline, Diagram | YAML and Open in Excel;
  Visual has Show SQL, Download CSV and Add to report; the Report has Export to Fabric. The model's
  name is no longer repeated at the right of the bar. A model's Edit SQL button is gone: Visual's Show SQL
  has the model's SQL, to change and run there.
- **Create Semantic Model, with no app.** A `.bim` or `.yaml` in a lakehouse's Files has a new icon in the tree: it
  makes the Power BI semantic model of that file, named for it, in its workspace, on Direct Lake or DirectQuery,
  picked first. It asks before it updates a model of that name. The command line has it too: `semanticmodel`.
- **Slicer is a Visual.** Pick Slicer in Visual's marks, with a column on Rows, then Add to report. With a measure on
  Values it lists only the values that have one, its figure beside each (Year with Revenue: only the years with
  revenue), and a filter narrows it too. It draws as a list, buttons, a dropdown or, for a date or a number, a range.
  On the Report, what you pick in it filters every other tile; the filter is listed above the tiles, with a ✕ that
  clears it. Slicers work in Export to Fabric's app too.
- **A click in the Report filters its other tiles.** Click a bar, a line's point or a table's row, and every other tile
  runs again for that value; the tile you clicked keeps all its bars, with yours bright. A bar above the tiles lists
  each filter, with a ✕ to clear it, and clicking the same bar again clears it too. Filters from several tiles all
  apply. This works in Export to Fabric's app as well.
- **Export to Fabric's local copy is one file, `<app>.zip`**, where the `<app>/` folder used to be. It holds the whole
  app but its packages, which the export adds when it publishes, so the zip is a few MB, not about 50. The report is
  `site/report.json` in it: no export rewrites that entry, so you or an agent can grow it (its `AGENTS.md` says how),
  and the Report tab draws it as it changes. An earlier export's folder is no longer used, and the export says so.
- **The extension no longer freezes VS Code for seconds** when the Logs tab is open: an answer from the engine is
  read in time linear in its size. The Logs tab asks for its rows only when something new ran.
- **The Report's tiles run one at a time**, and leaving the Report stops the one running, so the Visual and the rest
  of the tab don't wait behind them.

## 0.2.17

- **A table with OneLake security reads.** When OneLake refuses you a table's files because roles restrict its rows
  or columns, it is read through OneLake's table read API: you get the rows and columns your roles allow, under the
  table's usual name, in joins and semantic models too. Each read uses the workspace's capacity, so the answer is kept
  on disk and read again only past `tableMetadataTtlHours` or after **Refresh**. A new setting,
  `onelakeStudio.securedTableRead` (on by default), turns this off. Stats and History still need the metadata OneLake
  refuses, and their 403 now says the table may have OneLake security.
- **Export to Fabric asks what the app runs on:** *Direct Lake*, *DirectQuery* or *Client side*, in a small window
  under the button, on Direct Lake unless you change it (on the command line, `export … --mode
  client|directquery|directlake`, Direct Lake without it).
  - **Client side** is the app as before: DuckDB in the browser. It makes no semantic model. The app reads the tables
    as its owner, so anyone who may open it reads them with the owner's rights.
  - **DirectQuery** and **Direct Lake** make a Power BI semantic model of the model, named as it is, in its workspace,
    and the app runs its queries there as DAX, as the person viewing it, the way Fabric Apps reads a semantic model.
    Each viewer needs Build on the model. A workspace's model of that name
    is updated, not duplicated. Direct Lake is refreshed after the write; DirectQuery reads the lakehouse's SQL
    endpoint, with each user's own identity.
  - The app on the SQL endpoint is gone, and DirectQuery takes its place.
- **Removed: the `onelakeStudio.sqlEngine` setting, and SQL endpoint mode with it.** The SQL box, Plan, Profile,
  Export, Explore, the Pivot, Open in Excel and the command line always run on DuckDB, in DuckDB's SQL. What an
  exported app runs on is picked in Export to Fabric.

## 0.2.16

- **New setting: `onelakeStudio.sqlEngine`.** With `sqlEndpoint`, the SQL box takes T-SQL and runs it on the Fabric
  SQL endpoint of the workspace it names, and a semantic model's queries (Explore, Pivot, Open in Excel, the command
  line) are compiled to T-SQL and run there too. Tables keep their names, `lakehouse.<workspace>.<item>.<schema>.<table>`.
  Plan, Profile and Export work as before. Offline, DuckDB runs everything, as by default. dax-sql 0.1.6.
- **Plan** has a **SQL** tab before Profile: the SQL the plan is of, as the engine gets it, with Copy. On the SQL endpoint it is the T-SQL with each table's three-part name, which the endpoint's own console runs as it is. In Explore's Show plan too.
- Settings have an **Engine** group again, first: Sql Engine, Engine Threads, Engine Spill Max GB and Log Max GB, out of Cache and Query and Results.
- A semantic model's **YAML** view shows in amber any expression in a dialect other than Ossie SQL, DAX for one,
  as it does the Power BI extension: what isn't plain Ossie SQL. The note above the file names them.
- **Export to Fabric in SQL endpoint mode** makes an app that runs no DuckDB: its function compiles Explore's
  queries over the model to T-SQL and runs them on the lakehouse's SQL endpoint, with the app's own identity, and the
  page only draws the rows. The site ships no DuckDB, and the workspace needs no SAS setting.
- **Fixed, SQL endpoint mode:** a table clicked in the tree puts `SELECT TOP 100 *` in the box, not `LIMIT 100`,
  which the endpoint doesn't support; and a file clicked, or a database file's table, is read by DuckDB as before, not sent
  to the endpoint. A statement goes to the endpoint when it names a lakehouse or warehouse table, or a semantic model.
- **Fixed, SQL endpoint mode:** Profile showed Rows scanned 0 and Planning 0.0 ms. The endpoint gives only an
  estimated plan, so neither was measured. Those tiles, and Execution, are no longer shown there.
- **Fixed: the Windows app's setup said "Unable to uninstall!"** when a version was already installed. Setup now
  installs over it, open or not, with no "Already Installed" page.
- **Fixed: Export to Fabric's app stopped at start** with "the engine is DuckDB v2.0.0-dev88614, but the site's
  extensions are for v2.0.0". DuckDB-WASM 1.33.1-dev110.0 was a dev build of DuckDB 2.0 that refuses its extensions;
  1.33.1-dev114.0, the same source, is v2.0.0 and loads them.
- **Fixes:**
  - `onelakeStudio.engineMemoryLimit` is a setting again. It was still used, but had dropped out of the Settings list.
  - The desktop app's Save and Folder dialogs gave back a wrong path when it had a letter like `é` in it.
  - Sorting a table's first rows in the grid no longer changes the order they come back in the next time they open.
  - Stats and History no longer show on top of an open chart.
  - Export works for a query that ends with `;` and then a `--` comment.
  - An app exported to Fabric again no longer keeps an old copy of the modules it loads later in the browser.
  - A value with a control character in it no longer breaks a PivotTable in Excel.
  - After a Refresh, a table whose metadata can't be read keeps showing what was read before, instead of an error.
  - A Direct Lake refresh that times out says so at once, instead of after a long wait.
  - Changing `cacheDirectory` moves your downloaded semantic models to the new folder, so Delete Old Cache no longer
    removes them, and files you open go to the new folder too.
  - A table dropped and created again with the same name shows its own Stats and History, not the old table's.
  - A semantic-model app (DirectQuery or Direct Lake) uses the model it was exported with, so a measure renamed later
    no longer breaks it until you export again. Its previews fetch only the rows they show, its row count is counted
    by the semantic model, and an answer cut short says so.
  - Publish Folder As Is is not offered when the folder was made for another engine than the one you picked (Client
    side or a semantic model): only Overwrite changes what the app runs on.
  - The desktop app shows a table's tooltip in the tree, and a tab's page can no longer reach the window's controls.
  - Show Rows after a chart goes back to the Pretty document when that was showing, and a model opened while the
    engine starts keeps its status line.
- The title shows only the first 4 letters of the tenant (`fabr…`), so a screenshot doesn't give it away.

## 0.2.15

- **Icons on a file, a folder and a semantic model in the tree**, shown on hover. A file: **Download File…** and
  **Copy SQL Name**. A semantic model: **Download File…** (its YAML), **Copy SQL Name** and **Download Again**.
- **New: Upload Files…** on a folder under a lakehouse's Files/, or on Files/ itself: pick files on this computer
  and they are written there. A file already there asks Replace or Skip. Big files go in pieces, and a cancel
  leaves the folder as it was.
- **Export to Fabric's app runs DuckDB 2.0**, the same version as the app itself (DuckDB-WASM 1.33.1-dev110.0).

## 0.2.14

- **A semantic model's YAML is plain Apache Ossie where it can be.** A measure that SQL can say the same way
  (`SUM`, `AVERAGE`, `COUNTROWS`, `DIVIDE`, ...) is written in SQL, the rest in DAX. When every table is in one
  lakehouse of the model's workspace, a table's source is `<lakehouse>.<schema>.<table>`, with no OneLake URL.
  The Power BI extension keeps only what Ossie has no field for and something needs, such as format strings and a
  relationship's filter direction, and the **YAML** view shows it in amber. A model opened before is rewritten when
  it is read again from Fabric. An Ossie model written by another tool, with its measures in SQL, opens too.
  dax-sql 0.1.5.
- A semantic model's **Model** tab has a **Diagram | YAML** switch (**Diagram | BIM** for a `.bim`): the model drawn, or
  its file, coloured. The model's bar no longer repeats the file's name, and its buttons are smaller.
- **Logs** shows a semantic model's query as written, and, when its row is opened, the SQL dax-sql compiled it to.
- **Fixes:**
  - Keep offline no longer fails a big table with *Unauthorized* when the sign-in renews during the read. A file
    opened before the renewal kept the old sign-in for an hour, so trying again was refused too. A failed table is
    now one short line on the model's bar, with the reason in its tip.

## 0.2.13

- **Fixes:**
  - A DAX query that reads one table only, such as `EVALUATE VALUES(dim[col])`, lists that table's values with no blank
    row, and no longer scans the facts to look for one. A query that also reads a measure or another table still has the
    blank row, as in DAX. dax-sql 0.1.4.

## 0.2.12

- **Fixes:**
  - The Windows app's installer closes the running app first, all of it, so an update no longer stops halfway on a file
    in use and leaves no app behind.

## 0.2.11

- **OneLake Studio is a Windows app too, with no VS Code.** The same tree, tabs, SQL, Explore and Pivot, in a window of its
  own, with a menu bar, About, a tree that can be put away (Ctrl+B), and the keys a Windows app has. It signs in with no
  app registration, and with VS Code on the machine it reads the same cache. It says when a newer version is out. Download
  it from the website.
- **Open in Excel:** a button on a semantic model's Pivot opens a new workbook with a PivotTable connected to the model,
  on Windows. It runs on the local engine, so it works offline.
- **Keep offline:** a switch beside a model's tabs keeps its tables on this machine, and new snapshots come down by
  themselves within the hour. It runs in an engine of its own and never stops for a query.
- **The command line works with VS Code closed**, on Windows, with `signin`, `signout`, and `serve <model.yaml|.bim>`
  for Excel on a model file.
- **The tables you use are looked after.** A table read 3 times in 14 days stays within an hour of OneLake, and when nothing
  else is running each new snapshot is read whole, so it works offline, every column. Anyone's statement stops that, and it
  carries on later from where it got to. `onelakeStudio.keepUsedTablesGB`, 10 GB by default, is how much may be kept this way,
  and a bigger table says so in its tooltip.
- **Fixes:**
  - A model joining a date to a timestamp no longer reads blank: the engine runs in UTC, as OneLake's timestamps are.
  - A statement after a Stop no longer hangs.

## 0.2.10

- **What is cached stays true.** A connection that drops during a listing no longer empties that listing. A Delta table
  dropped and made again can be read. A table cached as empty is looked at again rather than answering no rows for up to a
  day. The disk cache's limit is held while the engine runs, not only when it starts, and **Clear Cached OneLake Data** gives the
  space back.
- **Read only holds in more places.** Statements that got past the guard are refused, among them a second statement behind a
  Unicode space, `query()`, and functions that write from a `SELECT`. Nothing loads after the engine's lockdown.
- **The OneLake token goes only to OneLake.** An Azure URL naming any other host is refused, however the statement builds it.
- **Switching account is clean.** One account's listings can't land in another's cache, and Sign In closes what the last
  account had open. Logs and Performance close with it.
- **Offline doesn't wait.** A tab opens with no wait on the account provider, and a first click knows there is no internet.
  Export to Fabric says it needs a connection before asking anything.
- **Export to Fabric asks more before it overwrites:** another model's app, a file changed in OneLake since, or a publish that
  never finished. It refuses a table its lakehouse doesn't hold, and a failed re-export can't clear a live app's sign-in.
- **Fixes:**
  - A rename that changes only a saved query's case no longer deletes it.
  - History's **Query** button is back on an Iceberg table, with the snapshot's full id.
  - Two models whose names clean to the same text keep a local copy each. A model with `#`, `%` or `/` in its name is
    downloaded once more.
  - Delta History no longer counts rewritten rows as added.
  - Explore's date filters take in the whole last day on a timestamp column, and its CSV has no totals' marks.
  - A result landing leaves focus in the SQL box. Stop holds while a statement is being prepared, and a Plan can be stopped.
  - The SQL box reads comments, quotes and `$` as DuckDB does, and sends what you wrote unchanged.
  - Long integers keep their digits in the inspector and in a JSON document, and `NaN` shows as `NaN`.
- **Faster on large tenants.** Walking the catalog is one pass rather than a query per table, a first statement doesn't wait
  behind the catalog's listing, and a new window doesn't ask for a Delta table's log again if another just did.
- **A folder that is no table says so.** A folder under `Tables/` with neither a Delta log nor Iceberg metadata, such as
  files another tool left there, shows as *not a valid table* in the tree, `ls` and `find`, and `SHOW ALL TABLES` leaves it out.
  Reading it fails at once, with no wait for a conversion that would never come.
- **A Direct Lake model over a SQL endpoint opens.** Its tables are read from OneLake, from the item behind the endpoint, and
  nothing connects to the endpoint. If Fabric doesn't show an endpoint in the model's own workspace, they are read from the one
  item there holding them all, and a message says so. Otherwise it is refused.
- **A Delta table is read with `delta_scan`,** from its own log. Reading it through Fabric's Iceberg conversion could give one
  column another's values with no error, when a file's own column ids disagreed with the conversion's, as seen on a real table.
  Iceberg tables stay on `iceberg_scan`. Its log is kept in the cache folder and the parts of files it reads in the disk cache, so what
  was read works offline.
- **No package for Windows on ARM.** DuckDB has no build of `delta` for it, and most of what's in OneLake is Delta.
- **An engine that dies of a fatal error is replaced.** It used to stay up refusing every statement from every window.
- **A table that moved on still opens offline.** If its new snapshot was never read, a statement and the Data tab read the one
  that was, and say how old it is.
- **`exists` on the command line.** Whether a table is there, from the listings alone: yes, no with the closest names, or not
  cached, and never a false no. `table` gives the same no for a table its listing lacks.
- **`--fresh` goes through the sync worker,** ahead of what it has next, one request at a time. It fails at once while OneLake
  has asked for a pause.
- **`status` and `log` on the command line.** `status` says how a window is doing: its build, session, startup timeline, catalog,
  sync, and where its files are. `log` answers with its own log, whose lines now have the time. Both answer signed out too.
- **Only SQLite and one cache folder.** Metadata is in one SQLite file, and data is in one cache folder. The DuckDB state
  file, the old JSON files and the separate store of file bytes come across once and go. **Logs** moved to a small SQLite file
  of its own, and that is the whole reason a second DuckDB ran in the server, which no longer does.
- **The catalog keeps itself current.** What you have open and pinned workspaces refresh on their own, so a table added in
  Fabric appears with no click. Every 12 hours, the listings of the rest of the tenant are read too, a few at a time, so the
  tree, `find`, Go To and `SHOW ALL TABLES` know what you never opened. A table whose columns were never read is listed
  with none. A listing that can't be read says *refresh failed* beside the last good answer, and windows hear what another
  window read.
- **A file says whether it has been read here,** as a table does: a cloud until then, a green check after. A file rewritten
  in OneLake goes back to the cloud.
- **What is cached about OneLake is real tables, and is never evicted.** Workspaces, items, tables, columns, history,
  `Files/` listings, models, apps, Delta state and commits, and the models you opened are rows in the SQLite file, and nothing
  evicts them. A table's first rows have a fixed limit of 256 MB, so `metadataCacheMaxMB` is gone.
- **No Data tab where it could only fail.** Offline, a table with none of its rows read here opens on Stats and has no Data
  tab, and the status line says why. It comes back with the connection.
- **The tree opens at once.** It draws from what this machine holds before sign-in, with no server running and no DuckDB
  loaded, and the rest follows behind it. Listings, table metadata and first rows moved from the DuckDB state file to a
  SQLite file, and come across by themselves the first time. It needs VS Code 1.101 or later.
- **A tab says what it holds.** One opened on a table, file, semantic model or saved query is named after it, in place of
  OneLake Studio.
- **One click, everywhere.** An app in the tree opens on one click, like a table, a file, a query or a model. A double
  click anywhere counts as one, so it opens one tab and Run runs once. A grid cell stays as it was: one click selects it,
  and a double click or Enter shows it whole.
- **An update keeps Logs and what is remembered, with no gap.** The new version takes them over from the old one at once,
  rather than waiting for its last window to close, and only a file that isn't a database is ever thrown out.
- **Open OneLake Studio is off the explorer's "..." menu.** The explorer was already open, and **New Query** opens a tab.
  It stays in the Command Palette.
- **A DuckDB or SQLite file opens on what it holds:** a tree of its schemas, tables, views and columns beside the SQL box,
  with a filter and an overview of the file, and no rows read. Picking a table shows its columns, keys, indexes and
  definition, with Data and Pivot beside them. A file used to preview its first table, with the rest named nowhere.
- **A file has a name, as a table does:** `'lakehouse.aemo.data/Files/x.parquet'`, in place of its `abfss://` URL, which
  still reads. Wildcards go in the path. Opening a file puts it in the SQL box. **Copy SQL Name** and a drag from the tree
  work on a file or folder, `files` lists each one's name, and an error and **Logs** say it as it was written. A name that can't be found fails rather than
  answering no rows.
- **`sql --in` is gone.** `'Files/x.parquet'` read a different file depending on the lakehouse given, and rewrote any
  string that looked like one, even in a `WHERE`. Write the file's whole name.
- **A failed query's whole error is in the pane,** rather than one cut-off line in the status bar. A long-running query
  says how many rows have arrived. A table's first rows can be charted, profiled and exported.
- **The box keeps its undo** when something is put in it, and Esc then Tab leaves it by keyboard.
- **A Pivot by keyboard.** R, C, F or V on a field puts it on a shelf, Delete takes a chip off, and Alt+arrow moves it.
  Tables stay open as you left them, a newer view stops the older query, a failed view says why in the view, and a
  view too large to draw says so rather than hanging.
- **The grid by keyboard.** Enter sorts by a header, and an arrow key starts the selection. Screen readers hear the status
  line and how many rows there are.
- **Colours that follow the theme** for measures and popups, and readable text in Light and High Contrast.
- **A Fabric app reads only its model's tables.** Its function signed one read-only SAS over all of the lakehouse's
  `Tables/`. It now signs one per table the model names, and refuses any other. Export again to get this.
- **`h3` and `zipfs` ship in the vsix,** so a zip file reads offline from the first start and nothing is downloaded at
  run time.
- **Queries, Logs and Performance stay in the tree** when a listing fails or finds no workspaces, so a saved query can
  always be reached.
- **An answer says how old its tables are.** A table's metadata is kept for a day by default, so a query could read
  yesterday's snapshot with no sign of it. Past an hour the status line says so, and `sql` gives `cachedAt`, a note, and
  `--fresh` to read them from OneLake first.
- **Clear Cached OneLake Data reaches every window,** rather than leaving other windows showing what it cleared.
- **A stalled account provider no longer holds up VS Code's commands for OneLake Studio.** It gets five seconds at
  startup, and what it says later still counts.
- **Read only holds against more ways of writing SQL.** Nested comments, `E'…'` strings, a `$` inside a name, a
  `$` tag that isn't ASCII and a carriage return after `--` could each hide a second statement or a `COPY` from the
  check. All are refused now.
- **A result past `maxResultRows` says so.** It used to report the rows it kept as if they were all of them. The
  status line now gives both counts.
- **Export to Fabric asks everything first, and can't leave a model half written.** Not being able to read what is
  already at the model's path stops the export, rather than overwriting it unasked. The question about an app of the
  same name now comes before anything is written, and the model's file is written beside it and renamed into place. A
  first export that fails part way is still known as its own next time.
- **An update keeps what this machine has cached.** Listings, table metadata, first rows and Logs used to start again
  with each new version, so nothing was there to read offline. A state file that can't be opened is set aside and
  started again, and the reason a server stopped goes in its log.
- **A model's local copy is per account.** `~/OneLakeStudio/semantic-models/<account>/<workspace>/<model>.yaml`:
  two tenants can each have the same workspace and model name, and could read each other's definition. Copies you
  opened move there by themselves.
- **Stop works while a table is being opened.** It answers at once and the statement never runs. It used to reach
  nothing until the statement had started.
- **Fewer false sign-outs.** The account provider failing, or the internet going without anything noticing, no longer
  closes the tabs and says you are signed out. A token that arrives after a sign-out isn't kept.
- **Filter the tree by type.** The filter button on the explorer shows one type, such as semantic models, and only
  the workspaces that hold it. It replaces Group by Type: the tree always lists by workspace.
- **A table that doesn't exist fails in seconds.** It used to wait about two minutes as if Fabric were converting it,
  then suggest writing to it. The error now says there is no such table and names the closest ones. A table
  still waiting for its conversion still waits.
- **The SQL box and the command line take reads only.** `DROP`, `DETACH`, `CREATE VIEW`, `CREATE SCHEMA`, `ATTACH` and
  `PRAGMA` are refused at once, so nothing typed can reach another tab. `pragma_*` functions still read. DuckDB's own
  parser now checks every statement too. What a tab opens from `Files/` goes when the tab closes.
- **`find --fresh`** reads every listing, then searches. `find` also says when it searched a table by name only.
- **The command line's answers fit an agent better.** `SHOW ALL TABLES` in Markdown gives a column count rather than
  every column. `sql` marks `NULL` in Markdown, and `--csv` writes an empty string as `""`. `models --downloaded` lists
  only what is on this machine, and `models` and `items` have a `staging` column. A query the shell split says so.
- **Double-click an app in the tree** to open it in the browser.
- **It works offline.** With no internet, or nobody signed in, OneLake Studio notices and works from what
  this machine has cached: the tree, the catalog, stats, first rows, semantic models, and the rows it has
  read. A query or a model's Pivot runs from what was read, and a column or a file never read says so at
  once. Export to Fabric needs OneLake. The status bar shows when this is happening, and it comes back by
  itself.
- **The SQL box runs the statement under the cursor, or the selection.** Ctrl+Enter runs it, Ctrl+S keeps it
  under Queries as "Query N", and the cursor goes to where DuckDB says an error is. The text last written comes
  back in the next window. Edit SQL is only where the box is hidden: a semantic model's view and a table's
  Pivot. A table or file you click puts its SQL in its tab's box, not run.
- **DuckDB runs in a process of its own, shared by every tab and window.** One memory budget and one cache of what
  was read, and it outlives a window reload. What the tree opens gets a new tab, each running its own query with its own
  Stop. Listings, table metadata and first rows move to a DuckDB file, imported once from the JSON files.
- **Logs and Performance, as nodes in the tree.** Logs is what the engine ran, from DuckDB's own log, kept up to
  `logMaxGB`, and a row reopens its SQL in a new tab. It holds your SQL in plain text. Performance is live charts of
  memory, cores, queries per second and the disk cache. Nothing of it is stored.
- **Logs left Explore and the Fabric app.** A published app has no built-in diagnostics page now.
- **A first `SHOW ALL TABLES` answers at once.** The catalog's list is kept and checked behind you, so it no
  longer walks every table first. On a machine that scans what it opens, that took 35 seconds.
- **The title says where you are.** The sidebar's header and each tab's title read OneLake Studio and then
  `offline` or the tenant in use.
- **Sign Out stays signed out.** The next VS Code start asks for no session and sends nothing to OneLake,
  until you sign in again.
- **A model has one name in SQL.** `FROM nem` no longer reaches an open model: only
  `semanticmodel.<workspace>.<model>` does. A shorter name is an error from DuckDB.
- **A table shows whether it is cached.** As a semantic model does: a cloud until its rows have been read on
  this machine, a check after. The Delta and Iceberg icons are gone; Stats still says which format it is.
- **Sign Out.** In the explorer's "..." menu. It signs out of OneLake Studio; VS Code's Accounts menu still
  removes the account itself. Signed out, the last account's cached data stays on show on this machine, until
  another account signs in or Clear Cached OneLake Data deletes it.
- **A cached answer that turns out wrong now corrects itself.** A lakehouse made a minute ago no longer
  gives "there is no lakehouse", a renamed one keeps working under its model, and a table whose metadata
  has moved is read again rather than failing. Nothing extra is read unless something fails.
- **A first query answers much sooner.**
  - A statement that names no semantic model no longer waits for its tab to load your models.
  - The name behind a Direct Lake model's GUIDs is kept on disk, so opening a tab no longer waits
    on the Fabric API each session.
  - The engine starts in the background once the OneLake view is visible, and its boot no longer
    waits to check the disk cache's size.
  - The catalog is listed in one call.
  - The Read Log shows the boot's stages in more detail, and how long the catalog and semantic models
    took.
- **Settings are one click away.** The explorer's "..." menu has Settings, next to Switch Microsoft
  Account, and Clear Cached OneLake Data. Settings are grouped into Cache, Engine, Query and Results,
  and Sign-in.
- **New settings:** `cacheDirectory`, `metadataCacheMaxMB`, `engineThreads`, `engineSpillMaxGB`, `logMaxGB`,
  `selectTopRows`, `maxResultRows`, `tableOpensOn` and `gridThousandsSeparator`.
- **`Files/` objects DuckDB reads are kept in the disk cache.** A Parquet or CSV under `Files/` is no
  longer downloaded again on every query. A kept copy is checked against OneLake first, so a rewritten
  file is read again.
- **`diskCacheMaxGB: 0` turns the disk cache off.** It used to mean no limit.
- **`catalogTtlMinutes` and `tableMetadataTtlHours` apply at once**, with no window reload.

- **Every OneLake table is read by its five-part name.** The Data tab's rows now are too. A model
  table with no Direct Lake source, in a `.bim` or `.yaml` opened from `Files/`, gives an error when
  a query reads it; it used to read whatever carried its short name, such as an open `Files/` view.
- **The command line is built for an agent to act on.**
  - **Exit codes say what happened:** 0 answered, 1 failed, 2 wrong call, 3 VS Code not open or not
    signed in, 4 not cached, 5 you declined an export, 6 timed out.
  - **New options:** `--json`, `sql -` for SQL from stdin with no shell quoting to get wrong,
    `--timeout`, `--version` and `<command> --help`. A query stops when its command is killed.
  - **Fixed:** `models <typo>` and `items <typo>` answered "none" and exit 0; a cancelled export
    exited 0; `--csv` left rows out past 200,000 with no word, now fails; `--show-sql` broke a `--csv`.
  - **Changed:** `--csv` holds raw values under plain column names, and always a header. An unknown
    option, a bad `--limit` or an option a command does not take is refused rather than ignored.
- **A semantic model's local copy is an Apache Ossie file.** Clicking a model keeps
  `~/OneLakeStudio/semantic-models/<workspace>/<model>.yaml` in place of the `.bim`, and Export to
  Fabric writes that `.yaml` into its lakehouse. A model downloaded before this downloads again on
  its next click; its old `.bim` is left where it is.
- **Export to Fabric reads an Ossie model as it reads a `.bim`.** A table with no schema is in
  `dbo`, and a table with no source of its own (a calculation group, a calculated table) is a
  warning, not a refusal.
- **Export to Fabric's app:** a query's tables download together, and outside the engine queue;
  each tab has one store writer, handed its downloads without a copy (the DuckDB workers only
  read); the function's answer and the table snapshots live in IndexedDB, not localStorage; and
  the manifest cache keeps only what the tables read now.
- **Go to a Table, Column or Measure** (Ctrl+Alt+O, or the search icon on the tree): every table,
  column, semantic model and measure the cache holds, in one search. A pick opens the table or the
  model; its button puts the SQL name in the SQL box (or copies it).
- **The results grid scrolls every row a result holds**, not the first 2,000, with row numbers.
  Click a cell, Shift+click or Shift+arrows for a range, a row number for its row; Ctrl+A, and
  Ctrl+C copies as tab-separated text (Ctrl+Shift+C with headers). Right-click: Copy, Copy with
  Headers, Copy as CSV, Markdown or JSON. A double click (or Enter) shows a cell whole, JSON
  indented. The filter box keeps the rows that hold its text.
- **Time travel on an Iceberg table:** History's Query puts a snapshot's rows in the SQL box
  (`iceberg_scan(…, snapshot_from_id = …)`), and each snapshot says how its row count and its
  columns differ from the table now.
- **Query variables:** `SET VARIABLE year = 2024` run from the SQL box keeps a value in that tab,
  and `getvariable('year')` in a query reads it; one never set is asked for the first time.
  **Clear Query Variables** forgets them.
- **Chart** on a result: the rows on screen as a bar, line or scatter chart, one column across
  and a number (or every number) up; nothing is queried again.
- **Profile** on a result: each column of the result, over every row the query returns: its
  type, min and max, distinct values, average, spread, quartiles, count and nulls.
- **Export…** (was Save CSV) writes every row the query returns, not only the rows on screen, to
  a CSV, Parquet or Excel file. The engine writes it; SQL typed by hand still cannot `COPY`. The
  grid's right-click also opens the selection (or every row) as an untitled CSV or JSON document.
- **SQL from the tree.** A table's right-click: Select Top Rows (a query in the SQL box, run),
  Copy SQL Name, Copy Column List. A table or a semantic model dragged into an editor drops its
  SQL name.
- **The command line's `dax` command is gone.** OneLake Studio takes SQL only: a semantic model is
  queried with `AGG("measure")` in `sql`.

## 0.2.9

- **Clicking a semantic model writes nothing to OneLake.** Its definition is kept on this machine,
  `~/OneLakeStudio/semantic-models/<workspace>/<model>.bim`, and opened from there, so a user who
  can only read the workspace can open and query it. Export to Fabric writes the `.bim` into its
  lakehouse, after you approve the export.
- **A semantic model is `semanticmodel.<workspace>.<model>` in SQL.** A query that names one not
  opened yet opens it first.
- **`CREATE` and `DROP SEMANTIC VIEW` are gone.** A model is there because Fabric has it, or a
  lakehouse's `Files/` holds it; open one in the tree, or name it in a query. `SHOW SEMANTIC VIEWS`,
  `SHOW SEMANTIC METRICS` / `DIMENSIONS` and `DESCRIBE` still work. `SHOW SEMANTIC VIEWS` lists
  every model the cache knows; one not opened yet has no file and no tables yet.
- **`SHOW ALL TABLES` and `SHOW SCHEMAS` list everything the cache knows**, tables and semantic
  models, with no request to OneLake. Each schema is named by its whole path (`ws.lh.dbo`), so two
  workspaces' `dbo.t` are two rows. `SHOW TABLES FROM lakehouse.ws.lh.dbo` works.
- **New Query.** The **+** on **Queries** opens a new query that starts with `SHOW ALL TABLES`,
  not yet run. It lists only the tables cached on this machine; expand a lakehouse in the tree to
  add its tables. Show Queries Folder moved to the node's right-click menu.
- **A newer query keeps the results pane.** A slow query that finishes after a newer one no longer
  replaces its results. Opening a saved query clears the last table's Stats, History and Pivot.
- **Fixes:**
  - Save Query on a semantic model saves the query as it stands.
  - Sorting the grid no longer reorders a document's Pretty view.
  - The Data tab puts a query's results back instead of replacing them.
  - CSV quotes a cell with a carriage return.
  - Plan no longer runs the query again on every click.
  - A date-like filter on a text column compares text.
  - Signed out of Fabric, expanding both Semantic models and Apps no longer fails.
  - "Signed out" shows only to someone who was signed in.
  - A new account or tenant lists Fabric workspaces again.
  - Publishing a folder "as is" lists each redirect once in `rayfin.yml`.
  - A SQLite file in `Files/` is downloaded once per session, and Save downloads only after the dialog.
  - A `DROP` no longer leaves a table unreadable until reload.

## 0.2.8

- **Every table has one SQL name: `lakehouse.workspace.item.schema.table`.** For example
  `lakehouse.aemo.data.dbo.dim_duid`; the first part is `lakehouse`, `warehouse`, `sqldatabase`
  or `mirroreddatabase`, and a lakehouse without schemas is `dbo`. A query names tables that
  way and runs as written, whatever is open: joins across items and workspaces need no setup.
  The panel, Explore, a model's compiled SQL and the command line all use it. Copy SQL Name on
  a table gives it.
- **Saved queries.** Save Query in the SQL box keeps it, with no name to type, under **Queries**
  at the bottom of the tree: one folder per signed-in account,
  `~/OneLakeStudio/queries/<account>/`. A click opens one; Rename and Delete are on its menu.
- **Plan in place of Preview.** The query's profile (where the time goes) and DuckDB's plan
  tree. Rows returned and planning time are now right there and in Explore's Show plan.
- **Semantic models are named `workspace.model`**, so two workspaces' models of one name are
  two views. The bare name works while only one model has it. dax-sql 0.1.2.
- **Direct Lake models over several lakehouses open from the tree**, each table read from its own
  lakehouse.
- **An Import, DirectQuery or composite model gives a note, not an error** (#3), and the tree
  marks it.

## 0.2.7

- **Export to Fabric's app carries its own packages.** DuckDB-WASM 1.5.6 with its parquet and
  icu extensions, Apache Arrow, the Rayfin SDK and ECharts ship with the site, in the local copy's
  `site/vendor/` (about 48 MB). The app loads nothing from jsDelivr or DuckDB's extension
  repository. The export's output log lists what `site/vendor/` weighs, package by package.
- **SQL over a semantic model takes `ORDER BY ALL` and constants.** `ORDER BY ALL` orders by
  every column, left to right. A constant in the SELECT, such as `'orders' AS what`, is a column
  of every row, so each arm of a `UNION` can label its rows. The compiler is now dax-sql 0.1.1,
  from npm.

## 0.2.6

- **Export to Fabric from the command line.** Run `export <ws> <model>`, or
  `export <ws> <item> <Files/path>` for a model file. It uses the same export as Explore's
  button, and VS Code asks where the local copy goes and waits for your OK before publishing.
- **Generate Report is gone. Use Export to Fabric instead.** It did the same thing, but from an
  older copy of the app that ran a DuckDB-WASM 2.0 build taken from CI, with unsigned extensions.
  Export to Fabric publishes the model's Explore on DuckDB-WASM 1.5.6 from npm.
- **Mirrored databases show up.** OneLake names them `.MountedRelationalDatabase`, which the tree
  didn't list. They now appear as *Mirrored database*, with a mirror icon.
- **The disk cache keeps 64 GB by default, up from 10.** `onelakeStudio.diskCacheMaxGB` still sets it.
- **Delta and Iceberg tables have their own icons.** The icon says which format the table was
  written in. Every table is still read through its Iceberg metadata.
- **New: a History tab** beside Stats and Data.
  - **A Delta table** lists its commits from `_delta_log`, newest first, 10 at a time: version,
    time, operation, rows and files added or removed, engine, user and parameters. Nothing is read
    until the tab is opened, and each commit file is read only once.
  - **An Iceberg table** lists its snapshots, which are already in its metadata.
- **A Delta table's Stats come from its Delta log.** They show reader and writer versions,
  features, table properties (V-Order among them), partitioning and creation time. They are taken
  from the converted version's `.crc` file, which is one request and then kept. A writer that leaves
  no `.crc`, such as a Warehouse, has its last checkpoint read instead.
- **A table with no Iceberg metadata says why.** The error quotes Fabric's conversion log, for
  example a type it can't convert or too many commits. If there is no conversion log, the error
  says Fabric never converted the table.
- **A 403 names the tenant setting to check.** That setting is *Users can access data stored in
  OneLake with apps external to Fabric*, which a Fabric admin can turn off for every app at once.

## 0.2.5

- **Explore is analytics-as-code's, and lives here now.** A semantic model opens on three
  pages: Model, Pivot and Logs.
  - **The Pivot asks SQL over the model** (`SELECT … FROM <model>`).
  - **Show SQL** turns the pivot into that SQL, which you can edit and run.
  - **Show plan** profiles the query (DuckDB's `EXPLAIN ANALYZE`: totals, a timeline, the costly
    operators) and shows its plan.
  - **Logs** lists the session's queries with timings.
  - **The SQL page is gone:** the Pivot's Show SQL does its job.
  - **Values can no longer be summarised by median**, which SQL over the model doesn't have.
- **New: Export to Fabric.** A button on the Pivot publishes that Explore (and Logs) as a Fabric app
  named `<model>-explore`, and writes a local copy of it to `<open folder>/<model>-explore/` (or the folder
  approved last time), after you approve where.
  - **It asks before overwriting** local edits to that copy (overwrite, or publish the folder as it
    is), or an app deployed again from somewhere else since.
  - **It deploys directly** over the Fabric REST API: no CLI, no Node, no GitHub access.
  - **The site is protected**: only people who may open the app item can load it. It's black.
  - **The model is never copied:** the app reads it from the lakehouse, in place, every time.
  - **It never replaces an app it didn't create** without asking.
  - **It is the one write** the extension makes to Fabric, and it happens only when you click.
- **A semantic model opened from the tree goes into its lakehouse.** Its `.bim` is written to
  `<lakehouse>/Files/semantic_model/<model>.bim` and opened from there, so Export to Fabric works on
  it. Only Direct Lake models on one lakehouse are opened; any other is refused, with nothing
  written. *Download Again* overwrites it, after asking. The `onelakeStudio.semanticModelsFolder`
  setting is gone.
- **New: Apps in the explorer.** Each workspace has an *Apps* node listing its Fabric apps, however
  they were made, each with its URL and last deploy, and a button to copy the URL. An app whose site
  is public (anyone with the URL can load it, no sign-in) has an orange open lock; a protected one, a lock.
- **The app's template now lives in this repo** (`fabric_app/`), and analytics-as-code takes it
  from here. The function ships prebuilt in the vsix.
- **New: Generate Report.** Right-click an Apache Ossie model (`.yaml`) in `Files/` and choose
  *Generate Report…*. It writes a folder to this machine with a Fabric app (Rayfin, DuckDB-WASM in
  the browser) that reads the model's lakehouse through its OneLake Iceberg catalog. The page has
  one chart, and an `AGENTS.md` explains how an agent can grow it from there.
  - The template is analytics-as-code's Iceberg app, vendored at a pinned commit.
  - Nothing is deployed for you.

## 0.2.4

The first release notes for OneLake Studio. They cover every change since 0.1.0.

### Power BI semantic models

- **Semantic models in the explorer.** Each workspace has a *Semantic models* node, listed from the
  Fabric REST API. Listing them needs its own sign-in, which is asked for only when you click
  *Sign in to list semantic models*, never at startup.
- **One click opens a model.** The first click downloads its `.bim` to this machine, and every
  later click opens that file at once. The tree marks a downloaded model with a check, and
  *Download Again* fetches the current definition. The folder is set by
  `onelakeStudio.semanticModelsFolder`.
- **The model view has three pages:**
  - **Model:** the tables drawn as a star, with their relationships, columns and measures (with
    their DAX).
  - **SQL:** queries that ask the model with `AGG(measure)`. The DAX is compiled to SQL by
    [dax-sql](https://github.com/djouallah/dax-sql) and runs on DuckDB.
  - **Explore:** pivot tables and charts. Drag columns onto Rows, Columns and Filters, and
    measures onto Values. Measures are shown in amber. A column dropped on Values is summarised:
    numbers are summed by default, anything else is counted. Totals start off.
- **A `.bim` in a lakehouse's `Files/`** opens as its model too.
- **New: Apache Ossie models.** An [Apache Ossie](https://github.com/apache/ossie) `.yaml` or
  `.yml` model whose metrics are DAX opens just like a `.bim`. A file counts as an Ossie model when
  its top level has `version:` and `datasets:`. Any other YAML still opens as a document.
- **Semantic views.** `CREATE`, `DROP` and `SHOW SEMANTIC VIEW`, `SHOW SEMANTIC METRICS` and
  `SHOW SEMANTIC DIMENSIONS`, and `DESCRIBE`, from the SQL editor. A view can point at a `.bim` or
  an Ossie `.yaml`. Views are kept per account and survive a restart.
- **Direct Lake tables** are read from the lakehouse the model names, and only when a query needs
  them.

### Ask Claude Code or GitHub Copilot about your data

- **OneLake Studio: Install Agent Skill** writes a skill that Claude Code and GitHub Copilot (agent
  mode) both pick up. Either can then list your workspaces, lakehouses and models, read measures
  and their DAX, and compute measures by any column. It runs on the same sign-in, cache, DuckDB
  and DAX compiler as the panel, and it is read only.
- **The skill runs a read-only command line** (`cli.mjs`). It passes each request to the extension
  running in VS Code, so there is no second sign-in or cache. Commands: `ls`, `items`, `models`,
  `files`, `find`, `table`, `model`, `sql` and `dax`, plus `--show-sql` to print the compiled SQL.
- **Listings and metadata come from the cache only.** The command line never signs in or lists a
  workspace behind your back. `--fresh` is the one way to make it ask OneLake or Fabric.

### Explorer

- **The OneLake tree** of workspaces, lakehouses, warehouses, tables and `Files/` sits in the
  sidebar.
- **Group by Type** puts one heading per type at the top level (Lakehouses, Warehouses, SQL
  databases…, Semantic models), across every workspace. The choice is remembered.
- **Pin workspaces** to Favorites. Pinned workspaces are listed apart from the rest.
- New commands: **Sign in to OneLake**, **Refresh**, **Show Read Log** and **Clear Cached OneLake
  Data**.

### Engine

- **Native DuckDB 2.0** runs in the extension host, replacing the WebAssembly build. Each query
  runs on its own connection, so Stop interrupts only that query. A result past 200,000 rows is
  counted rather than carried into the panel.
- **The panel loads nothing from the network.** Its libraries ship inside the extension, and it
  holds no token.
- **Read only by design.** This is enforced in the extension host, and nothing is ever written to
  Fabric or OneLake. DuckDB is kept off the local disk outside its own temp directory.
- **SQLite files** in `Files/` open in the host.
- `onelakeStudio.engineMemoryLimit` caps DuckDB's memory. By default it may use a quarter of the
  machine's RAM.

### Cache

- **Cache first:** workspaces, items, tables, `Files/` listings, semantic model lists, each
  table's metadata and its first 100 rows are kept on disk per account. They are served at once
  and refreshed behind you. Set how often with `onelakeStudio.catalogTtlMinutes` and
  `onelakeStudio.tableMetadataTtlHours`.
- **A table you have opened before** opens without a single request, even after a restart. First
  rows are kept per snapshot, so they are never stale. **Refresh** re-reads a lakehouse at once.
- **Table data is kept on disk** by `cache_httpfs`, so a table read once is read from this machine
  afterwards. The limit is set by `onelakeStudio.diskCacheMaxGB`, 10 GB by default.
- **`Files/` objects** are kept under their etag, and each item's Iceberg catalog prefix is kept
  too.
- `onelakeStudio.prefetchMetadata` reads every table's metadata in the background once a
  lakehouse's Tables node is opened.

### Platforms

- There is one package per platform: Windows, macOS and Linux, each on x64 and arm64. Desktop
  VS Code only, because the engine is a native library and does not run on vscode.dev.

### Fixes

- Tables whose path has spaces now open.
- A semantic model opened from the tree no longer waits for DuckDB to start.
- In Explore, a search that hides a whole table no longer prints "null" in the field list.
