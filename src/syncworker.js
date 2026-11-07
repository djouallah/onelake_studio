'use strict';
// =============================================================================
// syncworker.js — keeps the catalog up to date, behind everything
// =============================================================================
// Nothing waits for this: a reader gets what the catalog holds at once, and a miss still asks OneLake
// itself. This is what changes the catalog with nobody asking:
//
//   what this window opened, and pinned workspaces   past the listing TTL, in every window
//   the rest of the tenant's listings                every 12 hours, by one window only
//   the metadata of tables in use                    every hour, by that window
//   the bytes of tables in use, at a new snapshot    when nobody is running anything, by that window
//
// It runs in a window, not the server, for VS Code's own sign-in, proxy and certificates. A lease in
// the catalog file says which window sweeps the tenant, and another takes over when that one goes.
// Every window hears what changed from the file (catalogfile.js subscribe).
//
// The sweep takes a few listings at a time, so a large tenant fills in over minutes rather than
// meeting OneLake all at once. It reads no table's metadata: that is what opening a lakehouse does.
//
// A table is in use when statements keep reading it (onelake.js usage). A repeat of a statement already
// reads from disk, so what such a table is short of is a current snapshot, and the parts of it nothing
// read yet. Its bytes still come through DuckDB: this only decides, and `keep` does the reading.
//
// No `vscode` import: driven from tests with a fake clock.
// =============================================================================

const { isStaging, holdsTables, sqlNameOf, fmtBytes } = require('./names');

const EVERY_MS = 15_000;
const JOBS_PER_TICK = 5;
const SWEEP_EVERY_MS = 12 * 3600 * 1000;
const RETRY_MS = 3600 * 1000;        // one listing that fails isn't asked again for this long
const PAUSE_MS = 60_000;             // everything waits this long after OneLake asks it to
const SWEEP_IDLE_MS = 10 * 60 * 1000;
const MAX_FAILURES = 20;
const USED_EVERY_MS = 3600 * 1000;   // a table in use is no further behind OneLake than this
const KEEP_IDLE_MS = 2 * 60 * 1000;  // nothing is brought down until nobody has run anything for this long
const KEEP_MAX_MS = 10 * 60 * 1000;
const KEEP_RETRY_MS = 6 * 3600 * 1000;
const KEEP_WATCH_MS = 3_000;         // how soon someone's statement stops one
const LEASE_RENEW_MS = 30_000;       // how often a window keeping a table renews its lease
const KEEP_MAX_FILES = 2000;         // each file's open asks OneLake for its version
const DAY_MS = 24 * 3600 * 1000;

const lhOf = t => ({ workspace: t.workspace, item: t.item });

/**
 * One job: a listing, or a table's metadata, read from OneLake or Fabric and written to the catalog.
 * @param {ReturnType<import('./onelake').createOneLake>} onelake
 * @param {{ kind: string, workspace?: string, item?: string, dir?: string, schema?: string, table?: string }} t
 */
function readJob(onelake, t, { onWait } = {}) {
  return t.kind === 'workspaces' ? onelake.workspaces({ fresh: true })
    : t.kind === 'items' ? onelake.items(t.workspace, { fresh: true })
    : t.kind === 'tables' ? onelake.tables(lhOf(t), { fresh: true })
    : t.kind === 'files' ? onelake.files(lhOf(t), t.dir || '', { fresh: true })
    : t.kind === 'models' ? onelake.models(t.workspace, { fresh: true })
    : t.kind === 'table' ? onelake.table(lhOf(t), { schema: t.schema, table: t.table }, { fresh: true, onWait })
    : onelake.apps(t.workspace, { fresh: true });
}

