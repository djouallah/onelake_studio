# The OneLake catalog: specification

**Status: built in waves (below). Waves 1 to 5 are in the code.** Where it differs from
[ARCHITECTURE.md](ARCHITECTURE.md), this describes what is planned and that describes what runs today.
[NAMING.md](NAMING.md) does not change.

## The idea

**Metadata lives in a local SQLite file, and data lives in OneLake with a cache on this machine.** Three
parts have one job each:

| Part | Its job | Runs in | Touches the network |
| --- | --- | --- | --- |
| **The catalog** | Knows what exists: workspaces, items, tables, columns, files | A SQLite file | Never |
| **The sync worker** | Keeps the catalog up to date, in the background, and decides what else is worth reading | The window's extension host | Yes: listings and metadata from OneLake and Fabric |
| **The engine** | Runs SQL and reads the bytes | DuckDB, in the server | Yes: reads data, with a disk cache |

Anything that wants metadata reads the catalog. Nothing waits on OneLake to answer a question the catalog
can answer.

```
 Tree        Tabs        Command line
    \          |          /
     \         |         /
   +-----------------------------+          OneLake,
   |  Window                     | ------>  Fabric REST API
   |  sign-in, read-only guard,  |          (listings, metadata)
   |  names, sync worker         |
   +-----------------------------+
      |                  |
      | reads, writes    | statements, token
      v                  v
 +-----------+      +-----------------------+
 |  Catalog  |      |  Server               | ------>  OneLake
 |  SQLite   |      |  engine: DuckDB and   |          (rows, files)
 +-----------+      |  disk cache           |
                    +-----------------------+
```

## What must always hold

1. **Works offline.** Everything already read keeps working with no internet and no sign-in.
2. **All metadata is in one local SQLite file**, read and written with Node's built-in `node:sqlite`.
3. **Updates are asynchronous.** A background worker keeps the lists current, and a reader never waits for
   it unless it asked for something the catalog has never held.
4. **The tree opens at once:** before sign-in, with no server running, and with no DuckDB loaded.
5. **Nothing bypasses the catalog,** the command line included.

## The catalog

**One file per account:** `engine-server\catalog-<id>.sqlite` in the extension's storage. An update keeps it,
and F5 has its own.

| Table | Holds |
| --- | --- |
| `workspace` | id, name |
| `item` | id, workspace, name, kind, catalog prefix |
| `lake_table` | item, schema, name, format, metadata location, version or snapshot, row count, bytes, file count |
| `lake_column` | table, position, name, type, whether it partitions |
| `snapshot` | table, version or snapshot id, time, operation, row and column changes, for History |
| `data_file` | table, `abfss_path`, role, bytes, rows, begin and end version |
| `lake_object` | a `Files/` entry: item, path, whether it is a folder, bytes, etag, last modified |
| `semantic_model`, `app` | A workspace's listings from Fabric |
| `semantic_view` | The models opened here: name, workspace, its file's path, when |
| `delta_commit`, `delta_state`, `delta_property` | A Delta table's commits, and its state and properties as of a version |
| `item_name`, `catalog_prefix` | The names behind a Direct Lake model's GUIDs, and an item's prefix in OneLake's catalog |
| `rows_read`, `file_read` | That a table's snapshot or a file's version was read here |
| `first_rows` | A table's first rows, per snapshot, so its Data tab opens at once. The one thing with a limit: 256 MB, oldest first |
| `table_use` | How many statements read a table, per day: its name and a count, never the statement. Gone after 14 days |
| `table_kept` | Reading a table whole, per snapshot: when, how big, how long, why it failed and when to try again. Gone after 14 days |
| `sync_state` | what was synced, when, its last error, when it is next due |

Every row says when it was last read from OneLake.

- **Who writes and reads:** each window opens the file itself, in WAL mode, with short transactions, so a reader is
  not held up. Every window hears what another wrote from the file, within a few seconds. A walk over every table is one
  pass over `lake_table` and `lake_column` (`allTables`), not a query per table.
