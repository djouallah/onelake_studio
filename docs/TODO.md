# TODO: the rest of the 2026-10-30 review

These are the items from the code review (bugs, duplicates, dead code, inefficiency) that have not been done yet. Done so far: c7cdb26 (host bugs), 49a567d (panel bugs), 47c648e (`src/http.js` and the shared helpers), and the dead code.

## Duplicates
- **Plan helpers.** `app/app.js` `planElapsed`/`planColors` copy `app/explore/view.js` `elapsed`/`profileColors`. Export both from `app/explore/profile.js`; `profileColors(css)` takes the page's own `css` reader.
- **HTML escaping.** `app/explore/logs.js` `esc` is a weaker copy of `paths.js` `escapeHtml`, which also escapes quotes. Import `escapeHtml` instead.
- **SQL quoting.** `app/explore/explore.js` `qid` and `sqlStr` copy `paths.js` `quoteIdent` and `sqlStr`. Import them.
- **"Quote only when needed" is written four times, and the copies disagree:**
  - `explore.js` `bare`, with `RESERVED`
  - `semantic.js` `namePart`, with no reserved list
  - `semantic.js` `sampleQuery` `name`
  - `src/names.js` `sqlPart`

  `semantic.js` `modelSqlName` can quote a model named `order` differently from `names.js`. Use one helper in `paths.js`.
- **`el()` DOM builder.** It is copied in `explore/view.js`, `explore.js`, `profile.js` and `model.js`, where it is a variant.
- **Cache walks.** `extension.js` `cachedSqlTables` and `agent.js` `find` walk the same cache. They collect different things, so it is unclear whether a shared `onelake.cached.walk()` generator is worth it.
- Two `FabricApp` instances per export (`extension.js`, export command).
- The BOM strip is repeated in five places.
- CRC32 is in both `exportapp.js` and `scripts/make-icon.mjs`.
- Fetch-with-retry is in both `vendor.mjs` and `fetch-extensions.mjs`.
- **Pinned versions.** CI (`extension.yml`) hard-codes the versions in `src/vendored.js` `WEBAPP`, and `fabric_app/site/app.js` hard-codes `echarts@5.5.1`.

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

## Bugs still open
- **Account-change race.** Commands and the session handler both rebind. An engine built for account A can survive a switch, or the handler can close a panel the command just opened. This needs one serialized `rebindStore` that owns the engine reset, and an `engineAccount` check in `ensureEngine`.
- **Export refresh.** After an export, the Apps node refreshed is the model's workspace, not the lakehouse's (`plan.workspace`).
- **Theme switch.** Charts keep the old theme after a VS Code theme switch. ECharts 5 can't re-theme a chart, so they must be disposed and rebuilt.
- **Settings that need a rebuild.** `engineMemoryLimit`, `diskCacheMaxGB` and `http.proxy` apply only on an engine rebuild, and nothing says so.
- **Bridge.** `bridge.js` has no timeout for a client that never sends a newline.
- **Concurrent lakehouse clicks.** Two quick clicks in different lakehouses share the global `lakehouse` (`app.js` `goToLakehouse`).
- **CLI output.** `bin/cli.mjs` calls `process.exit()` right after `console.log`, which can cut long output. Set `process.exitCode` instead.
- **`scripts/fetch-binding.mjs`:**
  - `shell: true` with unquoted paths breaks on a temp path with spaces
  - the path comparison is case-sensitive, so a lowercase drive letter fails
- **`scripts/fetch-extensions.mjs`.** It skips an optional extension on any failure, not only a 404, so CI can ship a vsix without sqlite or cache_httpfs.
- **`scripts/function-bundle.mjs`.** Its hash leaves out `host.json`, `runtimemetadata.json`, `rayfin/tsconfig.json` and `data/schema.ts`.
- **`fabric_app/rayfin/functions/src/function_app.ts`:**
  - catalog calls are unbounded `Promise.all` with no retry
  - one bad source name fails the whole call; list it under `missing` instead
- **`fabric_app/site/storage/data.js` `resultKey`.** A query that names no table is cached in IndexedDB forever.
- **`fabric_app/site/storage/blockcache.js`:**
  - readers never take over writing when the writer's tab closes, so the other tabs time out
  - a quota error is swallowed, so the store fills and never recovers
  - readers don't notice a reset and can serve stale block offsets
  - an index entry seen before its bytes is skipped for good
- **`data.js` `waitFor`.** A second `{store}` for the same path overwrites the first waiter, which then hangs and holds a download slot.
- **`auth.js`/`catalog.js` `fresh`.** It ignores whether the kept answer has a model, so sign-in can be skipped with no session.

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