/**
 * @param {object} o
 * @param {ReturnType<import('./onelake').createOneLake>} o.onelake
 * @param {() => object[]} [o.opened]  what this window has open: { kind, workspace, item, dir }
 * @param {() => string[]} [o.pinned]  the workspaces pinned here
 * @param {() => number} o.ttlMs  how old a listing may be
 * @param {() => Promise<boolean>} [o.canFabric]  whether models can be listed, with no prompt
 * @param {() => boolean} o.isOffline
 * @param {() => boolean} [o.lease]  whether this window is the one to sweep the tenant
 * @param {ReturnType<import('./onelake').createOneLake>['usage']} [o.usage]  which tables are in use
 * @param {object} [o.keep]  how a table in use is read whole, when there is an engine to do it
 * @param {() => number} o.keep.limitBytes  how much of that may be held, and come down in a day. 0 is none
 * @param {() => boolean} o.keep.ready  whether an engine is up: one is never started for this
 * @param {() => Promise<boolean>} o.keep.othersRunning  whether anyone has a statement running
 * @param {(name: string, o: { signal: AbortSignal }) => Promise<any>} o.keep.read
 * @param {() => boolean} [o.keep.held]  whether this holds off: a model kept offline is coming down
 * @param {(line: string) => void} [o.log]
 * @param {() => number} [o.now]
 */