- **A tab's SQL can't reach it:** the file is outside the folders DuckDB may open.
- **Rows are never evicted by age or size.** Offline depends on them.
- **A table missing from a complete listing is marked dropped,** and removed when a later sync confirms it.
- **It can be rebuilt.** A file that can't be opened, or has an older schema (`user_version`), is set aside and
  refilled by the worker. Offline with no usable file, the tree says nothing is known.
- **Clear Cached OneLake Data** deletes it. **Sign Out** keeps it, and another account has its own.

**What stays outside it:**

| What | Where | Why |
| --- | --- | --- |
| Iceberg's `metadata.json`, manifest lists and manifests | The disk cache | `iceberg_scan` reads them as files. The catalog holds the facts from them. |
| A model's `.yaml` | The cache folder, under `models\` | A file: data, with its path in the catalog. |
| Saved queries | `~/OneLakeStudio/queries/` | Not metadata. |
| The log | `logs-<id>.sqlite`, a file of its own | Not metadata. |
| Bytes of a `Files/` object the host reads | The cache folder, under `host\` | Data. |
| A Delta table's log and deletion vectors | The cache folder, under `delta\` | `delta_scan` reads them as files. |

## The sync worker

**It runs in a window's extension host, not the server** ([`src/syncworker.js`](../src/syncworker.js)). That is where
VS Code's sign-in, proxy and certificates already are, so no token or network path has to move, and syncing needs no
DuckDB and no server. A lease in the catalog file says which window sweeps the tenant, and another takes over within
90 seconds when that one goes.

| Who | What | How often |
| --- | --- | --- |
| Whoever is waiting | A listing the catalog has never held, or a Refresh | Now, by the reader itself |
| Each window | What it has opened, and pinned workspaces | `catalogTtlMinutes` |
| The window with the lease | The rest of the tenant: workspaces, items and table lists, and models if a Fabric token is already there. Workspaces in use go first | Every 12 hours |
| The window with the lease | The metadata of the 20 tables most in use | Every hour |
| The window with the lease | One table in use, read whole, through the engine (see [Tables in use](#tables-in-use)) | When nobody is running anything |

- **Table metadata is read only for lakehouses opened,** as `prefetchMetadata` does, **and for tables in use,** so the
  tenant's manifests are not walked. A staging item is never swept.
- **Limits:** one request at a time and five listings every 15 seconds, so a large tenant fills in over minutes. A 429, a
  503 or no answer at all stops everything for a minute, and a listing that fails isn't asked again for an hour.
- **Every window hears** what another wrote: a look at the file every few seconds (`PRAGMA data_version`), and the tree
  redraws what changed.
- **Offline:** it asks nothing, and carries on by itself. Nothing waits on a timeout.
- **A failure** is kept in `sync_state` and shown on its node as *refresh failed*. The last good rows are still served.

## Tables in use

**A table is in use when statements read it 3 times in 14 days.** Every statement that reads its rows counts, from a tab
or the command line, and a model's query counts for the tables it reads. `DESCRIBE` and a plain `EXPLAIN` read none.

**What such a table is short of isn't its repeat:** a repeat already reads from disk. It is short of a current snapshot,
and of the parts of it nothing has read. So the worker does two things for it:

1. **Its metadata is read every hour**, so a statement never waits for that and isn't answered from a snapshot a day old.
2. **It is read whole**, once at each snapshot, so every column works offline. The worker decides and DuckDB reads:
   `EXPLAIN ANALYZE SELECT <column> FROM <table>`, a column at a time, goes through the disk cache as any statement does, and
   no row reaches a client. Each is a line in **Logs**, under a comment that says why. When it finishes, the table's icon goes
   to a check.

**It is the last thing to run:**

- **One at a time,** by the window with the lease, on an engine already up. It never starts one.
- **Only once nobody has run anything for 2 minutes,** on any window or the command line. The server says so over the
  control pipe, so asking leaves no line in Logs.
- **Anyone's statement stops it, within 3 seconds.** What it read stays on disk, so the next try carries on from there.
  It tries again after 2 more quiet minutes.
- **After 10 minutes it stops, and waits 6 hours,** so a slow connection isn't kept busy. A read that fails waits as long.

**What it may bring down**, under `onelakeStudio.keepUsedTablesGB`, 10 GB by default, and never over half of
`diskCacheMaxGB`. The disk cache evicts the oldest first, and what someone read comes before this.

| Limit | Why |
| --- | --- |
| The tables in use, most read first, fit in it together | One big table can't push out the rest |
| What comes down in 24 hours fits in it too | A table rewritten daily comes down whole each day. An append counts for what it grew by |
| A table of no known size isn't read | Never guess |
| Nor is one of more than 2,000 files | Each open asks OneLake for the file's version |

A table over the limit says so in its tooltip. `0` turns the reading off, and the hourly metadata stays on.

**The costs of this:**

- **A table in use is read whole once,** at its current snapshot, even if what you read of it was already held.
- **It runs on the engine's own threads and memory,** and DuckDB's are shared, so it can be heard on a laptop until someone
  runs something.
- **"Read whole" is what happened, not what is still there.** The cache's blocks are opaque, so eviction can take them
  afterwards with nothing to say so.

## Opening

1. **The window opens the catalog with `node:sqlite`.** It knows the last account from VS Code's state.
2. **The tree draws** from its rows, with no network and no prompt.
3. **Then, behind it:** silent sign-in, start or join the server, and the worker takes its queue.
4. **DuckDB's native library loads only when something needs it.** Nothing on the path to the tree may import
   `@duckdb/node-api`.

**On a first run** there is no catalog, so the tree shows sign-in or a loading node, then fills in.

**What still waits:** a statement waits for the server, and something never synced waits for its one job.
Neither holds up the tree.

## How a statement runs

As [ARCHITECTURE.md](ARCHITECTURE.md#what-happens-when-a-statement-runs) describes, with one change: `resolve`
and `resolveFile` query the catalog, in the window. The view is `delta_scan` on a Delta table's kept log, or
`iceberg_scan` on an Iceberg table's metadata location. `SHOW ALL TABLES` and `information_schema` are answered from the catalog.

A name not in a kept listing asks the worker for that listing before it is called missing. So does a read that
fails with an `IO Error`, for that table's listing and metadata.

## The command line

**Without `--fresh`, `src/agent.js` makes no OneLake or Fabric call.** `ls`, `items`, `models`, `files`, `find`,
`table` and `exists` read the catalog with the same code as the tree. `status` and `log` ask nothing either.

**Does a table exist (`exists`):** from the listings alone, so it needs no table's metadata, though what is held about one
counts.

| The catalog holds | The answer | Exit |
| --- | --- | --- |
| The table | Yes, and how old that is | 0 |
| The table, found to be a folder with neither a Delta log nor Iceberg metadata | No: it is not a valid table | 1 |
| The listing, without the table | No, with the closest names and how old the listing is | 1 |
| No such listing | Not cached, never a false no | 4 |

**`--fresh` is a top-priority job.** It goes ahead of what the worker has next, one request at a time, and what it
reads goes into the catalog, so everyone sees one answer. It isn't held to five listings every 15 seconds, as someone is
waiting. Offline it fails at once, and so it does while OneLake has asked for a pause.

**What doesn't go through the worker:** `sql --fresh`, whose statement reads its tables' metadata, and `model --fresh`,
which downloads a model's file. Neither is a listing.

**Target:** tens of milliseconds for a metadata command with VS Code open.

**Measured on a real tenant, 4,988 tables, with VS Code open:** a table-exists check over the pipe is 59ms yes, and 69 to 140ms no with the closest names, in a lakehouse of 521 and of 2,014 tables. `ls` is 63ms, and `find` over everything is 253ms. A new `node` process adds about 170ms before any of that.

## Reading data

**Nothing downloads a file on its own, unless a table is in use** ([Tables in use](#tables-in-use)). Otherwise the sync
worker reads listings only. Bytes move when someone asks for them:

| What asks | What comes down | Kept in | Limit |
| --- | --- | --- | --- |
| Opening a lakehouse's Tables node | Each table's Iceberg metadata, two at a time (`prefetchMetadata`), and no rows | The catalog | None |
| The Data tab, or a statement | The parts of files that statement reads | The cache folder | `diskCacheMaxGB`, oldest first |
| The Data tab's first 100 rows | The same reads, and the rows | `first_rows` | 256 MB, oldest first |
| Opening a `Files/` object in a tab | The whole file, or a range if only a range is asked for | The cache folder, `host\` | 1 GB in all, and a file over 512 MB isn't kept |
| Opening a model | Its `.yaml` | The cache folder, `models\` | None |
| The History tab on a Delta table | Its log files | The cache folder, `host\` | The same 1 GB |
| A table in use, at a snapshot not yet read whole | Every column of it | The cache folder | `keepUsedTablesGB` |

A table opens on Stats by default, which reads nothing. When a table not in use changes, nothing downloads until someone reads it again.

**DuckDB keeps reading the bytes:** a Delta table with `delta_scan`, and an Iceberg table with `iceberg_scan`, over `abfss://`, `azure`
and `cache_httpfs`.

