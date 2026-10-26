// =============================================================================
// sw-register.js — register sw.js and make sure the page ends up controlled by it
// =============================================================================
// The first load of a fresh browser profile is NOT controlled by the service worker, so
// DuckDB's OneLake range reads would go out unsigned and 401. That only matters once there
// is something to read: the worker claims the page as soon as it activates (sw.js calls
// clients.claim()), which is normally long before anyone has signed in and opened a table.
//
// So no reload on first visit any more — it existed for the COOP/COEP headers, which only
// a controlled NAVIGATION can carry, and those are gone (see sw.js). app.js still refuses
// to open a table on an uncontrolled page and says why; a normal reload fixes that case.
//
// Classic script, not a module, so registration starts before app.js does anything.
// =============================================================================

(() => {
  if (!('serviceWorker' in navigator)) {
    console.warn('[sw] not supported — OneLake reads cannot be signed in this browser');
    return;
  }
  navigator.serviceWorker.register('sw.js')
    .catch(e => console.error('[sw] registration failed', e));
})();
