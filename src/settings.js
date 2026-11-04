'use strict';
// =============================================================================
// settings.js — what the settings mean, worked out each time they are asked for
// =============================================================================
// `read(key, fallback)` is the onelakeStudio.* setting as it is now: whoever holds the
// settings hands that in.
// =============================================================================

function createSettings(read) {
  // How long a catalog answer is served from disk with no network check at all. The user's
  // number, because it IS the trade: bigger means table opens skip the catalog's
  // seconds-per-call for longer, and a new snapshot takes that much longer to show up.
  function catalogTtlMs() {
    const min = read('catalogTtlMinutes', 5);
    return Number.isFinite(min) && min >= 0 ? Math.round(min * 60 * 1000) : 5 * 60 * 1000;
  }

  // The same, for a table's metadata (the catalog's loadTable — the slow call): a day by
  // default. A new snapshot shows after that, or at once after a Refresh of its lakehouse.
  function tableTtlMs() {
    const h = read('tableMetadataTtlHours', 24);
    return Number.isFinite(h) && h >= 0 ? Math.round(h * 3600 * 1000) : 24 * 3600 * 1000;
  }

  // How much of the tables in use may be kept on this machine with nobody asking: never more than half
  // the disk cache, as it evicts the oldest first and what someone read comes before this.
  const keepLimitBytes = () => {
    const keep = Math.max(0, Number(read('keepUsedTablesGB', 10)) || 0);
    const disk = Math.max(0, Number(read('diskCacheMaxGB', 64)) || 0);
    return Math.min(keep, disk / 2) * 1e9;
  };

  // The most the disk cache may hold, per account: 0 is no disk cache at all.
  const diskCacheBytes = () => Math.max(0, Number(read('diskCacheMaxGB', 64)) || 0) * 1024 ** 3;
  const keepsDiskCache = () => Number(read('diskCacheMaxGB', 64)) > 0;

  // What runs the SQL box's statements and a model's queries: 'duckdb', or 'sqlEndpoint', the
  // workspace's Fabric SQL endpoint (tsql.js), which only online.
  const sqlEngine = () => (read('sqlEngine', 'duckdb') === 'sqlEndpoint' ? 'sqlEndpoint' : 'duckdb');
  const maxResultRows = () => Math.min(1_000_000, Math.max(1000, Math.floor(Number(read('maxResultRows', 200_000)) || 200_000)));

  return { read, catalogTtlMs, tableTtlMs, keepLimitBytes, diskCacheBytes, keepsDiskCache, sqlEngine, maxResultRows };
}

module.exports = { createSettings };
