'use strict';
// =============================================================================
// readlog.js — what a window says about its reads, its boots and its clicks
// =============================================================================

const BURST_IDLE_MS = 500;    // this much quiet ends a burst
const POST_EVERY_MS = 250;    // ...and it is reported no more often than this while running

/**
 * @param {object} o
 * @param {(line: string) => void} o.log  the window's own log
 * @param {(message: object) => void} o.post  to whichever tab is on screen
 * @param {(burst: object) => void} o.onBurst  the same burst, for anything else that shows it
 */
function createReadLog({ log, post, onBurst }) {
  // One line per OneLake answer: a request the catalog made (`net`, with its time and
  // status), or an answer the store served from disk (`hit`) — the two things a slow click
  // can be made of.
  function logRead(e) {
    tally(e);
    const where = e.cache === 'hit' ? 'disk' : 'OneLake';
    const status = e.cache === 'hit' ? '' : String(e.status || '');
    const size = e.bytes ? ` ${(e.bytes / 1024).toFixed(0)}KB` : '';
    const path = e.path.length > 72 ? '…' + e.path.slice(-71) : e.path;
    log(
      `${String(e.ms || 0).padStart(6)}ms  ${(e.cache === 'hit' ? 'hit' : 'net').padEnd(4)} ${status.padEnd(3)}` +
      `${size.padStart(9)}  ${where.padEnd(8)} ${path}` + (e.error ? `  !! ${e.error}` : ''));
  }

  // The click, measured end to end. The per-read lines say where each request's time went;
  // this line is the number the user actually lived through — click to on-screen — which
  // includes everything the reads cannot see: the catalog, the worker, the rendering. When
  // an OPEN line is seconds and the read lines under it are milliseconds, the time went to
  // one of those, and that difference is the diagnosis.
  // The other half of a slow boot. The read log above is OneLake answering; these are the
  // engine's own stages — creating the DuckDB instance, loading its extensions
  // (from the vsix, or downloaded on first run). The engine host and the page both report
  // here, so a boot whose reads are all fast hits and whose total is slow says which it was.
  function logBoot(m) {
    const stages = Array.isArray(m.stages) ? m.stages : [];
    log(
      `${String(Number(m.totalMs) || 0).padStart(6)}ms  BOOT ${String(m.what || 'engine ready').slice(0, 80)}`);
    for (const s of stages) {
      log(`${String(Number(s.ms) || 0).padStart(6)}ms       ${s.stage}`);
    }
    // Which optional formats this session has is decided at boot and nowhere visible
    // after it — this line is the answer to "why is .xlsx greyed out".
    if (m.capabilities) {
      const missing = Object.entries(m.capabilities).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length) log(`        formats unavailable this session: ${missing.join(', ')}`);
    }
  }

  // The engine's catalog listed from the cache, which a first SHOW ALL TABLES waits for.
  function logCatalog(m) {
    log(`${String(m.ms).padStart(6)}ms  CATALOG ${m.count} tables and models listed`);
  }

  // Who is waiting for the page to say a file is on screen (a semantic model's progress
  // notification, which stays up until then): { label, resolve }.
  const openedWaiters = new Set();
  function whenOpened(label, ms = 60_000) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { openedWaiters.delete(w); resolve(false); }, ms);
      const w = { label, resolve: v => { clearTimeout(timer); resolve(v); } };
      openedWaiters.add(w);
    });
  }

  // The panel won't open anything after all, so nobody waits out the timeout.
  function nothingWillOpen() {
    for (const w of openedWaiters) w.resolve(false);
    openedWaiters.clear();
  }

  function logOpened(m) {
    for (const w of openedWaiters) {
      if (w.label === m.label) { openedWaiters.delete(w); w.resolve(true); }
    }
    const what = m.kind === 'table' ? 'metadata + stats on screen'
               : m.kind === 'rows' ? 'rows on screen'
               : 'file on screen';
    const label = String(m.label || '').slice(0, 80);
    log(
      `${String(Number(m.ms) || 0).padStart(6)}ms  OPEN ${label} — click to ${what}`);
  }

  // ---------------------------------------------------------------------------
  // What the panel's indicator shows
  // ---------------------------------------------------------------------------
  // The provenance of a read is only knowable here, and it was only ever written to an
  // output channel — which is not where anyone looks when something feels slow. So it goes
  // on screen, in the panel's status bar.
  //
  // Not per read: opening a table is hundreds of them, and an indicator that flickers once
  // per request reports the mechanism instead of the answer. They are gathered into a burst
  // — everything between one idle gap and the next — so what shows up is "the thing you just
  // waited for", which is the question being asked.
  let burst = null;
  let postTimer = null, idleTimer = null;
  function tally(e) {
    if (!burst) burst = { reads: 0, hits: 0, misses: 0, skips: 0, stores: 0,
                          cacheBytes: 0, netBytes: 0, storeBytes: 0, netMs: 0 };
    burst.reads++;
    if (e.cache === 'hit') { burst.hits++; burst.cacheBytes += e.bytes || 0; }
    else { burst.misses++; burst.netBytes += e.bytes || 0; burst.netMs += e.ms || 0; }
    if (!postTimer) postTimer = setTimeout(() => { postTimer = null; postReads(); }, POST_EVERY_MS);
    clearTimeout(idleTimer);
    // The settled number is the one worth reading, and it is also the one that arrives after
    // the last response — so the burst is reported once more when the reads stop, and the
    // next read after that starts a new one.
    idleTimer = setTimeout(() => { postReads(); burst = null; }, BURST_IDLE_MS);
  }

  function postReads() {
    if (!burst) return;
    post({ type: 'reads', ...burst });
    onBurst(burst);
  }

  return {
    logRead, logBoot, logCatalog, logOpened, whenOpened, nothingWillOpen,
    // The burst timers hold the process open if they are live at shutdown.
    stop() { clearTimeout(postTimer); clearTimeout(idleTimer); },
  };
}

module.exports = { createReadLog };