**A Delta table is never read through Fabric's Iceberg conversion.** Measured on a real table: a file's own column ids disagreed with
the conversion's, and `iceberg_scan` gave one column another's values with no error. The conversion's metadata is still where a table's
format and Stats come from.

**`delta_scan` reads the log itself, past DuckDB's file system.** On the real table, DuckDB's file log held the Parquet files and no log
file. So a Delta table reads through one path, online and offline ([`src/deltamirror.js`](../src/deltamirror.js)):

1. **Its log is kept in the cache folder:** the latest checkpoint, the commits after it, and any deletion vectors, copied as they are and
   never rewritten. It's asked for again past `catalogTtlMinutes`, and when a read fails. A file whose size differs from the
   listing's, or that was written after the copy, is copied again: a table dropped and made again starts its log over.
2. **`delta_scan` runs on that folder.** It reads no log from OneLake, online or offline.
3. **A mount serves the Parquet files it names.** The log's paths are relative, so `delta_scan` asks for them under the local folder.
   `cache_httpfs_mount` in our fork of `cache_httpfs` serves them from OneLake, through the disk cache and under their `abfss://` paths.

Rewriting the log to absolute paths was tried and isn't the way: `delta_scan` takes a path as absolute only if it starts with `/`, and a
rewrite would mean producing Delta's metadata ourselves. A table's log is in a folder of its own, so the disk cache's eviction doesn't touch it.

