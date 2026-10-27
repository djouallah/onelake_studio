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
  // The DAX-to-SQL compiler behind semantic models (semantic.js), at a commit.
  daxSql: 'djouallah/dax-sql@de799e0bb75559ac0d7cfbc62661339bcc93a417',
  // Generate Report's template (report.js): analytics-as-code's Fabric app on the Iceberg
  // catalog — its Rayfin project, its DuckDB-WASM data source and the page's generic modules.
  // Not the webview's: the extension copies these files into the folder it generates.
  reportTemplate: 'djouallah/analytics-as-code@34dc3b57ffd8f29a780b8e790d303737fa945d6b',
};

// What vendor.mjs fetches for each pin.
const VENDOR = {
  esm: [PINS.marked, PINS.dompurify, PINS.yaml],          // npm/<pkg>/+esm, with its closure
  files: [`${PINS.echarts}/dist/echarts.min.js`],          // npm/<pkg>/<path>, as is
  // A repository has no import closure to follow; its modules import each other by
  // relative path, so the files the page needs are listed by pattern.
  gh: [
    { repo: PINS.daxSql, include: /^\/(src\/.*\.js|formats\/(tmsl|ossie)\.js)$/ },
    { repo: PINS.reportTemplate,
      include: /^\/dashboard\/(fabric_app\/iceberg\/(duckdb\.mjs|rayfin\/.*|site\/.*)|fabric_app\/common\/site\/.*|page\/(storage\/queue|frontend\/perflog|semantic\/query)\.js)$/ },
  ],
};

module.exports = { PINS, VENDOR };
