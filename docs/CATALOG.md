# The OneLake catalog: specification

**Status: built in waves (below). Waves 1 to 5 are in the code.** Where it differs from
[ARCHITECTURE.md](ARCHITECTURE.md), this describes what is planned and that describes what runs today.
[NAMING.md](NAMING.md) does not change.

## The idea

**Metadata lives in a local SQLite file, and data lives in OneLake, with the files statements read copied to this
machine in the lake.** Three parts have one job each:

| Part | Its job | Runs in | Touches the network |
| --- | --- | --- | --- |
| **The catalog** | Knows what exists: workspaces, items, tables, columns, files | A SQLite file | Never |
| **The sync worker** | Keeps the catalog up to date, in the background, and decides what else is worth reading | The window's extension host | Yes: listings and metadata from OneLake and Fabric |
| **The engine** | Runs SQL and reads the bytes | DuckDB, in the server | Yes: reads data through the lake, and keeps the files read |

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
 |  SQLite   |      |  engine: DuckDB, the  |          (logs, files)
 +-----------+      |  lake, table service  |
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
| `table_kept` | A table in use or kept offline, synced in the background to a snapshot: when, how big its files are, how long, why it failed and when to try again. Gone after 14 days |
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
| What the lake holds of a table: its files, their sizes, row counts, partitions and deletes, and what it was last synced from (`studio_synced`) | The cache folder, `lake\meta.ducklake`, a DuckDB file the server opens | DuckLake reads it. Made again from a table's own metadata, so it is a cache too ([Reading data](#reading-data)). |
| A model's `.yaml` | The cache folder, under `models\` | A file: data, with its path in the catalog. |
| Saved queries | `~/OneLakeStudio/queries/` | Not metadata. |
| The log | `logs-<id>.sqlite`, a file of its own | Not metadata. |
| Bytes of a `Files/` object the host reads | The cache folder, under `host\` | Data. |
| A table's files, and its deletion vectors | The cache folder, under `lake\files` and `lake\deletes` | Data, named in the lake. |

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
| The window with the lease | One table in use, its lake table synced to its current snapshot through the engine, with no rows read (see [Tables in use](#tables-in-use)) | When nobody is running anything |
| The window with the lease | The metadata of the other tables the lake holds | At `tableMetadataTtlHours` |
| The window with the lease | A lake table whose metadata location moved past the one it was synced from: synced, through the engine, one at a time | While no statement is running |

- **Table metadata is read only for lakehouses opened,** as `prefetchMetadata` does, **for tables in use, and for the
  tables the lake holds,** so the tenant's manifests are not walked. A staging item is never swept.
- **Limits:** one request at a time and five listings every 15 seconds, so a large tenant fills in over minutes. A 429, a
  503 or no answer at all stops everything for a minute, and a listing that fails isn't asked again for an hour.
- **Every window hears** what another wrote: a look at the file every few seconds (`PRAGMA data_version`), and the tree
  redraws what changed.
- **Offline:** it asks nothing, and carries on by itself. Nothing waits on a timeout.
- **A failure** is kept in `sync_state` and shown on its node as *refresh failed*. The last good rows are still served.

## Tables in use

**A table is in use when statements read it 3 times in 14 days.** Every statement that reads its rows counts, from a tab
or the command line, and a model's query counts for the tables it reads. `DESCRIBE` and a plain `EXPLAIN` read none.

**What such a table is short of isn't its repeat:** a repeat already reads the files it opened from disk. It is short
of a current snapshot. So the worker does two things for it:

1. **Its metadata is read every hour**, so its lake table is synced to each new snapshot within the hour, a statement
   never waits for that, and it isn't answered from a snapshot a day old.
2. **It is synced once more at its current snapshot,** through the engine (`keepTable`, a `DESCRIBE` that syncs the
   lake table first). No row is read and no file comes down for this: a table's files come here only as statements
   open them, and the sync keeps every copy still live. Each is a line in **Logs**, under a comment that says why.

**It is the last thing to run:**

- **One at a time,** by the window with the lease, on an engine already up. It never starts one.
- **Only once nobody has run anything for 2 minutes,** on any window or the command line. The server says so over the
  control pipe, so asking leaves no line in Logs.
- **Anyone's statement stops it, within 3 seconds.** It tries again after 2 more quiet minutes.
- **After 10 minutes it stops, and waits 6 hours,** so a slow connection isn't kept busy. A sync that fails waits as long.

**Which tables it syncs** is held to `onelakeStudio.keepUsedTablesGB`, 10 GB by default and never over half of
`diskCacheMaxGB`, counted by the size of each table's files:

| Limit | What it means |
| --- | --- |
| The tables in use, most read first, fit in it together | A table past what is left is skipped |
| What changed in 24 hours fits in it too | A table rewritten daily counts whole each day. An append counts for what it grew by |
| A table of no known size, or of more than 2,000 files, isn't synced this way | Never guess |

A table over the limit says so in its tooltip. `0` turns this off, and the hourly metadata stays on. Whatever the
limit, the sync worker still syncs every lake table whose snapshot moved
([ARCHITECTURE.md](ARCHITECTURE.md#reading-onelake-tables)).

**The costs of this:**

- **It reads the table's new commits,** not its rows, so it is a log read, even on a large table.
- **It runs on the server's threads and connection,** shared with statements, which is why it waits for quiet and stops
  for anyone.
- **What is on disk is what statements opened.** A table in use can still have files never read here, such as another
  partition's, and those are read from OneLake.

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
and `resolveFile` query the catalog, in the window. The view is over the table's lake table, as the server last synced it.
A table the lake holds is named from what the catalog keeps alone, with no request, however old that is: the sync worker
is what finds out that it moved. Only a table the lake has never held is synced on its first read, which reads its log.
`SHOW ALL TABLES` and `information_schema` are answered from the catalog.

A name not in a kept listing asks the worker for that listing before it is called missing. So does a read that
fails with an `IO Error`, for that table's listing and metadata.

## The command line

**Without `--fresh`, `cli/agent.js` makes no OneLake or Fabric call.** `ls`, `items`, `models`, `files`, `find`,
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

**Nothing downloads a table's file on its own.** A file comes here because a statement opened it, and the sync worker
reads only listings, metadata and the commits a lake table needs ([Tables in use](#tables-in-use)). Bytes move when
someone asks for them:

| What asks | What comes down | Kept in | Limit |
| --- | --- | --- | --- |
| Opening a lakehouse's Tables node | Each table's Iceberg metadata, two at a time (`prefetchMetadata`), and no rows | The catalog | None |
| The Data tab, or a statement | Each file that statement opens, whole, after it | The cache folder, `lake\files` | `diskCacheMaxGB`, least recently read first |
| The Data tab's first 100 rows | The same reads, and the rows | `first_rows` | 256 MB, oldest first |
| Opening a `Files/` object in a tab | The whole file, or a range if only a range is asked for | The cache folder, `host\` | 1 GB in all, and a file over 512 MB isn't kept |
| Opening a model | Its `.yaml` | The cache folder, `models\` | None |
| The History tab on a Delta table | Its log files | The cache folder, `host\` | The same 1 GB |
| A lake table whose snapshot moved | The commits since its last sync, 16 at a time, or the whole log after a newer checkpoint. No rows | The lake's metadata file, `lake\meta.ducklake` | None |

A table opens on Stats by default, which reads nothing. When a table not in use changes, nothing downloads until someone reads it again.

**A table is read through the lake** ([ARCHITECTURE.md](ARCHITECTURE.md#reading-onelake-tables)): a DuckLake table in
the server, synced from the table's own log or manifests, each of its files named on OneLake until it has come here
whole. A table is never read past the lake.

**A Delta table is never read through Fabric's Iceberg conversion.** Measured on a real table: a file's own column ids disagreed with
the conversion's, and `iceberg_scan` gave one column another's values with no error. The conversion's metadata is still where a table's
format and Stats come from.

**Before the lake,** a Delta table's log was copied to the cache folder, `delta_scan` ran on that copy, and the Parquet files
it named were served from OneLake by a mount in our fork of `cache_httpfs`, in blocks. A file downloader was ruled out then:
`LIMIT 5` opened 17 to 40 of 40 files, so a store had to choose each statement's files itself. The lake removes that
problem, as each file is named where it is and DuckDB opens what the name says. So the fork, its blocks and the log copy
went, and what the measurements below found decided it.

### What the lake was measured on

**The idea:** each table is a DuckLake table whose files keep their OneLake paths. When a file has been fetched
whole into the cache folder, its path in DuckLake changes to the local copy. A table can be part local and part
remote, and DuckDB opens whatever each path says, so nothing has to pick a statement's files.

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
| Deletion vectors | The Iceberg Puffin delete file DuckLake reads is the bare blob, and the blob is byte for byte what a Delta `.bin` holds after its first byte. A DV sliced out of the `.bin` into a file of its own gave the same rows as `delta_scan` |
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

**Where that left it, as built:**

- **DuckLake can delete files from a `SELECT`** (`ducklake_cleanup_old_files`), and here those files are OneLake's. The
  guard and `studio_authorize` refuse every `ducklake_` function and the metadata by name. `READ_ONLY` isn't the way: it
  stops the server's own metadata writes too, and the metadata file can't be attached twice.
- **The metadata file is tied to the extension's version.** It holds nothing that can't be made again from the tables'
  own metadata and the files in the folder, so a version that can't read it can start it again.
- **Since tested in CI** (`lake-tables.yml`, local and on fabriccat): column mapping with a rename, inline deletion
  vectors, a checkpoint in parts. Not tested: macOS and Linux, beyond the build.
- **`iceberg_to_ducklake` can't be used:** it takes a 0.4 catalog only, and DuckDB 2.0.0 makes 1.0 and 1.1
  ([duckdb-iceberg#1717](https://github.com/duckdb/duckdb-iceberg/issues/1717)). An Iceberg table is read from its manifests instead.

## Offline

| Answered from | What |
| --- | --- |
| The catalog alone | The tree, Go To, `SHOW ALL TABLES`, Stats, History, a wildcard's list of files, the command line's metadata |
| The catalog and the lake | Rows, Visual and a model's queries, for the files that have been read |

Whatever isn't held says so at once.

**A table that moved on since it was read:** online, the sync worker synced its lake table to the new snapshot, and the
files that snapshot added were never opened here. Offline, a statement reads the lake table as last synced: the files
already copied answer, and one that needs a file never copied says the table isn't cached on this machine. Stats shows
the newest metadata held.

## What goes, and what stays

| Goes | Stays |
| --- | --- |
| The DuckDB state file, the JSON store and JSON pointers, and `kv` and `meta` | A second SQLite file, for the log |
| The server's listing work behind the store | The server, Quack, the control pipe |
| The command line's own `--fresh` calls for listings | The read-only guard and the lockdown |
| The tree's wait for the server | NAMING.md's names |
| | The `prefetchMetadata` walk, and `onelake.js` as the way to a listing, which a click still takes |
| | `azure`, `httpfs`, and `ducklake` in place of the `cache_httpfs` fork |
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
| Whether `iceberg_metadata` gives `data_file`'s columns, and whether Fabric's per-file stats are really zero (`names.js:197`) | If it is costly, `data_file` waits. Nothing else depends on it | Try it on real tables |
| A lake table synced past what was read | Offline, a read that worked can ask for new files that aren't copied here, and is refused | Nothing yet: it fails with an error, and never gives wrong rows |

## Waves

Each wave works on its own, and is proved before the next starts.

| Wave | What it does | Done when |
| --- | --- | --- |
| **1. SQLite replaces `kv`** | The same keys and JSON values in the SQLite file, written by each window, and an import from the state file. The tree draws from it first. | With no server, signed out and offline, the tree draws with DuckDB not loaded, and activation to a drawn tree is timed. |
| **2. Real tables** | JSON listings become the catalog's tables, and the tree, `resolve`, Stats, History, Go To and `SHOW ALL TABLES` query them. `catalogsnapshot.js` goes, and rows are never evicted. | Every offline test passes from the tables, and no listing is stored as JSON. |
| **3. The sync worker** | In a window's extension host, with a lease for the tenant sweep. Windows hear from the file when rows change. | A table added in Fabric appears with no click, the tree stays usable during a sync from empty, and offline it asks nothing. |
| **4. The command line** | Every metadata command reads the catalog, and `--fresh` is a top-priority job. | Every metadata command answers with the network refused, and a table-exists check is timed warm and cold. |
| **5. What the sync costs** | The rest of the tenant is read every 12 hours, and what downloads bytes is written down (*Reading data*). | The worker has met no 429 on a real tenant at that pace. |


**Only if needed:** `data_file`.

## How it is tested

Through CI and F5, as for everything here.

- **Unit (`test/js`):** rows from fixtures, queue priority, back-off, pause and resume, dropped tables, the import.
- **Command line (`test/js/cli*.test.mjs`):** every metadata command answers with the network refused, the three
  answers above with their exit codes, and `--fresh` going through the queue.
- **e2e (signed in, no internet):** the tree, listings, Stats and History answer, a table already read returns rows,
  and what isn't held fails at once.
- **Timing, in CI and on a real machine:** activation to a drawn tree with no server, signed out, with no internet;
  and a table-exists check through `cli/cli.mjs`, warm and cold.
- **On a real tenant:** synced from empty with the tree usable throughout, online to offline and back, two windows,
  and a table added in Fabric appearing with no click.