Measured on the real `scada` table, 22 million rows, with the engine's lockdown on and a space in the folder's name:

| Read | Took | Result |
|---|---|---|
| Whole table, online, cold, through the mount | 10.9s, 47 MB kept | The same as `delta_scan` on OneLake itself |
| The same, offline, a new process with no token | 0.18s | The same |
| One year, online, cold | 4.3s, 4.5 MB kept | The same |
| A year not read, offline | 0.03s | Refused: not cached on this machine |

Mounting onto a local folder or a `file://` path is refused by the lockdown.

**No file downloader, because of what was measured** on generated local Delta tables of 40 files and 131 MB:

- `LIMIT 5` opened all 40 files and read 37 MB, with `read_parquet` too, and at one thread as at eight.
- With files missing, a loop that fetched each file DuckDB asked for fetched 17 to 40 of the 40 for `LIMIT 5`.
- So a file store has to choose each statement's files itself, and reading one column of a big table still
  fetches whole files. Reading parts of files already works offline.

**The costs of this choice:**

- The patched, unsigned `cache_httpfs` stays, and reading rows offline depends on it.
- The catalog can't say how much of a table is held, as the cache's blocks are opaque.
- `httpfs` stays in any case: `quack_serve` fails without it on DuckDB 2.0.0.

`data_file` keeps each file's `abfss://` path, so a file store can be added later without changing the catalog.

### A file store on DuckLake: tried, not built

**The idea:** each table is a DuckLake table whose files keep their OneLake paths. When a file has been fetched
whole into the cache folder, its path in DuckLake changes to the local copy. A table can be part local and part
remote, and DuckDB opens whatever each path says, so nothing has to pick a statement's files. That was the problem
above.

