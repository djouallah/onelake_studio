'use strict';
// =============================================================================
// modeldata.js — Keep offline: a semantic model's tables stay on this machine, current
// =============================================================================
// A table kept is its DuckLake table synced to the latest snapshot, and every file of it downloaded here
// (engine-host.js keepWhole, tableservice.js fetchTable), so it answers with no connection. A sync after that
// keeps every copy still live, and the next tick downloads what a newer snapshot added.
//
// This is a background job. Once switched on it needs nothing from anyone: it goes on with the tab
// closed, comes back with the next window, and never stops for a query. What keeps it out of a query's
// way is that it isn't in the query's engine. `read` runs in an engine process of its own, on one
// thread (extension.js backgroundEngine), which holds few requests open however large the table,
// and leaves the rest of the connection free. They share only the disk cache.
//
// What's on is a row in the catalog, and what's been read is too (table_kept), so what a Pivot shows
// is worked out from those, and is the same in every window. One window does the reading: the one
// with the catalog's lease. A table stopped part way keeps what it read, and the next go carries on.
//
// No `vscode` import: driven from tests with a fake clock.
// =============================================================================
const { SQL_KINDS, fmtBytes, fileNamesIn } = require('../names');
const { tableRefs } = require('../sql');

const EVERY_MS = 15_000;
const FRESH_MS = 3600 * 1000;      // a table kept offline is no further behind OneLake than this
const RETRY_MS = 3600 * 1000;      // one that failed isn't read again for this long
const MEMO_MS = 5 * 60 * 1000;     // a Pivot asks every few seconds, and this asks nothing that often

