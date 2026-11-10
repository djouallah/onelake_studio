// =============================================================================
// session.js — how each of the page's engines is opened and set (data.js)
// =============================================================================
// Here, not in data.js, so the store's browser test (test/js/run-store-heal.mjs) opens its engine
// the same way.
// =============================================================================

// DuckDB-WASM's file system reads a registered https file by range, after a HEAD with
// Range: bytes=0- that the store answers 206; never the whole file at once. All three are
// needed: with forceFullHTTPReads left out (on), a file opens with no request and fails.
// A number reaches JavaScript as a number: a BIGINT, HUGEINT or DECIMAL comes out of the
// engine as a DOUBLE (duckdb-wasm's own casts, on every result), not as a BigInt or an
// unscaled integer. The compiler leaves the engine's types alone (semantic/query.js).
export const OPEN = {
  filesystem: { reliableHeadRequests: true, allowFullHTTPReads: false, forceFullHTTPReads: false },
  query: { castBigIntToDouble: true, castDecimalToDouble: true },
};

export const SETTINGS = [
  // Iceberg's files never change once written: a Parquet footer read holds for the session.
  'SET parquet_metadata_cache = true',
  'SET preserve_insertion_order = false',
  // DuckDB's own cache of the files it reads, off. The store is the cache, and DuckDB's keeps what a
  // read gave it when the store lacked the bytes (a 404): the query run again, once the page has
  // downloaded them, read the same bad bytes ("Snappy decompression failure") until the page was
  // reloaded. It also reads whole blocks around each read, which are bytes the page did not download.
  'SET enable_external_file_cache = false',
];