**Tried on 2026-11-08** with DuckDB 2.0.0 and `ducklake` (catalog format 1.1), on generated local Delta tables, and on
the logs of 29 real tables already kept in the cache folder. The real logs were read from disk only. No OneLake read
went through it.

| Question | Answer |
| --- | --- |
| Under the lockdown, attached before it | Reads, `CREATE TABLE`, new snapshots, `UPDATE` on its metadata and `CHECKPOINT` all work. A file outside `allowed_directories` is refused |
| Over Quack | A client reads it like any other catalog. A path changed on the server is seen by the client's next statement, with no new snapshot |
| Local and remote files in one table | Work, and a filter skips a file it can't reach on its stats. **On Windows the lake's own `data_path` must be remote:** with a local one, every `abfss://` or `https://` path is turned into a local path. With a remote one, each table's path can be an absolute OneLake folder in any workspace |
| Rows written from the log alone, with no file read | 2,000 files in about 50ms, the same rows as `delta_scan`, and the log's stats prune to 2 files. `footer_size` and column stats can be empty. `ducklake_add_data_files` reads every footer instead: 24.6s for 2,000 local files |
| Partitions | Same rows as `delta_scan`, read from the `col=value` folder names. So a local copy keeps its relative path, folders included |
| A column added later | One name mapping for every file works, so the log's schema is enough |
| Deletion vectors | DuckLake's Puffin delete file is the bare blob, and the blob is byte for byte what a Delta `.bin` holds after its first byte. A DV sliced out of the `.bin` into a file of its own gave the same rows as `delta_scan` |
| Speed, local files, 2,000 files | The same as `delta_scan` on the kept log, within 30ms: `LIMIT 5` 70 against 53ms, a full scan 644 against 590ms. Both open over 100 files for `LIMIT 5` |
| Real tables in the cache | 1 of 29 partitioned, none with column mapping or deletion vectors |
| Packaging | `ducklake` has a DuckDB 2.0 build for each platform shipped |

**On a real table,** `scada` (Delta version 13, 9 files, 151 MB, 22 million rows, partitioned by `year`, written by
Spark), with no `cache_httpfs` loaded and DuckDB's own file cache off. Registered from its log alone in 58 to 259ms.
The same statement (rows and `sum(INITIALMW)` by year) gave the same answer every time:

| Read | Took |
| --- | --- |
| `delta_scan` on OneLake, a new process | 13.3s and 14.7s, then 10.6s and 11.0s again in that process |
| DuckLake, every file on OneLake, a new process | 6.1s and 6.6s, then 4.5s and 5.9s |
| Downloading the 9 files whole, one at a time over HTTPS | 32s |
| DuckLake, 5 files here and 4 on OneLake | 178ms |
| DuckLake, every file here | 149ms |
| The same, a new process with no token | 295ms, and one year in 27ms. `delta_scan` failed with no token |

Two findings from it:

- **`ducklake_add_data_files` refused the table:** Spark wrote `SETTLEMENTDATE` as INT96, which DuckDB reads as
  `TIMESTAMP`, while the Delta schema says `TIMESTAMPTZ`. Rows written from the log read it with no complaint.
- **A partitioned table needs a name mapping** that marks the partition column (`is_partition`), or the column reads
  as NULL. One mapping for every file is enough.

**Tried next, the same day:**

