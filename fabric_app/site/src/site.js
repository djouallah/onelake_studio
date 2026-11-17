// =============================================================================
// site.js — the site's own files, beside index.html
// =============================================================================
// What the export writes and Vite copies as it is (site/public/ in the project): report.json, model.json,
// settings.json, rayfin.config.json, the world's outline, DuckDB's extensions. The page is one document, at
// the site's root, so a name is read from there, wherever Vite put the script that asks.
export const siteUrl = name => new URL(name, document.baseURI).href;
