// =============================================================================
// catalog.js — where the model's tables are, from the app's function
// =============================================================================
// The browser never holds a token: the openCatalog function (rayfin/functions) asks the OneLake
// Iceberg catalog, server side, where each of the model's tables is now (its metadata.json) and
// signs a read-only SAS on each table's folder, valid ~55 min. The model itself is the site's own
// (model.json): the function names its tables from the app's TABLES setting, and returns no model.
//
// The answer is kept (kv.js, this browser's IndexedDB) until shortly before its SAS expires,
// so a viewer calls the function about once an hour, not on every load; a page open past that
// is given a new one (`renew`). This browser's alone, like the page's memory: nothing is shared.
// It is one app's: rayfin-local's dev server serves one app after another at the same address, and stamps the
// page's storage with the app it serves now (STAMP_KEY); an answer kept under another stamp is asked again.
//
//   const catalog = createCatalog(() => auth.client(), kv);
//   await catalog.open()   the model's tables
//     -> { metadata: { '<schema>.<table>': 'abfss://...metadata.json' }, missing: [...], sas: { '<folder under Tables/>': '...' }, expiresOn }
//   catalog.fresh()     true while the kept answer is good: the page can start without a session
//   catalog.renewAt()   when to ask again (ms since the epoch)
// =============================================================================

const KEY = 'catalog';
const RENEW_MARGIN_MS = 2 * 60 * 1000;   // ask again this long before the SAS expires
// rayfin-local's stamp of the app and sign-in its dev server serves now; a published app has none.
const STAMP_KEY = 'rayfin-local:session-stamp';
const appNow = () => { try { return localStorage.getItem(STAMP_KEY) ?? ''; } catch { return ''; } };

// `kv`: where the answer is kept (kv.js), loaded before the page asks fresh().
export function createCatalog(client, kv) {
  const load = () => kv.get(KEY);
  const save = v => kv.set(KEY, v);
  const renewAt = (a = load()) => a ? Date.parse(a.expiresOn) - RENEW_MARGIN_MS : 0;
  // A kept answer for the model's tables holds a SAS per table: an answer without them (a build
  // that kept another app's, or an older one) is asked again.
  const good = a => !!a && Date.now() < renewAt(a) && !!a.sas && typeof a.sas === 'object' && (a.app ?? '') === appNow();

  async function call() {
    const rayfin = await client();
    // The function returns its failure as { error }, naming the step that failed.
    const r = await rayfin.functions.openCatalog.invoke({ tables: '' }, { timeoutMs: 240000 });
    if (r?.error) throw new Error(`openCatalog failed at ${r.error}`);
    const kept = { ...r, app: appNow() };
    save(kept);
    return kept;
  }

  // The kept answer if it is still good, else a new one. `renew`: a new one.
  async function open({ renew = false } = {}) {
    const kept = load();
    if (!renew && good(kept)) return kept;
    return call();
  }

  // fresh: the page can start from the kept answer without a session, while it is still good.
  return { open, renewAt: () => renewAt(), fresh: () => good(load()) };
}