| Question | Answer |
| --- | --- |
| Following a table as it changes | Appends, a delete that rewrites files, a new column, OPTIMIZE, an update and an overwrite: each commit read from the log and written as one DuckLake snapshot in 12 to 100ms, the same rows as `delta_scan` after every one, files already held here included. Time travel to each of the 7 versions gave the same counts as `delta_scan` |
| Deletion vectors as Spark and Fabric write them (`storageType` `u`) | Three vectors packed in one `.bin` under a prefix folder, named by a Z85 UUID: decoded, sliced into a file each, the same rows as `delta_scan` |
| An Iceberg table with deletes: the real `fct_curtailment_region` | Registered from its manifests. Its own position-delete files serve as DuckLake's delete files as they are, with nothing rewritten: 5,401 rows, the same as `iceberg_scan` both ways. **Every file's size is needed:** with none, DuckDB stopped on an internal error and the database had to be restarted |
| How many tables one lake holds | 5,000 tables of 20 files: a 4.5 MB file, attached in 79ms by a new process, the first read of a table in 137ms, then 12ms, a commit in 12ms, all tables listed in 60ms. Making the 5,000 tables took 12s, once |
| A statement reading while files are evicted | It keeps its snapshot's paths: a commit and an eviction half way through left it with exactly its 798,000 rows. Windows let the local copies be deleted under it, and then it failed on the first file it hadn't opened yet. So a local copy goes only once every statement started before its eviction has finished |
| The product's shape, on `scada` | A locked-down server with the lake attached and Quack serving, a locked-down window. Six downloads at a time: 151 MB in 14 to 19s, against 32s one at a time. Each file swapped in as soon as it was whole, with the window reading throughout. The same rows at every step, and with the token gone |
| Windows and a file just written | The first statement to open the new files waited 6 to 13s with nothing in DuckDB's log, and 148ms after a 20s pause. **The downloader opens each file and reads its footer before the swap:** one such open took 15.4s, and the first statement after it took 167ms |

Smaller things learned: DuckLake writes a `CREATE TABLE` or `ALTER TABLE` to its metadata only at commit, so a schema
change is its own transaction ahead of the commit's files. `CREATE TABLE … AS` fails with a remote `data_path`, as it
tries to make a folder there, so a table is made from its column list.

Only one of the tenant's 4,989 tables has delete files, and none of the 36 whose Delta state is kept has deletion
vectors or column mapping.

**What it would fix:** no `cache_httpfs` at all. Files are read from OneLake until they come down whole, then read from
disk. The catalog knows which files are here, a remote read skips the log replay `delta_scan` does on every query, and
eviction is a path changing back.

**What must be handled first:**

- **DuckLake can delete files from a `SELECT`.** `SELECT * FROM ducklake_cleanup_old_files(…)` deleted a data file,
  and the guard takes it for a read. Here those files are OneLake's, and `ducklake_delete_orphaned_files` on a table
  folder would delete whatever it doesn't know about. The guard and `studio_authorize` must refuse every `ducklake_*`
  function that writes, and the metadata catalog by name, before anything is attached. `READ_ONLY` isn't the way: it
  also stops the server's own metadata writes, and the metadata file can't be attached twice.
- **The metadata file is tied to the extension's version.** A catalog written by a newer build is refused until it
  is migrated.
- **Not tested:** column mapping, as nothing here writes it and no table in the tenant uses it; inline deletion
  vectors (`storageType` `i`); a checkpoint split into parts; macOS and Linux.

**Decisions it needs:** whole files downloaded for tables in use, and a DuckDB file in the cache folder for DuckLake's
metadata, opened only by the shared engine. It holds nothing that can't be made again from the kept logs and the files
in the folder, so Clear Cached deletes it, and a new extension version can rebuild it instead of migrating it.

## Offline

| Answered from | What |
| --- | --- |
| The catalog alone | The tree, Go To, `SHOW ALL TABLES`, Stats, History, a wildcard's list of files, the command line's metadata |
| The catalog and the disk cache | Rows, Pivot and a model's queries, for what has been read |

Whatever isn't held says so at once.

**A table that moved on since it was read:** its metadata was read again online, and its new snapshot's rows never were. Offline, a
statement and the Data tab read the last snapshot that was read, and its age is when that was read. Stats shows the newest metadata
held. Back online, it's the current snapshot again.

## What goes, and what stays

| Goes | Stays |
| --- | --- |
| The DuckDB state file, the JSON store and JSON pointers, and `kv` and `meta` | A second SQLite file, for the log |
| The server's listing work behind the store | The server, Quack, the control pipe |
| The command line's own `--fresh` calls for listings | The read-only guard and the lockdown |
| The tree's wait for the server | NAMING.md's names |
| | The `prefetchMetadata` walk, and `onelake.js` as the way to a listing, which a click still takes |
| | `iceberg_scan`, `azure`, `httpfs`, `cache_httpfs` |
| | Export to Fabric and the Fabric app, both untouched |

