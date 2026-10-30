# TODO: the rest of the 2026-10-30 review

These are the items from the code review (bugs, duplicates, dead code, inefficiency) that have not been done yet. Done so far: c7cdb26 (host bugs), 49a567d (panel bugs), 47c648e (`src/http.js` and the shared helpers), the dead code, the duplicates, and the bugs (653c16a, c0e1c14 and the blockcache fix).

## Duplicates
- **Cache walks.** `extension.js` `cachedSqlTables` and `agent.js` `find` walk the same cache. They collect different things, so it is unclear whether a shared `onelake.cached.walk()` generator is worth it. Go to (NICE_TO_HAVE #3) reuses `cachedSqlTables` through the editor's completion names, so it is still two walks.

## Dead code
- **`app/data.js` `loadTable` / `openTableView`**, and the `'loaded'` stage the page tracks for a
  table: since SQL comes from the query editor, the page never binds the selected table before a
  query (the host makes a table's view when a query names it). Check `statTable`'s
  `loaded.has(key)` and `describeLoad`'s callers before removing.

## Inefficiency
- **`engine-host.js` `ensureTables`.** It resolves the tables a statement names one after another. Use `Promise.all`; `admin()` already runs the DDL one at a time.
- **`store.js` startup.** Every read waits for the startup sweep, which stats each file in turn. Resolve `usable` after mkdir and sweep in the background.
- **`engine-host.js` `prepareFileCache`.** It stats the disk cache one file at a time before boot.
- **Redundant `ensureAuth()`.** `engine-host` `openTable`/`stream` call it, and so does `withAuthRetry`.
- **`catalog.js` `ircPrefixFor`.** Concurrent first calls each make the config request. Memoize the promise.
- **`tree.refresh(n)`.** It clears the Fabric workspace map on every refresh. Do it only for a full refresh or a models/apps node.
- **Grid-style sorts.** `explore.js` and `logs.js` sort with `localeCompare` per comparison. Use one `Intl.Collator`, as `app.js` does now.
- **Duplicate cancels.** `app.js` sends `cancel` 2–3 times per click; the engine methods already cancel.
- **Highlight ranges.** `explore.js` computes them for every measure even when highlighting is off.
- **Double JSON parse.** `docKind` parses JSON and `docview` parses it again.
- **Export fingerprint.** `exportapp` `fingerprint` hashes `site/vendor/` (~48 MB, pinned) twice per export.
- **Saved views.** `agent.js` `syncViews` reloads and recompiles every saved view on every CLI command.
- **Model setup.** `semantic.defineView` builds `exploreCompiler`/`sample` for every view at boot. Make them lazy.
- **YAML files.** A `.yaml` in Files/ is read whole just to check whether it is an Ossie model.
- **`catalogChanged`.** It fires on every table read; debounce it.
- **`store.js`.** `total` drifts up on overwrites, and `putBlob` lacks `write()`'s Windows rename retry.

## Structural (needs a decision first)
- Make the blockcache writer a dedicated worker, and transfer downloaded bytes instead of broadcasting them to every DuckDB worker.
- Move the Fabric app's catalog answer and snapshots from localStorage (~5 MB) to IndexedDB.
- Fabric app downloads:
  - download the tables of one query in parallel
  - plan and download outside the engine queue, so a download doesn't hold an engine
- CI:
  - cache `vendor/` in the engine job
  - cache `duckdb-extensions`
  - build the platform-independent output once, not in every matrix leg
  - drop the stage-webview/bundle steps that `vscode:prepublish` repeats
- `vendor.mjs`: download in parallel.
- `.vscodeignore`: add `blog/**` and the `docs/` files other than the changelog.
- Trim the Fabric app's manifest cache (`iceberg-manifests-v1`), which grows forever.
