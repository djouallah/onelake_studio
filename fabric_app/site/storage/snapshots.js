// =============================================================================
// snapshots.js — the client's own catalog: each table's snapshot, as it was planned, kept
// =============================================================================
// Planning a table from Iceberg (data.js, PLAN) reads its metadata.json, the manifest list and
// every manifest, one request at a time, and what comes out is small: the snapshot's live data
// files and its delete files. That is kept here, per table, keyed by the table's metadata
// location: an Iceberg commit always writes a new metadata.json, so the same location is the
// same snapshot, and a table whose location the function gives again is opened from its
// record with nothing read from OneLake. A new location is planned again.
//
//   { location, bytes, scan, files: [{ path, size }], deleteFiles: [{ path, size }], savedAt }
//
// Paths only, no URL: the SAS is never stored. In this browser's IndexedDB (kv.js), one record
// per table, best-effort: a browser that blocks it plans every table every visit, as before.
// =============================================================================

const KEY = 'snapshots';
const VERSION = 4;   // a record of another version is not used (4: delete files listed, applied by the view)

// `kv` (kv.js): one record per table, under snapshot:<table>. The records localStorage held
// (all tables under one key) are split out on the first load.
export function createSnapshots(kv) {
  const key = name => `snapshot:${name}`;
  let split = false;
  const legacy = () => {
    if (split) return;
    split = true;
    const all = kv.get(KEY);
    if (!all) return;
    for (const [name, r] of Object.entries(all)) if (!kv.get(key(name))) kv.set(key(name), r);
    kv.delete(KEY);
  };
  return {
    // The table's record if it is of this location, else null.
    get(name, location) {
      legacy();
      const r = kv.get(key(name));
      return r?.v === VERSION && r.location === location && Array.isArray(r.files) ? r : null;
    },
    put(name, record) { legacy(); kv.set(key(name), { ...record, v: VERSION, savedAt: new Date().toISOString() }); },
    drop(name) { legacy(); kv.delete(key(name)); },
  };
}
