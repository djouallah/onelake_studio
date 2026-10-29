'use strict';
// The third-party code the webview runs, pinned — the ONE list. vendor.mjs downloads exactly
// these into vendor/ at package time, and panel.js hands the page the same pins
// (config.pins) along with the webview URI of that directory, so app/cdn.js builds every
// URL from here. Nothing is loaded from a CDN at run time; a version bumped here is the
// version that ships and the version the page asks for.
const PINS = {
  // The markdown renderer for document previews (docview.js), as jsDelivr's +esm closure.
  marked: 'marked@18.0.7',
  dompurify: 'dompurify@3.4.12',
  // The YAML reader for Apache Ossie models (semantic.js); dax-sql's formats/ossie.js takes
  // the parsed document.
  yaml: 'yaml@2.9.1',
  // Explore's charts — a classic script (dist/echarts.min.js), not a +esm closure.
  echarts: 'echarts@5.5.1',
  // The DAX-to-SQL compiler behind semantic models (semantic.js), from npm.
  daxSql: 'dax-sql@0.1.2',
};

// The web app's (Export to Fabric, fabric_app/site): everything its page runs, so it loads
// nothing from a CDN or DuckDB's repository. vendor.mjs downloads these into vendor/webapp/,
// and the export copies that tree into the app's site/vendor/.
const WEBAPP = {
  // DuckDB-WASM, the eh build only (the page needs Chrome or Edge 121+, which always runs it).
  duckdbWasm: '@duckdb/duckdb-wasm@1.33.1-dev65.0',
  // The DuckDB that build reports (db.getVersion()): the path its extensions are asked under.
  duckdb: 'v1.5.6',
  // DuckDB's signed extensions the page LOADs (storage/data.js).
  extensions: ['parquet', 'icu'],
  arrow: 'apache-arrow@17.0.0',
  // Kept on the same version: they share rayfin-auth and rayfin-lib, one module each.
  rayfinClient: '@microsoft/rayfin-client@1.36.1',
  rayfinFabric: '@microsoft/rayfin-auth-provider-fabric@1.36.1',
  echarts: PINS.echarts,
};

// What vendor.mjs fetches for each pin.
const VENDOR = {
  esm: [PINS.marked, PINS.dompurify, PINS.yaml],          // npm/<pkg>/+esm, with its closure
  files: [`${PINS.echarts}/dist/echarts.min.js`],          // npm/<pkg>/<path>, as is
  // A package's own files, as published (npm/<pkg>@<v>/…): its modules import each other by
  // relative path, so the files the page needs are listed by pattern.
  packages: [
    { pkg: PINS.daxSql, include: /^\/(src\/.*\.js|formats\/(tmsl|ossie)\.js)$/ },
  ],
  // The web app's tree, vendor/webapp/: the same layout (npm/…), plus duckdb-ext/<version>/
  // wasm_eh/<name>.duckdb_extension.wasm, the path DuckDB-WASM asks its repository for.
  webapp: {
    esm: [WEBAPP.duckdbWasm, WEBAPP.arrow, WEBAPP.rayfinClient, WEBAPP.rayfinFabric],
    files: [`${WEBAPP.duckdbWasm}/dist/duckdb-eh.wasm`, `${WEBAPP.duckdbWasm}/dist/duckdb-browser-eh.worker.js`,
            `${WEBAPP.echarts}/dist/echarts.min.js`],
    extensions: { duckdb: WEBAPP.duckdb, platform: 'wasm_eh', names: WEBAPP.extensions },
  },
};

module.exports = { PINS, WEBAPP, VENDOR };
