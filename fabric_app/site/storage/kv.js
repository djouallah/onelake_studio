// =============================================================================
// kv.js — the app's own small records, in IndexedDB, read from memory
// =============================================================================
// The function's last answer (catalog.js) and each table's snapshot record (snapshots.js):
// localStorage held them, and its ~5 MB fills with a model of many tables. Here they are in
// IndexedDB, loaded whole into memory once at start (load()), so reading stays synchronous,
// and each write goes to IndexedDB behind it. Best-effort, like the cache it is: storage
// refused or failing, the app keeps what it learns for the visit only.
// A browser that kept them in localStorage before has them moved over on the first load.
// =============================================================================

const asPromise = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export function createKv(name, { legacy = {} } = {}) {
  const mem = new Map();
  let db = null, loading = null;
  const write = fn => { if (db) { try { fn(db.transaction('kv', 'readwrite').objectStore('kv')); } catch (e) {} } };

  return {
    // Every record into memory, once. `legacy`: { key: localStorage key } moved over and removed.
    load: () => loading ??= (async () => {
      try {
        db = await new Promise((resolve, reject) => {
          const open = indexedDB.open(name, 1);
          open.onupgradeneeded = () => open.result.createObjectStore('kv');
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        const store = db.transaction('kv').objectStore('kv');
        const [keys, values] = await Promise.all([asPromise(store.getAllKeys()), asPromise(store.getAll())]);
        keys.forEach((k, i) => mem.set(k, values[i]));
      } catch (e) { db = null; }
      for (const [key, old] of Object.entries(legacy)) {
        let v = null;
        try { v = JSON.parse(localStorage.getItem(old)); localStorage.removeItem(old); } catch (e) {}
        if (v != null && !mem.has(key)) { mem.set(key, v); write(s => s.put(v, key)); }
      }
    })(),
    get: key => (mem.has(key) ? mem.get(key) : null),
    set(key, value) { mem.set(key, value); write(s => s.put(value, key)); },
    delete(key) { mem.delete(key); write(s => s.delete(key)); },
  };
}