function createSyncWorker({ onelake, opened = () => [], pinned = () => [], ttlMs, canFabric = async () => false,
                            isOffline, lease = () => true, usage = onelake.usage, keep = null, log = () => {},
                            now = Date.now, everyMs = EVERY_MS, jobsPerTick = JOBS_PER_TICK, keepWatchMs = KEEP_WATCH_MS }) {
  let timer = null, busy = false, turn = 0, pausedUntil = 0, sweepAfter = 0;
  let leased = null, sweepBegan = null, lastRun = null;
  let keeping = null, watching = null, busyAt = now(), lastKept = null;
  const retryAt = new Map();
  const failures = [];               // the latest, for `status`

  const idOf = t => [t.kind, t.workspace, t.item, t.dir, t.schema, t.table].join('\u0000');
  const kept = t => (t.kind === 'workspaces' ? onelake.cached.workspaces()
    : t.kind === 'items' ? onelake.cached.items(t.workspace)
    : t.kind === 'tables' ? onelake.cached.tables(lhOf(t))
    : t.kind === 'files' ? onelake.cached.files(lhOf(t), t.dir || '')
    : t.kind === 'models' ? onelake.cached.models(t.workspace)
    : t.kind === 'table' ? onelake.cached.table(lhOf(t), t)
    : onelake.cached.apps(t.workspace));

  // One request at a time, and whoever is waiting goes ahead of the background's next one.
  const waiting = [], behind = [];
  let pumping = false;
  function inTurn(line, read) {
    return new Promise((resolve, reject) => { line.push({ read, resolve, reject }); pump(); });
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    for (let job; (job = waiting.shift() || behind.shift());) {
      try { job.resolve(await job.read()); } catch (e) { job.reject(e); }
    }
    pumping = false;
  }

  // Noted, and whether everything now waits: OneLake asked it to, or gave no answer at all. A table's
  // metadata can fail with no status for reasons of its own, which say nothing about OneLake.
  function failed(t, e) {
    retryAt.set(idOf(t), now() + RETRY_MS);
    const where = `${t.kind} ${[t.workspace, t.item, t.dir, t.schema, t.table].filter(Boolean).join('/')}`.trim();
    const error = String((e && e.message) || e);
    log(`sync: ${where} failed — ${error}`);
    failures.push({ at: now(), where, error });
    if (failures.length > MAX_FAILURES) failures.shift();
    if (!(e && (e.status === 429 || e.status === 503 || (!e.status && t.kind !== 'table')))) return false;
    pausedUntil = now() + PAUSE_MS;
    log(`sync: paused for ${PAUSE_MS / 1000}s after that`);
    return true;
  }

  async function due(t, maxAge) {
    if ((retryAt.get(idOf(t)) || 0) > now()) return false;
    // Its time alone where that can be had: a tick asks this of every listing in the tenant.
    const at = await (onelake.listingAt ? onelake.listingAt(t) : kept(t).then(k => k && k.at)).catch(() => null);
    return at == null || now() - at > maxAge;
  }

  // One listing read and written, or why not. False stops the tick.
  async function run(t, mine) {
    try {
      // A table's metadata can sit in the catalog's backoff for a minute and more. Someone waiting
      // (first) doesn't wait behind that: the background's read gives way, and is tried next tick.
      const giveWay = () => { if (waiting.length) throw Object.assign(new Error('someone is waiting'), { gaveWay: true }); };
      await inTurn(behind, () => readJob(onelake, t, { onWait: giveWay }));
      retryAt.delete(idOf(t));
    } catch (e) {
      if (e && e.gaveWay) return false;
      if (e && e.offline) return false;
      if (failed(t, e)) return false;
    }
    return mine === turn && !isOffline();
  }

  async function* pinnedListings(ttl) {
    for (const workspace of pinned()) {
      const items = { kind: 'items', workspace };
      if (await due(items, ttl)) yield items;
      const held = await onelake.cached.items(workspace).catch(() => null);
      for (const it of (held && held.value) || []) {
        const tables = { kind: 'tables', workspace, item: it.name };
        if (holdsTables(it.name) && !isStaging(it.name) && await due(tables, ttl)) yield tables;
      }
    }
  }

  function holdsLease() {
    const held = lease();
    if (held !== leased) {
      leased = held;
      log(held ? 'sync: this window sweeps the tenant' : 'sync: another window sweeps the tenant');
    }
    return held;
  }

  // Asks for the lease only with something to do: a lease is a write, which every window hears.
  async function* usedListings() {
    let mine = false;
    for (const { workspace, item, schema, table } of usage.inUse()) {
      const job = { kind: 'table', workspace, item, schema, table };
      if (!await due(job, USED_EVERY_MS)) continue;
      if (!mine && !(mine = holdsLease())) return;
      yield job;
    }
  }

  async function* tenantListings() {
    const root = { kind: 'workspaces' };
    if (await due(root, SWEEP_EVERY_MS)) yield root;
    const listed = await onelake.cached.workspaces().catch(() => null);
    const fabric = await canFabric().catch(() => false);
    // What is in use first, as it is likelier to matter.
    const inUse = new Set(usage.inUse().map(t => t.workspace));
    const names = (listed && listed.value) || [];
    for (const workspace of [...names.filter(w => inUse.has(w)), ...names.filter(w => !inUse.has(w))]) {
      const items = { kind: 'items', workspace };
      if (await due(items, SWEEP_EVERY_MS)) yield items;
      const held = await onelake.cached.items(workspace).catch(() => null);
      for (const it of (held && held.value) || []) {
        const tables = { kind: 'tables', workspace, item: it.name };
        if (holdsTables(it.name) && !isStaging(it.name) && await due(tables, SWEEP_EVERY_MS)) yield tables;
      }
      const models = { kind: 'models', workspace };
      if (fabric && await due(models, SWEEP_EVERY_MS)) yield models;
    }
  }

  // What is held of a table comes down only under a limit, as the disk cache evicts the oldest first and
  // that must not reach what someone read. What came down since the last time is a guess, as the cache
  // can't say: only an append leaves what was read before as it was.
  function comesDown(meta, t, total) {
    const before = meta.stats.operation === 'append' ? usage.latestKept(t) : null;
    return before && before.total <= total ? total - before.total : total;
  }
  async function nextToKeep(limit) {
    let room = limit;
    const today = usage.keptSince(now() - DAY_MS);
    for (const t of usage.inUse()) {
      const held = await onelake.cached.table(lhOf(t), t).catch(() => null);
      const meta = held && held.value;
      if (!meta || meta.empty || meta.notValid || !meta.metadataLocation || !meta.stats) continue;
      const total = Number(meta.stats.totalFilesSize);
      if (!(total > 0) || total > room || Number(meta.stats.totalDataFiles) > KEEP_MAX_FILES) continue;
      room -= total;
      const last = usage.kept(t, meta.metadataLocation);
      if (last && (!last.error || last.retryAt > now())) continue;
      const bytes = comesDown(meta, t, total);
      if (today + bytes <= limit) return { t, location: meta.metadataLocation, total, bytes, name: sqlNameOf(lhOf(t), t) };
    }
    return null;
  }

  const stopKeeping = why => {
    if (!keeping || keeping.stoppedFor) return;
    keeping.stoppedFor = why;
    keeping.stop.abort();
  };
  const keepOn = () => !!keep && keep.limitBytes() > 0 && keep.ready();
  // Who else is at work, and whether what is under way goes on. Nothing waits for it, and offline it asks nothing.
  async function lookAround() {
    if (!keepOn()) return stopKeeping('off');
    if (isOffline()) return stopKeeping('offline');
    // A model kept offline is coming down (modeldata.js): it may be reading these same bytes.
    if (keep.held && keep.held()) return stopKeeping('someone');
    const others = await keep.othersRunning().catch(() => false);
    if (others) busyAt = now();
    if (others) stopKeeping('someone');
    else if (keeping && now() - keeping.began > KEEP_MAX_MS) stopKeeping('slow');
    // Asked again while keeping, which renews it: a lease left to run out (90s) has another window keep
    // the same table. Not on every look: a lease is a write, which every window hears.
    else if (keeping && now() - keeping.leasedAt > LEASE_RENEW_MS) {
      keeping.leasedAt = now();
      if (!holdsLease()) stopKeeping('lease');
    }
  }

  function keepEnded(k, e) {
    keeping = null;
    clearInterval(watching);
    watching = null;
    if (k.stoppedFor === 'reset') return;
    const ms = now() - k.began;
    const row = { location: k.location, at: now(), total: k.total, ms };
    if (!e) {
      usage.noteKept(k.t, { ...row, bytes: k.bytes, error: null, retryAt: 0 });
      lastKept = { at: now(), table: k.name, bytes: k.total, ms };
      log(`sync: kept ${k.name}, ${fmtBytes(k.total)}, in ${Math.round(ms / 1000)}s`);
      return;
    }
    // Not the table's doing: what it read is kept, so the next try carries on from there.
    // One this stopped for being slow is interrupted too, and that one is the table's.
    if (k.stoppedFor !== 'slow' && (k.stoppedFor || e.offline || e.cancelled || /interrupt/i.test(String(e.message)))) {
      log(`sync: stopped keeping ${k.name}${k.stoppedFor === 'someone' ? ': a statement is running' : ''}`);
      return;
    }
    const error = k.stoppedFor === 'slow' ? `not finished after ${Math.round(ms / 60000)} minutes` : String((e && e.message) || e);
    usage.noteKept(k.t, { ...row, bytes: 0, error, retryAt: now() + KEEP_RETRY_MS });
    log(`sync: keeping ${k.name} failed — ${error}`);
    failures.push({ at: now(), where: `keep ${k.name}`, error });
    if (failures.length > MAX_FAILURES) failures.shift();
  }

  // One at a time, by whichever window has the lease, with nobody at work. Not waited for: a table can
  // take minutes.
  async function considerKeeping() {
    if (keeping || !keepOn() || now() - busyAt < KEEP_IDLE_MS || (keep.held && keep.held())) return;
    const next = await nextToKeep(keep.limitBytes());
    if (!next || keeping || !holdsLease()) return;
    const k = { ...next, began: now(), leasedAt: now(), stop: new AbortController(), stoppedFor: null };
    keeping = k;
    log(`sync: keeping ${k.name}, ${fmtBytes(k.total)}`);
    watching = setInterval(() => { lookAround().catch(() => {}); }, keepWatchMs);
    if (watching.unref) watching.unref();
    keep.read(k.name, { signal: k.stop.signal }).then(() => keepEnded(k), e => keepEnded(k, e));
  }

  async function tick() {
    if (busy) return;
    busy = true;
    // Ahead of the checks below, which an offline window or a pause stops at: this asks OneLake nothing.
    await lookAround().catch(() => {});
    if (isOffline() || now() < pausedUntil) { busy = false; return; }
    const mine = turn;
    let left = jobsPerTick;
    const began = now();
    const ran = { open: 0, pinned: 0, used: 0, tenant: 0 };
    const drain = async (kind, listings) => {
      for await (const t of listings) {
        if (mine !== turn || isOffline()) return false;
        left--;
        ran[kind]++;
        if (!await run(t, mine)) return false;
        if (left <= 0) return false;
      }
      return true;
    };
    try {
      const ttl = ttlMs();
      const mineOpen = (async function* () {
        const root = { kind: 'workspaces' };
        if (opened().length && await due(root, ttl)) yield root;
        for (const t of opened()) if (await due(t, ttl)) yield t;
      })();
      if (!await drain('open', mineOpen) || !await drain('pinned', pinnedListings(ttl)) || !await drain('used', usedListings())) return;
      await considerKeeping();
      // A tenant with nothing due isn't walked every few seconds.
      if (now() < sweepAfter) return;
      if (!holdsLease()) return;
      const done = await drain('tenant', tenantListings());
      if (ran.tenant && sweepBegan == null) { sweepBegan = began; log('sync: tenant sweep started'); }
      if (done) {
        sweepAfter = now() + SWEEP_IDLE_MS;
        usage.prune();
        if (sweepBegan != null) log(`sync: tenant sweep finished in ${Math.round((now() - sweepBegan) / 1000)}s`);
        sweepBegan = null;
      }
    } catch (e) {
      log(`sync: ${(e && e.message) || e}`);
    } finally {
      busy = false;
      const count = ran.open + ran.pinned + ran.used + ran.tenant;
      if (count) {
        lastRun = { at: now(), ms: now() - began, ...ran };
        const what = Object.entries(ran).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ');
        log(`sync: ${count} listing(s) in ${lastRun.ms}ms: ${what}`);
      }
    }
  }

  return {
    tick,
    /**
     * Someone is waiting for this: read now, ahead of what the background has next, and answered with
     * what went into the catalog. It keeps to the worker's rules: one request at a time, and while
     * OneLake has asked for a pause it fails at once rather than asks again.
     * @param {object} t  a job, as readJob takes
     * @param {{ signal?: AbortSignal, onWait?: (s: string) => void }} [o]
     */
    first(t, { signal, onWait } = {}) {
      return inTurn(waiting, async () => {
        if (signal && signal.aborted) throw new Error('nobody is waiting for this any more');
        if (now() < pausedUntil) {
          throw Object.assign(new Error(`OneLake asked for a pause, which ends in ${Math.ceil((pausedUntil - now()) / 1000)}s: try again then`), { status: 429 });
        }
        try {
          const value = await readJob(onelake, t, { onWait });
          retryAt.delete(idOf(t));
          return value;
        } catch (e) {
          // A folder that is no table is an answer, and says nothing about OneLake.
          if (!(e && (e.offline || e.notValid))) failed(t, e);
          throw e;
        }
      });
    },
    /** How far it has got, reading only what is kept: for `status`. */
    async progress() {
      const due = {};
      try {
        for await (const t of tenantListings()) due[t.kind] = (due[t.kind] || 0) + 1;
      } catch (_) {}
      const inUse = usage.inUse();
      let keptBytes = 0;
      for (const t of inUse) {
        const held = await onelake.cached.table(lhOf(t), t).catch(() => null);
        const at = held && held.value.metadataLocation;
        const last = at && usage.kept(t, at);
        if (last && !last.error) keptBytes += last.total;
      }
      return { running: !!timer, lease: leased, tenantDue: due, sweeping: sweepBegan != null, opened: opened().length,
               pinned: pinned().length, pausedUntil: pausedUntil > now() ? pausedUntil : null, lastRun, failures: [...failures],
               used: { tables: inUse.length, keptBytes, keeping: keeping ? keeping.name : null, last: lastKept } };
    },
    start() {
      if (timer) return;
      timer = setInterval(() => { tick(); }, everyMs);
      if (timer.unref) timer.unref();
      tick();
    },
    stop() { clearInterval(timer); timer = null; turn++; stopKeeping('reset'); },
    // Another account's catalog: nothing known about the last one applies.
    reset() { turn++; retryAt.clear(); pausedUntil = 0; sweepAfter = 0; stopKeeping('reset'); },
  };
}

module.exports = { createSyncWorker, readJob };
