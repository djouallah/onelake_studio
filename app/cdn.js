// =============================================================================
// cdn.js — where the panel's third-party code lives
// =============================================================================
// Inside the extension. vendor.mjs puts every pinned library under vendor/, and
// panel.js hands the page that directory's webview URI (config.vendorBase) and the pins
// themselves (config.pins, from src/vendored.js — the one list). Nothing here reaches a
// CDN, and nothing here can name a version the extension did not ship.
// =============================================================================

const cfg = (typeof window !== "undefined" && window.ONELAKE_STUDIO_CONFIG) || {};
const BASE = String(cfg.vendorBase || "").replace(/\/+$/, "");

export const PINS = cfg.pins || {};

// A plain file inside a package: `npmFile(PINS.echarts, "dist/echarts.min.js")`. A module's
// relative imports resolve beside it (dax-sql's).
export const npmFile = (pkg, path) => `${BASE}/npm/${pkg}/${path}`;

// A package's ES module bundle (jsDelivr's +esm, saved as +esm.js).
export const npmEsm = pkg => `${BASE}/npm/${pkg}/+esm.js`;