**ARCHITECTURE.md changes when this ships:** *The host does the work* no longer covers listings and metadata, *The
cache* and *Offline* describe the catalog, and the tree no longer waits for the server.

## What it needs

**A higher minimum VS Code.** `engines.vscode` is now `^1.101.0`, the first version on Node 22. `node:sqlite` has been
run on 1.144 only, so whether 1.101 itself has it is still to be shown.

## Open items

| Item | Why it matters | How it closes |
| --- | --- | --- |
| `node:sqlite` in the real extension host, on macOS and Linux | Checked only as plain Node on Windows: Node 24.22.1, loaded in 0.1ms, opened and queried in-memory in 0.2ms | CI's e2e |
| A real catalog file: read times, a read during a write, a crash during a write | Invariants 3 and 4 depend on them | Measure with a real tenant's rows |
| Activation to a drawn tree | The real meaning of "opens at once" | Measure, and see what the bundle loads at activation |
| A manifest evicted while its data is held | That table fails offline. It can happen today too: eviction goes oldest-first, and block names are hashes | Give Iceberg's files a folder eviction skips, which probably needs a change in the `cache_httpfs` fork |
| Whether `iceberg_metadata` gives `data_file`'s columns, and whether Fabric's per-file stats are really zero (`names.js:197`) | If it is costly, `data_file` waits. Nothing else depends on it | Try it on real tables |
| A Delta table with deletion vectors, read through the mount | `delta_scan` handles them, and their copy is tested only with a fake OneLake | Try it on a real table |
| A Delta log that moved past what was read | Offline, a read that worked can ask for new files that aren't cached, and is refused | Nothing yet: it fails with an error, and never gives wrong rows |

## Waves

Each wave works on its own, and is proved before the next starts.

| Wave | What it does | Done when |
| --- | --- | --- |
| **1. SQLite replaces `kv`** | The same keys and JSON values in the SQLite file, written by each window, and an import from the state file. The tree draws from it first. | With no server, signed out and offline, the tree draws with DuckDB not loaded, and activation to a drawn tree is timed. |
| **2. Real tables** | JSON listings become the catalog's tables, and the tree, `resolve`, Stats, History, Go To and `SHOW ALL TABLES` query them. `catalogsnapshot.js` goes, and rows are never evicted. | Every offline test passes from the tables, and no listing is stored as JSON. |
| **3. The sync worker** | In a window's extension host, with a lease for the tenant sweep. Windows hear from the file when rows change. | A table added in Fabric appears with no click, the tree stays usable during a sync from empty, and offline it asks nothing. |
| **4. The command line** | Every metadata command reads the catalog, and `--fresh` is a top-priority job. | Every metadata command answers with the network refused, and a table-exists check is timed warm and cold. |
| **5. What the sync costs** | The rest of the tenant is read every 12 hours, and what downloads bytes is written down (*Reading data*). | The worker has met no 429 on a real tenant at that pace. |

**On its own, whenever:** Iceberg's files in a folder eviction skips. It probably needs a change in the `cache_httpfs` fork.

**Only if needed:** `data_file`.

## How it is tested

Through CI and F5, as for everything here.

- **Unit (`test/js`):** rows from fixtures, queue priority, back-off, pause and resume, dropped tables, the import.
- **Command line (`test/js/cli*.test.mjs`):** every metadata command answers with the network refused, the three
  answers above with their exit codes, and `--fresh` going through the queue.
- **e2e (signed in, no internet):** the tree, listings, Stats and History answer, a table already read returns rows,
  and what isn't held fails at once.
- **Timing, in CI and on a real machine:** activation to a drawn tree with no server, signed out, with no internet;
  and a table-exists check through `bin/cli.mjs`, warm and cold.
- **On a real tenant:** synced from empty with the tree usable throughout, online to offline and back, two windows,
  and a table added in Fabric appearing with no click.
