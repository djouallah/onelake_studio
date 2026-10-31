// =============================================================================
// catalog.js — where the model's tables are, from the app's function
// =============================================================================
// The browser never holds a token: the openCatalog function (rayfin/functions) reads the
// semantic model from the lakehouse, asks the OneLake Iceberg catalog, server side, where each
// of its tables is now (its metadata.json) and signs a read-only SAS on the lakehouse's
// Tables/ folder, valid ~55 min. It answers for the model's tables, with the model.
//
// The answer is kept (kv.js, this browser's IndexedDB) until shortly before its SAS expires,
// so a viewer calls the function about once an hour, not on every load; a page open past that
// is given a new one (`renew`). This browser's alone, like the page's memory: nothing is shared.
//
//   const catalog = createCatalog(() => auth.client(), kv);
//   await catalog.open()   the model's tables, and the model
//     -> { model, metadata: { '<schema>.<table>': 'abfss://...metadata.json' }, missing: [...], sas, expiresOn }
//   catalog.fresh()     true while the kept answer is good: the page can start without a session
//   catalog.renewAt()   when to ask again (ms since the epoch)
// =============================================================================

const KEY = 'catalog';
const RENEW_MARGIN_MS = 2 * 60 * 1000;   // ask again this long before the SAS expires

// `kv`: where the answer is kept (kv.js), loaded before the page asks fresh().
export function createCatalog(client, kv) {
  const load = () => kv.get(KEY);
  const save = v => kv.set(KEY, v);
  const renewAt = (a = load()) => a ? Date.parse(a.expiresOn) - RENEW_MARGIN_MS : 0;
  // A kept answer for the model's tables holds the model: an answer without one (a build that
  // kept another app's, or an older one) is asked again.
  const good = a => !!a && Date.now() < renewAt(a) && !!a.model;

  async function call() {
    const rayfin = await client();
    // The function returns its failure as { error }, naming the step that failed.
    const r = await rayfin.functions.openCatalog.invoke({ tables: '' }, { timeoutMs: 240000 });
    if (r?.error) throw new Error(`openCatalog failed at ${r.error}`);
    save(r);
    return r;
  }

  // The kept answer if it is still good, else a new one. `renew`: a new one.
  async function open({ renew = false } = {}) {
    const kept = load();
    if (!renew && good(kept)) return kept;
    return call();
  }

  // fresh: the page can start from the kept answer without a session. Only one that is still
  // good and holds the model: without the model the page must sign in to ask again.
  return { open, renewAt: () => renewAt(), fresh: () => good(load()) };
}
