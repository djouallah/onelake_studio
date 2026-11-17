'use strict';
// The third-party code the webview runs, pinned — the ONE list. vendor.mjs downloads exactly
// these into vendor/ at package time, and panel.js hands the page the same pins
// (config.pins) along with the webview URI of that directory, so page/cdn.js builds every
// URL from here. Nothing is loaded from a CDN at run time; a version bumped here is the
// version that ships and the version the page asks for.
const PINS = {
  // The markdown renderer for document previews (docview.js), as jsDelivr's +esm closure.
  marked: 'marked@18.0.7',
  dompurify: 'dompurify@3.4.12',
  // YAML for Apache Ossie models (semantic.js, extension.js); dax-sql's formats/ossie.js takes
  // the parsed document.
  yaml: 'yaml@2.9.1',
  // Explore's charts — a classic script (dist/echarts.min.js), not a +esm closure.
  echarts: 'echarts@5.5.1',
  // The world's outline a map tile draws over: ECharts 4's map/json/world.json, a plain GeoJSON
  // (ECharts 5 ships no maps). Only that file of the package.
  worldMap: 'echarts@4.9.0',
  // The DAX-to-SQL compiler behind semantic models (semantic.js), from npm.
  daxSql: 'dax-sql@0.2.2',
};

// The web app's (Export to Fabric, fabric_app/site): the packages its page imports, which the project's
// package.json names (fabric_app/export/exportapp.js) and Vite bundles, at package time for OneLake Studio's
// own publish (scripts/site-bundle.mjs) and in the project for Fabricator's and `rayfin up`'s. What npm has
// not, vendor.mjs downloads into vendor/webapp/, and the export copies into the project's site/public/:
// DuckDB's signed extensions and the world's outline.
const WEBAPP = {
  // DuckDB-WASM, the base build only (single-threaded; the page needs Chrome or Edge 121+).
  duckdbWasm: '@duckdb/duckdb-wasm@1.33.1-dev114.0',
  // The DuckDB that build reports (db.getVersion()): the path its extensions are asked under. A dev build
  // (dev110.0 said v2.0.0-dev88614) loads no released extension: the build must report the release.
  duckdb: 'v2.0.0',
  // DuckDB's signed extensions the page LOADs (storage/data.js).
  extensions: ['parquet', 'icu'],
  // The Arrow DuckDB-WASM itself imports (its own dependency, ^17): one module for both.
  arrow: 'apache-arrow@17.0.0',
  // Kept on the same version: they share rayfin-auth and rayfin-lib, one module each.
  rayfinClient: '@microsoft/rayfin-client@1.36.2',
  rayfinFabric: '@microsoft/rayfin-auth-provider-fabric@1.36.2',
  echarts: PINS.echarts,
  worldMap: PINS.worldMap,
};

// What vendor.mjs fetches for each pin.
const VENDOR = {
  esm: [PINS.marked, PINS.dompurify, PINS.yaml],          // npm/<pkg>/+esm, with its closure
  files: [`${PINS.echarts}/dist/echarts.min.js`, `${PINS.worldMap}/map/json/world.json`],          // npm/<pkg>/<path>, as is
  // A package's own files, as published (npm/<pkg>@<v>/…): its modules import each other by
  // relative path, so the files the page needs are listed by pattern.
  packages: [
    { pkg: PINS.daxSql, include: /^\/(src\/.*\.js|formats\/(tmsl|ossie|ossie-sql)\.js)$/ },
  ],
  // The web app's static files, vendor/webapp/, as the project's site/public/ holds them: world.json, and
  // duckdb-ext/<version>/wasm_eh/<name>.duckdb_extension.wasm, the path DuckDB-WASM asks its repository for.
  webapp: {
    files: [{ from: `${WEBAPP.worldMap}/map/json/world.json`, to: 'world.json' }],
    extensions: { duckdb: WEBAPP.duckdb, platform: 'wasm_eh', names: WEBAPP.extensions },
  },
};

module.exports = { PINS, WEBAPP, VENDOR };
