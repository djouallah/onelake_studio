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
  daxSql: 'dax-sql@0.2.5',
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
};

module.exports = { PINS, VENDOR };
