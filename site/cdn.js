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
// Run straight from site/ (npm run dev, or any copy that skipped the build) there is no
// vendored tree, and the same paths resolve on jsDelivr instead. version.js says which:
// build.mjs writes `vendored: true` into it only when every download succeeded.
//
// Plain ESM with no imports and no DOM access at load, so build.mjs can import it in Node.
// =============================================================================

export const PINS = {
  // DuckDB v2.0.0 (the package's `next` tag; its own version number still says 1.33.1-devN).
  duckdbWasm: "@duckdb/duckdb-wasm@1.33.1-dev110.0",
  // The DuckDB core version above — the path DuckDB's extension repositories use.
  duckdbCore: "v2.0.0",
  // ...and the path this BUILD asks for. The package is compiled from the v2.0.0 tag's
  // commit, but from an untagged checkout, so it calls itself v2.0.0-dev88614 and requests
  // extensions under the commit id — a path no DuckDB repository has. Measured: every
  // extension 404'd there and the site booted with no avro, i.e. no Iceberg manifests.
  // The binaries under v2.0.0 ARE built from this commit; data.js loads them by full URL
  // (with the version-string check relaxed) and build.mjs vendors them under this id.
  duckdbSourceId: "d54cbbe3df",
  // MSAL 5: every sign-in answer comes back through a redirect bridge — msal-return.js.
  msal: "@azure/msal-browser@5.26.0",
  sqljs: "sql.js@1.13.0",
  marked: "marked@18.0.7",
  dompurify: "dompurify@3.4.12",
};

// What build.mjs vendors: ESM entry points (each with its whole import closure) and the
// plain files those entry points fetch at run time.
export const VENDOR = {
  esm: [PINS.duckdbWasm, PINS.msal, `${PINS.msal}/redirect-bridge`, PINS.sqljs, PINS.marked, PINS.dompurify],
  files: [
    `${PINS.duckdbWasm}/dist/duckdb-base.wasm`,
    `${PINS.duckdbWasm}/dist/duckdb-browser-base.worker.js`,
    `${PINS.sqljs}/dist/sql-wasm.wasm`,
  ],
  // DuckDB extensions the engine loads, by repository. wasm_eh is the platform of the
  // `base` bundle.
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

// Where DuckDB should INSTALL its extensions from, or null for its own defaults.
// { core, community } — repository roots in the layout DuckDB expects
// (<root>/<duckdbCore>/wasm_eh/<name>.duckdb_extension.wasm).
export function extensionRepos() {
  const v = vendoredBase();
  return v ? { core: `${v}/duckdb-extensions/core`, community: `${v}/duckdb-extensions/community` } : null;
}

// The release binary of one extension, by full URL — what data.js falls back to when no
// repository has the path this build asks for (see duckdbSourceId).
export const EXTENSION_HOSTS = {
  core: "https://extensions.duckdb.org",
  community: "https://community-extensions.duckdb.org",
};
export function extensionUrl(name, repo = "core") {
  return `${EXTENSION_HOSTS[repo]}/${PINS.duckdbCore}/wasm_eh/${name}.duckdb_extension.wasm`;
}

export const isVendored = () => !!vendoredBase();
