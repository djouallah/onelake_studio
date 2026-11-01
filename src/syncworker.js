'use strict';
// =============================================================================
// syncworker.js — keeps the catalog up to date, behind everything
// =============================================================================
// Nothing waits for this: a reader gets what the catalog holds at once, and a miss still asks OneLake
// itself. This is what changes the catalog with nobody asking:
//
//   what this window opened, and pinned workspaces   past the listing TTL, in every window
//   the rest of the tenant's listings                every 12 hours, by one window only
//
// It runs in a window, not the server, for VS Code's own sign-in, proxy and certificates. A lease in
// the catalog file says which window sweeps the tenant, and another takes over when that one goes.
// Every window hears what changed from the file (catalogfile.js subscribe).
//
// The sweep takes a few listings at a time, so a large tenant fills in over minutes rather than
// meeting OneLake all at once. It reads no table's metadata: that is what opening a lakehouse does.
//
// No `vscode` import: driven from tests with a fake clock.
// =============================================================================

const { isStaging, holdsTables } = require('./names');

const EVERY_MS = 15_000;
const JOBS_PER_TICK = 5;
const SWEEP_EVERY_MS = 12 * 3600 * 1000;
const RETRY_MS = 3600 * 1000;        // one listing that fails isn't asked again for this long
const PAUSE_MS = 60_000;             // everything waits this long after OneLake asks it to
const SWEEP_IDLE_MS = 10 * 60 * 1000;
const MAX_FAILURES = 20;

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
 * @param {(line: string) => void} [o.log]
 * @param {() => number} [o.now]
 */
function createSyncWorker({ onelake, opened = () => [], pinned = () => [], ttlMs, canFabric = async () => false,
                            isOffline, lease = () => true, log = () => {}, now = Date.now, everyMs = EVERY_MS,
                            jobsPerTick = JOBS_PER_TICK }) {
  let timer = null, busy = false, turn = 0, pausedUntil = 0, sweepAfter = 0;
  let leased = null, sweepBegan = null, lastRun = null;
  const retryAt = new Map();
  const failures = [];               // the latest, for `status`

  const idOf = t => [t.kind, t.workspace, t.item, t.dir, t.schema, t.table].join('\u0000');
  const kept = t => (t.kind === 'workspaces' ? onelake.cached.workspaces()
    : t.kind === 'items' ? onelake.cached.items(t.workspace)
    : t.kind === 'tables' ? onelake.cached.tables(lhOf(t))
    : t.kind === 'files' ? onelake.cached.files(lhOf(t), t.dir || '')
    : t.kind === 'models' ? onelake.cached.models(t.workspace)
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
      await inTurn(behind, () => readJob(onelake, t));
      retryAt.delete(idOf(t));
    } catch (e) {
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

  async function* tenantListings() {
    const root = { kind: 'workspaces' };
    if (await due(root, SWEEP_EVERY_MS)) yield root;
    const listed = await onelake.cached.workspaces().catch(() => null);
    const fabric = await canFabric().catch(() => false);
    for (const workspace of (listed && listed.value) || []) {
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

  async function tick() {
    if (busy || isOffline() || now() < pausedUntil) return;
    busy = true;
    const mine = turn;
    let left = jobsPerTick;
    const began = now();
    const ran = { open: 0, pinned: 0, tenant: 0 };
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
      if (!await drain('open', mineOpen) || !await drain('pinned', pinnedListings(ttl))) return;
      // A tenant with nothing due isn't walked every few seconds.
      if (now() < sweepAfter) return;
      const held = lease();
      if (held !== leased) {
        leased = held;
        log(held ? 'sync: this window sweeps the tenant' : 'sync: another window sweeps the tenant');
      }
      if (!held) return;
      const done = await drain('tenant', tenantListings());
      if (ran.tenant && sweepBegan == null) { sweepBegan = began; log('sync: tenant sweep started'); }
      if (done) {
        sweepAfter = now() + SWEEP_IDLE_MS;
        if (sweepBegan != null) log(`sync: tenant sweep finished in ${Math.round((now() - sweepBegan) / 1000)}s`);
        sweepBegan = null;
      }
    } catch (e) {
      log(`sync: ${(e && e.message) || e}`);
    } finally {
      busy = false;
      const count = ran.open + ran.pinned + ran.tenant;
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
      return { running: !!timer, lease: leased, tenantDue: due, sweeping: sweepBegan != null, opened: opened().length,
               pinned: pinned().length, pausedUntil: pausedUntil > now() ? pausedUntil : null, lastRun, failures: [...failures] };
    },
    start() {
      if (timer) return;
      timer = setInterval(() => { tick(); }, everyMs);
      if (timer.unref) timer.unref();
      tick();
    },
    stop() { clearInterval(timer); timer = null; turn++; },
    // Another account's catalog: nothing known about the last one applies.
    reset() { turn++; retryAt.clear(); pausedUntil = 0; sweepAfter = 0; },
  };
}

module.exports = { createSyncWorker, readJob };
