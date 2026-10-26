// =============================================================================
// cdn.js — where the app's third-party code comes from, and which versions
// =============================================================================
// Every package the page runs is pinned HERE and nowhere else. build.mjs reads the same
// list and copies each one, with everything it imports, into dist/npm/ — mirroring
// jsDelivr's layout — plus DuckDB's extensions into dist/duckdb-extensions/. The deployed
// site then loads nothing executable from a third party: no CDN can change what runs on
// the origin that holds a OneLake token, and the page's Content-Security-Policy can say
// script-src 'self' and mean it.
//
// Run straight from app/ (npm run dev, or any copy that skipped the build) there is no
// vendored tree, and the same paths resolve on jsDelivr instead. version.js says which:
// build.mjs writes `vendored: true` into it only when every download succeeded.
//
// Plain ESM with no imports and no DOM access at load, so build.mjs can import it in Node.
// =============================================================================

export const PINS = {
  // DuckDB v1.5.4 — the last DuckDB-WASM whose extensions load. The DuckDB 2.0 preview
  // build (1.33.1-dev110.0, the `next` tag) is compiled from an untagged checkout: it calls
  // itself a dev build, asks for extensions under its commit id, and refuses the v2.0.0
  // binaries for not matching that string — measured, the site booted without avro, i.e.
  // without Iceberg. Move to 2.0 when the official DuckDB-Wasm 2.0 release is published.
  duckdbWasm: "@duckdb/duckdb-wasm@1.33.1-dev57.0",
  // The DuckDB core version above — the path DuckDB's extension repositories use.
  duckdbCore: "v1.5.4",
  // The single-threaded bundle's two files, which the 2.0 packages renamed (eh -> base).
  duckdbBundle: { wasm: "dist/duckdb-eh.wasm", worker: "dist/duckdb-browser-eh.worker.js" },
  // MSAL 5: every sign-in answer comes back through a redirect bridge — msal-return.js.
  msal: "@azure/msal-browser@5.26.0",
  sqljs: "sql.js@1.13.0",
  marked: "marked@18.0.7",
  dompurify: "dompurify@3.4.12",
  // Explore's charts (analyze/view.js), imported when Explore first opens.
  echarts: "echarts@5.5.1",
  // The DAX-to-SQL compiler behind semantic-model queries (semantic.js). Not on npm: plain
  // ES modules straight from its GitHub repository, at a commit.
  daxSql: "djouallah/dax-sql@8683334f4e2a82d32630db2e382dd2c54ce0a8f1",
};

// What build.mjs vendors: ESM entry points (each with its whole import closure) and the
// plain files those entry points fetch at run time.
export const VENDOR = {
  esm: [PINS.duckdbWasm, PINS.msal, `${PINS.msal}/redirect-bridge`, PINS.sqljs, PINS.marked, PINS.dompurify],
  files: [
    `${PINS.duckdbWasm}/${PINS.duckdbBundle.wasm}`,
    `${PINS.duckdbWasm}/${PINS.duckdbBundle.worker}`,
    `${PINS.sqljs}/dist/sql-wasm.wasm`,
    // ECharts as its own minified build, a classic script: jsDelivr's +esm repackaging of
    // it draws an empty canvas (measured: no bars, no axes, no error).
    `${PINS.echarts}/dist/echarts.min.js`,
  ],
  // GitHub repositories, by the files of each that the page imports: the compiler and its
  // TMSL reader, which import each other by relative path and nothing else.
  gh: [{ repo: PINS.daxSql, include: /^\/(src\/.*\.js|formats\/tmsl\.js)$/ }],
  // DuckDB extensions the engine loads, by repository. wasm_eh is the platform of the
  // single-threaded bundle.
  extensions: {
    core: ["avro", "excel"],
    community: ["h3", "zipfs"],
  },
};

const JSDELIVR = "https://cdn.jsdelivr.net";

function vendoredBase() {
  try {
    if (!(window.ONELAKE_STUDIO_VERSION || {}).vendored) return null;
    // The directory the page was served from, so a deployment under a sub-path works too —
    // build.mjs rewrites the vendored files' own imports to relative paths for this reason.
    return new URL(".", document.baseURI).href.replace(/\/$/, "");
  } catch (_) { return null; }
}

// An ESM entry point: `npmModule(PINS.msal)` -> .../npm/@azure/msal-browser@5.26.0/+esm[.js]
// The vendored copy carries a .js extension, because a static host serves an
// extension-less "+esm" as application/octet-stream and a module script refuses that.
export function npmModule(pkg) {
  const v = vendoredBase();
  return v ? `${v}/npm/${pkg}/+esm.js` : `${JSDELIVR}/npm/${pkg}/+esm`;
}

// A plain file inside a package: `npmFile(PINS.sqljs, "dist/")`.
export function npmFile(pkg, path) {
  const v = vendoredBase();
  return `${v || JSDELIVR}/npm/${pkg}/${path}`;
}

// A file of a pinned GitHub repository: `ghFile(PINS.daxSql, "src/index.js")`. jsDelivr
// serves it as written, so its relative imports resolve beside it — vendored or not.
export function ghFile(repo, path) {
  const v = vendoredBase();
  return `${v || JSDELIVR}/gh/${repo}/${path}`;
}

// Where DuckDB should INSTALL its extensions from, or null for its own defaults.
// { core, community } — repository roots in the layout DuckDB expects
// (<root>/<duckdbCore>/wasm_eh/<name>.duckdb_extension.wasm).
export function extensionRepos() {
  const v = vendoredBase();
  return v ? { core: `${v}/duckdb-extensions/core`, community: `${v}/duckdb-extensions/community` } : null;
}

export const isVendored = () => !!vendoredBase();