const tablesWord = n => `${n} table${n === 1 ? '' : 's'}`;
// Why a table could not be read, in words: a refused sign-in as one, anything else as DuckDB says
// it, a file under its name and not its URL (a table's file by its own name), on one line.
const AUTH = /\b401\b|Unauthorized|AuthenticationFailed|token.*expired/i;
const reasonOf = error => (AUTH.test(error) ? 'the sign-in expired'
  : fileNamesIn(String(error)).replace(/'abfss:\/\/[^']*\/([^/']+)'/g, "'$1'")
    .replace(/^\w+ Error:\s*/, '').split('\n')[0].slice(0, 300));
const lc = s => String(s).toLowerCase();

/**
 * @param {object} o
 * @param {(catalog: string) => Promise<string[]>} o.tablesOf  a model's tables, by their SQL names
 * @param {(ref: object, o: { fresh: boolean }) => Promise<object>} o.resolve  sqltables.js resolve
 * @param {(t: object) => Promise<{ value: object }|null>} o.cachedTable  a table's kept metadata
 * @param {(name: string, o: { signal: AbortSignal }) => Promise<any>} o.read  a table, synced into the lake
 * @param {object} o.usage  what's on and what's been read whole (onelake.js)
 * @param {() => string|null} o.offlineReason
 * @param {() => boolean} o.ready  whether reading can start: not while the engines are being stopped
 * @param {() => boolean} o.lease  whether this window is the one to do the reading
 * @param {() => number} o.maxBytes  what the disk cache may hold. 0 is no disk cache
 * @param {() => void} [o.onIdle]  nothing is left to read for now: what read it can go
 * @param {(line: string) => void} [o.log]
 * @param {() => number} [o.now]
 */
function createModelData({ tablesOf, resolve, cachedTable, read, usage, offlineReason, ready, lease, maxBytes,
                           onIdle = () => {}, log = () => {}, now = Date.now, everyMs = EVERY_MS }) {
  let timer = null, current = null, ticking = false, reading = false;
  const named = new Map();      // lower-cased model -> { at, idents }
  const located = new Map();    // a table's SQL name -> { at, t }
  const freshAt = new Map();    // lower-cased model -> when its tables were last read past the cache

  async function idents(catalog) {
    const key = lc(catalog);
    const kept = named.get(key);
    if (kept && now() - kept.at < MEMO_MS) return kept.idents;
    const list = await tablesOf(catalog);
    named.set(key, { at: now(), idents: list });
    return list;
  }

  async function locate(ident, { fresh = false } = {}) {
    const kept = located.get(ident);
    if (!fresh && kept && now() - kept.at < MEMO_MS) return kept.t;
    const [ref] = tableRefs(ident, SQL_KINDS);
    if (!ref) throw new Error(`${ident} does not name a table`);
    const found = await resolve(ref, { fresh });
    let t = null;                // an empty table has nothing to bring down
    if (found.metadataLocation) {
      const held = await cachedTable(found.listed).catch(() => null);
      const size = Number(held && held.value && held.value.stats && held.value.stats.totalFilesSize) || 0;
      t = { name: ident, t: found.listed, location: found.metadataLocation, size };
    }
    located.set(ident, { at: now(), t });
    return t;
  }

  // A model's tables, and those that couldn't be found out about.
  async function survey(catalog, o) {
    const tables = [], failed = [];
    for (const ident of await idents(catalog)) {
      try {
        const t = await locate(ident, o);
        if (t) tables.push(t);
      } catch (e) { failed.push({ name: ident, error: (e && e.message) || String(e) }); }
    }
    return { tables, failed };
  }

  const keptOf = t => usage.kept(t.t, t.location);
  const isDown = t => { const k = keptOf(t); return !!k && !k.error; };
  const isOn = catalog => usage.offlineModels().some(m => lc(m.catalog) === lc(catalog));

  /** What a Pivot shows: { on, say, tone, meter, tip, busy }. Reads what's kept: this asks OneLake nothing it hasn't already. */
  async function state(catalog) {
    if (!isOn(catalog)) return { on: false, say: '', tone: '', busy: false };
    const offline = offlineReason();
    let found;
    try { found = await survey(catalog); }
    catch (e) { return { on: true, say: (e && e.message) || String(e), tone: 'bad', busy: false }; }
    const { tables, failed } = found;
    const count = tables.length + failed.length;
    const down = tables.filter(isDown);
    const missing = tables.filter(t => !isDown(t));
    const total = tables.reduce((n, t) => n + t.size, 0);
    const held = down.reduce((n, t) => n + t.size, 0);
    if (offline) {
      return { on: true, say: `No connection · ${down.length} of ${tablesWord(count)} here`, tone: 'warn', busy: false,
               tip: 'The rest comes down when the connection is back. What is here still answers.' };
    }
    const broke = missing.filter(t => { const k = keptOf(t); return k && k.error; })
      .map(t => ({ name: t.name, error: keptOf(t).error })).concat(failed);
    if (broke.length && broke.length === missing.length + failed.length) {
      // One short line on the bar; why, in the tip.
      const first = broke[0].name.split('.').pop();
      return { on: true, say: `${down.length} of ${tablesWord(count)} · ${first}${broke.length > 1 ? ` and ${broke.length - 1} more` : ''} failed, retrying`,
               tone: 'bad', busy: false,
               tip: [...broke.map(b => `${b.name.split('.').pop()} could not be read from OneLake: ${reasonOf(b.error)}.`),
                     `${broke.length > 1 ? 'They are' : 'It is'} tried again within the hour.`].join('\n') };
    }
    if (!missing.length) {
      return { on: true, say: `✓ ${fmtBytes(total)} on this machine`, tone: 'good', busy: false,
               tip: 'Every table is here at its latest data. Works with no connection.' };
    }
    const meter = total > 0 ? Math.round((held / total) * 100) : 0;
    if (missing.every(t => usage.latestKept(t.t))) {
      return { on: true, say: `New data · ${tablesWord(missing.length)} · ${fmtBytes(missing.reduce((n, t) => n + t.size, 0))}`,
               tone: '', meter, busy: true, tip: 'A table changed, and the new data is coming down in the background. Queries use what is here until then.' };
    }
    return { on: true, say: `${down.length} of ${tablesWord(count)} · ${fmtBytes(held)} of ${fmtBytes(total)}`, tone: '', meter, busy: true,
             tip: 'Coming down in the background, at a pace that leaves your queries room. It goes on with this tab closed. Turn it off to stop; what came down stays.' };
  }

  /** Switched on or off. Answers what to show: too much for the disk cache stays off, and says why. */
  async function set(catalog, model, on) {
    if (!on) {
      usage.setOffline(catalog, model, false, now());
      if (current && lc(current.catalog) === lc(catalog)) current.stop.abort();
      log(`keep offline: ${model} off`);
      return state(catalog);
    }
    const refuse = say => ({ on: false, say, tone: 'bad', busy: false, refused: true });
    const room = maxBytes();
    if (!(room > 0)) return refuse('The disk cache is off: onelakeStudio.diskCacheMaxGB');
    named.delete(lc(catalog));
    const online = !offlineReason();
    // From what's kept, so switching back on answers at once: nothing was deleted, and what's there
    // goes on answering. Whether anything newer has come is the next tick's to find out, behind it.
    let found;
    try {
      found = await survey(catalog);
      // Unless what's kept can't say: a table never seen, or one gone from the listing.
      if (online && (found.failed.length || !found.tables.length)) found = await survey(catalog, { fresh: true });
    } catch (e) { return refuse((e && e.message) || String(e)); }
    if (online && !found.tables.length && !found.failed.length) return refuse(`${model} reads no tables in OneLake`);
    let total = found.tables.reduce((n, t) => n + t.size, 0);
    for (const m of usage.offlineModels()) {
      if (lc(m.catalog) === lc(catalog)) continue;
      total += (await survey(m.catalog).catch(() => ({ tables: [] }))).tables.reduce((n, t) => n + t.size, 0);
    }
    if (total > room) return refuse(`${fmtBytes(total)} won't fit: the disk cache is ${fmtBytes(room)}`);
    usage.setOffline(catalog, model, true, now());
    // Switched on again is asking again: a table that failed doesn't wait out its hour.
    for (const t of found.tables) { const k = keptOf(t); if (k && k.error && k.retryAt > now()) usage.noteKept(t.t, { ...k, location: t.location, retryAt: 0 }); }
    log(`keep offline: ${model} on`);
    tick().catch(() => {});
    return state(catalog);
  }

  // One table's read isn't this table's doing to fail when the engine or the connection went away.
  const notItsFault = e => !!(e && (e.offline || e.cancelled)) ||
    /interrupt|Could not connect to server|Invalid connection id|the engine (stopped|was closed)/i.test(String(e && e.message));

  // Whether it got through them. If not, the next tick is soon enough to try again.
  async function readThem(job, todo) {
    for (const t of todo) {
      if (job.stop.signal.aborted) return false;
      const began = now();
      job.table = t.name;
      try {
        const got = await read(t.name, { signal: job.stop.signal });
        // Kept is every file here: one that didn't come down is tried again later.
        if (got && got.left) throw new Error(`${got.left} of its ${got.files} files could not be downloaded`);
        // Nothing of the idle job's daily budget went on this: nobody asked that job for it.
        usage.noteKept(t.t, { location: t.location, at: now(), total: t.size, bytes: 0, ms: now() - began, error: null, retryAt: 0 });
        log(`keep offline: ${t.name}, ${fmtBytes(t.size)}, in ${Math.round((now() - began) / 1000)}s`);
      } catch (e) {
        if (job.stop.signal.aborted || notItsFault(e)) return false;
        const error = (e && e.message) || String(e);
        usage.noteKept(t.t, { location: t.location, at: now(), total: t.size, bytes: 0, ms: now() - began, error, retryAt: now() + RETRY_MS });
        log(`keep offline: ${t.name} failed — ${error}`);
      }
    }
    return true;
  }

  function idle() {
    if (!reading) return;
    reading = false;
    try { onIdle(); } catch (_) {}
  }

  // Whichever model has something to read, one at a time. Not waited for: a table can take hours.
  async function tick() {
    if (current) {
      if (offlineReason() || !isOn(current.catalog)) current.stop.abort();
      return;
    }
    if (ticking) return;
    if (offlineReason() || !ready()) { idle(); return; }
    ticking = true;
    try {
      const models = usage.offlineModels();
      if (!models.length || !lease()) { idle(); return; }
      for (const m of models) {
        const key = lc(m.catalog);
        const fresh = !freshAt.has(key) || now() - freshAt.get(key) > FRESH_MS;
        const { tables } = await survey(m.catalog, { fresh }).catch(() => ({ tables: [] }));
        if (fresh) freshAt.set(key, now());
        const todo = tables.filter(t => { const k = keptOf(t); return !k || (k.error && k.retryAt <= now()); });
        if (!todo.length) continue;
        const job = { catalog: m.catalog, stop: new AbortController(), table: null };
        current = job;
        reading = true;
        log(`keep offline: ${m.model}: ${tablesWord(todo.length)} to read`);
        readThem(job, todo).catch(() => false).then(through => {
          if (current === job) current = null;
          if (through) tick().catch(() => {});
        });
        return;
      }
      idle();
    } finally { ticking = false; }
  }

  return {
    state,
    set,
    tick,
    // Whether this window is reading: the idle job holds off, or the two would read the same bytes twice.
    busy: () => !!current,
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => {}); }, everyMs);
      if (timer.unref) timer.unref();
      tick().catch(() => {});
    },
    stop() { clearInterval(timer); timer = null; if (current) current.stop.abort(); },
    // Another account's catalog: nothing known about the last one applies.
    reset() { if (current) current.stop.abort(); named.clear(); located.clear(); freshAt.clear(); },
  };
}

module.exports = { createModelData };
