'use strict';
// The third-party code the webview runs, pinned — the ONE list. vendor.mjs downloads exactly
// these into vscode/vendor/ at package time, and panel.js hands the page the same pins
// (config.pins) along with the webview URI of that directory, so app/cdn.js builds every
// URL from here. Nothing is loaded from a CDN at run time; a version bumped here is the
// version that ships and the version the page asks for.
const PINS = {
  // The markdown renderer for document previews (docview.js), as jsDelivr's +esm closure.
  marked: 'marked@18.0.7',
  dompurify: 'dompurify@3.4.12',
  // Explore's charts — a classic script (dist/echarts.min.js), not a +esm closure.
  echarts: 'echarts@5.5.1',
  // The DAX-to-SQL compiler behind semantic models (semantic.js), at a commit.
  daxSql: 'djouallah/dax-sql@8683334f4e2a82d32630db2e382dd2c54ce0a8f1',
};

// What vendor.mjs fetches for each pin.
const VENDOR = {
  esm: [PINS.marked, PINS.dompurify],                      // npm/<pkg>/+esm, with its closure
  files: [`${PINS.echarts}/dist/echarts.min.js`],          // npm/<pkg>/<path>, as is
  // A repository has no import closure to follow; its modules import each other by
  // relative path, so the files the page needs are listed by pattern.
  gh: [{ repo: PINS.daxSql, include: /^\/(src\/.*\.js|formats\/tmsl\.js)$/ }],
};

module.exports = { PINS, VENDOR };
