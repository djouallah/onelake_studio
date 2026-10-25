// =============================================================================
// cdn.js — the panel's third-party code, pinned
// =============================================================================
// The panel's counterpart of site/cdn.js, for the modules the semantic-model view shares
// with the website (semantic.js, analyze/view.js). Same names, so those files are copied
// across unchanged; different answers: the webview never reaches jsDelivr. Every URL goes
// through the proxy's /cdn route, which serves extension/vendor/ first — vendor.mjs fills
// it from extension/src/vendored.js, whose pins must match these, and panel.js's CSP admits
// exactly those paths. A pin bumped here and not there is a refused script, not a wider one.
// =============================================================================

export const PINS = {
  // Explore's charts (analyze/view.js), loaded as a classic script when Explore first opens.
  echarts: "echarts@5.5.1",
  // The DAX-to-SQL compiler behind semantic-model queries (semantic.js), at a commit.
  daxSql: "djouallah/dax-sql@8683334f4e2a82d32630db2e382dd2c54ce0a8f1",
};

const JSDELIVR = "https://cdn.jsdelivr.net";

function base() {
  const cdn = (typeof window !== "undefined" && (window.ONELAKE_STUDIO_CONFIG || {}).cdnOrigin) || "";
  return cdn ? `${cdn}/cdn.jsdelivr.net` : JSDELIVR;
}

// A plain file inside a package: `npmFile(PINS.echarts, "dist/echarts.min.js")`.
export function npmFile(pkg, path) {
  return `${base()}/npm/${pkg}/${path}`;
}

// A file of a pinned GitHub repository: `ghFile(PINS.daxSql, "src/index.js")`. Its relative
// imports resolve beside it, under the same route.
export function ghFile(repo, path) {
  return `${base()}/gh/${repo}/${path}`;
}
