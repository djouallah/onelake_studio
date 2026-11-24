# What DuckDB makes us work around

Each item is a limitation or a bug of DuckDB 2.0 or one of its extensions, and what OneLake Studio does instead.
What only looks like one (a choice of ours, or Windows' doing) is listed at the end. When
DuckDB fixes one, the workaround can go.

## No setting limits where a statement writes

- **`allowed_directories` and `allowed_paths` cover reads and writes alike.** A folder DuckDB may read from, it may
  write to. OneLake has to be readable (`abfss://`, `az://`, `https://`), so `COPY … TO 'abfss://…'` passes, and so
  does a write to an attached Iceberg, Delta or lake catalog. ATTACH has no read-only for a OneLake catalog.
- **What DuckDB's lockdown does block** ([core/engine/engine-host.js](../core/engine/engine-host.js)):
  - local disk outside the allowed folders, `..` escapes, and plain `http`;
  - `COPY TO` outside the temp folder;
  - any later `LOAD` (autoload and autoinstall are off);
  - any change of a setting (`lock_configuration`).
- **So the write guard is ours, in the window** ([core/sql.js](../core/sql.js)).
  - It allows one statement at a time, refuses the engine's own functions, and checks a read with
    `json_serialize_sql`.
  - It checks a write against its physical plan (`EXPLAIN (FORMAT json)`), held to the operator it should be
    (`ICEBERG_INSERT`, `DELTA_INSERT` and so on).
  - In the server, the only check is a text match through `quack_authorization_function`.
- **DuckLake's `READ_ONLY` isn't usable.** It stops the server's own writes to the lake's metadata, and the file
  can't be attached twice. So the `ducklake_` functions are refused by name.
- **`json_serialize_plan` can't serialize many plans.** It fails with `CSVReaderSerialize not implemented`, or
  `LOGICAL_GET does not support serialization`, for `read_csv`, `read_parquet`, `read_json`, `read_text`, `read_blob`
  and Iceberg scans, and with an internal error on an unbound `$name`. A write that read a file was refused. The
  check is `EXPLAIN` alone now.
- **`json_serialize_sql` answers only for a `SELECT`**, and a `PIVOT` can parse into several statements. A `PIVOT`
  is checked again wrapped as `SELECT * FROM (…)`.
- **DuckDB's Iceberg writer lacks** `CREATE OR REPLACE`, `INSERT OR REPLACE`, `ON CONFLICT`, `TRUNCATE` and
  `COPY … FROM`. These are refused before they run.
- **The delta extension only adds rows.** `UPDATE`, `DELETE`, `MERGE`, `ALTER`, `DROP` and `CREATE TABLE … AS` are
  refused. Its `CREATE TABLE` on OneLake answered 404 (duckdb-delta#432). A `todo` test watches for the fix.

## Four-part names in a three-part engine

OneLake names a table `workspace.lakehouse.schema.table`, and DuckDB's names have three parts:
`catalog.schema.table`. Each OneLake table is a view in nested schemas of the database `onelake`
([core/names.js](../core/names.js)), and DuckDB doesn't follow nested schemas everywhere:

- **`SHOW ALL TABLES` and `SHOW SCHEMAS` name only the innermost schema.** Two workspaces' `dbo.t` came out as one
  row, with their columns merged. Both are rewritten over DuckDB's catalog functions, with recursive CTEs.
- **`SHOW TABLES FROM` takes at most two parts.** It is rewritten.
- **A nested schema can't be in the search path** ("nested schemas cannot be used in the search path"). So
  `USE ws.lh.dbo` is kept by the tab, and each bare name in a statement gets its whole name before it runs:
  `json_serialize_sql` says where the names are, and `duckNames` lists DuckDB's own.
- **A catalog's name is found before a schema's**, and `main`, `pg_catalog` and `information_schema` are in every
  catalog. A workspace named like one of them is read by its GUIDs.
- **A view must have a column.** A table whose columns aren't read yet gets a placeholder column.
- **DuckDB names a database after its file**, so the file is `onelake.duckdb`.

## The log

- **File log storage can't be read back on Windows.** With `enable_logging(storage = 'file')`, `duckdb_logs` can't
  read the file DuckDB is writing ([duckdb/duckdb#28844](https://github.com/duckdb/duckdb/issues/28844); DuckDB's
  own logging tests carry `require notwindows`). Workaround:
  - logging is in memory instead;
  - every 2 s the server copies the rows to a SQLite file of its own ([core/engine/enginelog.js](../core/engine/enginelog.js), [core/logfile.js](../core/logfile.js));
  - after 5,000 rows it empties DuckDB's log with `truncate_duckdb_logs()`, reading once more just before, so no row
    is lost.
- **A Quack log row is a printed struct, not columns.** Its query, connection, time and error are read with
  regular expressions.
- **The log doesn't say which window sent a statement.** The tag each statement carries for Stop (see Quack, below)
  is read back from the logged SQL.
- **`onelake_logs` is that SQLite file**, attached read only through the sqlite extension. That has to happen before
  the lockdown, which refuses an `ATTACH` afterwards.
- **A large result's later rows aren't in the logged time:** DuckDB doesn't log them. Not worked around.

## Quack, the shared server

- **`interrupt()` doesn't reach a query on the server.** Each statement carries a `/*onelake:<window>:<n>*/` tag.
  Stop finds it with `quack_active_connections()` and ends it with `quack_cancel`. An attach named `control` exists
  only so that `quack_cancel` has a catalog to name.
- **A connection that was stopped stays busy.** The next statement on it waited about 80 s, then failed as
  interrupted. A stopped connection is never used again, so a Stop starts the tab on a new session.
- **One attach runs one statement; a second one cancels the first.**
  - Each window has a pool of up to 8 attaches, and each tab has one of its own.
  - `quack_query` is the overflow. It opens a socket each time, and at hundreds a second Windows runs out of ports.
- **A dead client's queries keep running.** When a window's pipe closes, the server cancels its tagged statements.
- **Quack logs everything it is sent.** So the OneLake token, the stats and the lake's calls go over a separate OS
  pipe.
- **An `ATTACH`'s `TOKEN` shows in `duckdb_databases()`.** Named secrets are used instead.
- **A listener can stop while the process lives.** On "Could not connect to server" or "Invalid connection id", the
  server listens again on the same port and every window attaches again.
- **The client takes its proxy from the environment.** `http_proxy` is set to `''` for the local connection.

## Lake, DuckLake, Iceberg

- **`iceberg_to_ducklake` takes a 0.4 catalog only, and DuckDB 2.0 makes 1.0 and 1.1**
  ([duckdb-iceberg#1717](https://github.com/duckdb/duckdb-iceberg/issues/1717)). Iceberg tables are read from their
  manifests instead.
- **`ducklake_add_data_files` is too slow and too strict.** It took 24.6 s for 2,000 files, and it refused an INT96
  table. The lake's metadata tables are written directly ([docs/CATALOG.md](CATALOG.md)).
- **A file with no size is an internal error that takes the database down.** Sizes are always written.
- **DuckLake on Windows:**
  - a local `data_path` makes every remote path local, so `data_path` is remote;
  - `CREATE TABLE … AS` then fails, so a table is made from its column list.
- **DuckLake, other quirks:**
  - a `CREATE` or `ALTER` reaches the metadata only at commit, so a schema change is committed first;
  - a partition column reads NULL without a name mapping;
  - it takes one delete file per data file, so several are merged.
- **The lake's metadata file opens in one process only.** The server holds it, and windows ask the server.
- **Nothing says which files a statement opened.** DuckDB's FileSystem log is read every second instead.
- **Iceberg is written only through a catalog.** A REST catalog is attached for each statement.

## httpfs, azure, secrets

- **Under the lockdown, httpfs can't find the system's CA bundle.** The engine writes a PEM of its own.
- **Proxy settings:** DuckDB ignores the editor's proxy, and azure has proxy settings of its own, so both are set.
  The proxy's password is never a setting, as `current_setting` answers any statement: it goes in an `http` secret
  for httpfs and in the storage secret for azure, and DuckDB shows neither's password.
- **A secret holds its token by value.** It is issued again when the token changes, and once more after an auth
  failure.
- **A secret's scope is a prefix**, and a OneLake URL has the workspace before the host. The scope is a list, one
  per workspace.
- **`allowed_directories` compares the drive letter as written.** Paths are normalised first.
- **The sqlite extension reads local files only.** A SQLite file on OneLake is copied to temp first.

## Errors

- **Errors come as words only.** Auth, 403 and IO failures are told apart with regular expressions, and tests pin
  DuckDB's real messages.
- **"Interrupted!" doesn't say it was a Stop.** A flag marks it.
- **An error echoes the statement**, so tokens are scrubbed from errors, and the token goes in as a prepared
  parameter.

## The Node bindings

- **Closing an instance under a live query killed the process with no word**, on Windows and Linux. The engine
  interrupts it and waits up to 10 s first.
- **`closeSync` waits for statements to finish.** The server exits without `close()`.
- **A BLOB read through the JSON rows comes back as escaped text.** It is read with `hex()`.

## Extensions and packaging

- **A `LOAD` by path knows only the core signing keys.** The community extension in the vsix (nanoarrow)
  needs unsigned extensions allowed. Each is held to its hash when the vsix is built, and the lockdown refuses any
  later `LOAD`.
- **iceberg fetches avro and httpfs at its start.** They are loaded first, in order.
- **There is no delta build for windows_arm64**, so there is no Windows on Arm package.
- **After a fatal error the database is invalidated** and refuses every statement. The server shuts down, and the
  next statement starts a new one.

## Not DuckDB's

- **The engine watchdog:** an engine stopped answering, with no bug found. It is a safety net.
- **The `setup` column in `onelake_logs`:** it marks our own thousands of views.
- **Windows:**
  - the first open of a new file can wait 6 to 15 s;
  - an open file can't be deleted.
- **Our choices:**
  - the guard in the window;
  - 8 attaches per window;
  - `allow_persistent_secrets = false`;
  - the text plan, because the webview's CSP blocks the HTML plan.
