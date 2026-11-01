# The OneLake catalog: specification

**Status: design, built in waves (below). Waves 1 to 4 are in the code.** Where it differs from
[ARCHITECTURE.md](ARCHITECTURE.md), this describes what is planned and that describes what runs today.
[NAMING.md](NAMING.md) does not change.

## The idea

**Metadata lives in a local SQLite file, and data lives in OneLake with a cache on this machine.** Three
parts have one job each:

| Part | Its job | Runs in | Touches the network |
| --- | --- | --- | --- |
| **The catalog** | Knows what exists: workspaces, items, tables, columns, files | A SQLite file | Never |
| **The sync worker** | Keeps the catalog up to date, in the background | The window's extension host | Yes: listings from OneLake and Fabric |
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
| `sync_state` | what was synced, when, its last error, when it is next due |

Every row says when it was last read from OneLake.

- **Who writes and reads:** each window opens the file itself, in WAL mode, with short transactions, so a reader is
  not held up. Every window hears what another wrote from the file, within a few seconds.
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

## The sync worker

**It runs in a window's extension host, not the server** ([`src/syncworker.js`](../src/syncworker.js)). That is where
VS Code's sign-in, proxy and certificates already are, so no token or network path has to move, and syncing needs no
DuckDB and no server. A lease in the catalog file says which window sweeps the tenant, and another takes over within
90 seconds when that one goes.

| Who | What | How often |
| --- | --- | --- |
| Whoever is waiting | A listing the catalog has never held, or a Refresh | Now, by the reader itself |
| Each window | What it has opened, and pinned workspaces | `catalogTtlMinutes` |
| The window with the lease | The rest of the tenant: workspaces, items and table lists, and models if a Fabric token is already there | Every 12 hours |

- **Table metadata is read only for lakehouses opened,** as `prefetchMetadata` does, so the tenant's manifests are not
  walked. A staging item is never swept.
- **Limits:** one request at a time and five listings every 15 seconds, so a large tenant fills in over minutes. A 429, a
  503 or no answer at all stops everything for a minute, and a listing that fails isn't asked again for an hour.
- **Every window hears** what another wrote: a look at the file every few seconds (`PRAGMA data_version`), and the tree
  redraws what changed.
- **Offline:** it asks nothing, and carries on by itself. Nothing waits on a timeout.
- **A failure** is kept in `sync_state` and shown on its node as *refresh failed*. The last good rows are still served.

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
and `resolveFile` query the catalog, in the window. The view is still `iceberg_scan` on the table's metadata
location. `SHOW ALL TABLES` and `information_schema` are answered from the catalog.

A name not in a kept listing asks the worker for that listing before it is called missing. So does a read that
fails with an `IO Error`, for that table's listing and metadata.

## The command line

**Without `--fresh`, `src/agent.js` makes no OneLake or Fabric call.** `ls`, `items`, `models`, `files`, `find`,
`table` and `exists` read the catalog with the same code as the tree. `status` and `log` ask nothing either.

**Does a table exist (`exists`):** from the listings alone, so it needs no table's metadata.

| The catalog holds | The answer | Exit |
| --- | --- | --- |
| The table | Yes, and how old that is | 0 |
| The listing, without the table | No, with the closest names and how old the listing is | 1 |
| No such listing | Not cached, never a false no | 4 |

**`--fresh` is a top-priority job.** It goes ahead of what the worker has next, one request at a time, and what it
reads goes into the catalog, so everyone sees one answer. It isn't held to five listings every 15 seconds, as someone is
waiting. Offline it fails at once, and so it does while OneLake has asked for a pause.

**What doesn't go through the worker:** `sql --fresh`, whose statement reads its tables' metadata, and `model --fresh`,
which downloads a model's file. Neither is a listing.

**Target:** tens of milliseconds for a metadata command with VS Code open.

## Reading data

**Nothing downloads a file on its own.** The sync worker reads listings only. Bytes move when someone asks for them:

| What asks | What comes down | Kept in | Limit |
| --- | --- | --- | --- |
| Opening a lakehouse's Tables node | Each table's Iceberg metadata, two at a time (`prefetchMetadata`), and no rows | The catalog | None |
| The Data tab, or a statement | The parts of files that statement reads | The cache folder | `diskCacheMaxGB`, oldest first |
| The Data tab's first 100 rows | The same reads, and the rows | `first_rows` | 256 MB, oldest first |
| Opening a `Files/` object in a tab | The whole file, or a range if only a range is asked for | The cache folder, `host\` | 1 GB in all, and a file over 512 MB isn't kept |
| Opening a model | Its `.yaml` | The cache folder, `models\` | None |
| The History tab on a Delta table | Its log files | The cache folder, `host\` | The same 1 GB |

A table opens on Stats by default, which reads nothing. When a table changes, nothing downloads until someone reads it again.

**DuckDB keeps reading the bytes,** through `iceberg_scan` over `abfss://`, `azure` and `cache_httpfs`.

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

## Offline

| Answered from | What |
| --- | --- |
| The catalog alone | The tree, Go To, `SHOW ALL TABLES`, Stats, History, a wildcard's list of files, the command line's metadata |
| The catalog and the disk cache | Rows, Pivot and a model's queries, for what has been read |

Whatever isn't held says so at once.

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
| A Delta table with deletion vectors or column mapping, read through Fabric's Iceberg conversion | No test covers it today, and this design doesn't change it | Try it on real tables |

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
