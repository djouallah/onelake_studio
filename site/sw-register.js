// =============================================================================
// sw-register.js — register sw.js and make sure the page ends up controlled by it
// =============================================================================
// The first load of a fresh browser profile is NOT controlled by the service
// worker, so it gets neither the COOP/COEP headers (no crossOriginIsolated, so
// DuckDB drops to a single thread) nor OneLake token injection (so DuckDB's
// range reads would 401). One reload fixes both; the sessionStorage flag makes it
// exactly one, never a loop.
//
// Classic script, not a module, so it runs before app.js starts DuckDB.
// =============================================================================

(() => {
  if (!('serviceWorker' in navigator)) {
    console.warn('[sw] not supported — DuckDB will be single-threaded and lazy parquet reads are off');
    return;
  }

  const RELOADED = 'sw-reload-once';
  // Chromium supports COEP: require-corp with CORP headers; other engines need
  // credentialless. Same heuristic coi-serviceworker uses.
  const credentialless = !(window.chrome || window.netscape);

  function tellWorker() {
    const c = navigator.serviceWorker.controller;
    if (c) c.postMessage({ type: 'coepCredentialless', value: credentialless });
  }

  if (navigator.serviceWorker.controller) {
    sessionStorage.removeItem(RELOADED);
    tellWorker();
    return;
  }

  navigator.serviceWorker.register('sw.js').then(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) { tellWorker(); return; }
    if (!sessionStorage.getItem(RELOADED)) {
      sessionStorage.setItem(RELOADED, '1');
      window.location.reload();
    }
  }).catch(e => console.error('[sw] registration failed', e));
})();
