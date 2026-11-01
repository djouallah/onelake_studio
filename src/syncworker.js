'use strict';
// =============================================================================
// syncworker.js — keeps the catalog up to date, behind everything
// =============================================================================
// Nothing waits for this: a reader gets what the catalog holds at once, and a miss still asks OneLake
// itself. This is what changes the catalog with nobody asking:
//
//   what this window opened, and pinned workspaces   past the listing TTL, in every window
//   the rest of the tenant's listings                once a day, by one window only
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
const DAY_MS = 24 * 3600 * 1000;
const RETRY_MS = 3600 * 1000;        // one listing that fails isn't asked again for this long
const PAUSE_MS = 60_000;             // everything waits this long after OneLake asks it to
const SWEEP_IDLE_MS = 10 * 60 * 1000;

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
  const retryAt = new Map();

  const idOf = t => [t.kind, t.workspace, t.item, t.dir].join('\u0000');
  const lhOf = t => ({ workspace: t.workspace, item: t.item });
  const kept = t => (t.kind === 'workspaces' ? onelake.cached.workspaces()
    : t.kind === 'items' ? onelake.cached.items(t.workspace)
    : t.kind === 'tables' ? onelake.cached.tables(lhOf(t))
    : t.kind === 'files' ? onelake.cached.files(lhOf(t), t.dir || '')
    : t.kind === 'models' ? onelake.cached.models(t.workspace)
    : onelake.cached.apps(t.workspace));
  const read = t => (t.kind === 'workspaces' ? onelake.workspaces({ fresh: true })
    : t.kind === 'items' ? onelake.items(t.workspace, { fresh: true })
    : t.kind === 'tables' ? onelake.tables(lhOf(t), { fresh: true })
    : t.kind === 'files' ? onelake.files(lhOf(t), t.dir || '', { fresh: true })
    : t.kind === 'models' ? onelake.models(t.workspace, { fresh: true })
    : onelake.apps(t.workspace, { fresh: true }));

  async function due(t, maxAge) {
    if ((retryAt.get(idOf(t)) || 0) > now()) return false;
    const k = await kept(t).catch(() => null);
    return !k || now() - k.at > maxAge;
  }

  // One listing read and written, or why not. False stops the tick.
  async function run(t, mine) {
    try {
      await read(t);
      retryAt.delete(idOf(t));
    } catch (e) {
      if (e && e.offline) return false;
      retryAt.set(idOf(t), now() + RETRY_MS);
      log(`sync: ${t.kind} ${[t.workspace, t.item, t.dir].filter(Boolean).join('/')} failed — ${(e && e.message) || e}`);
      if (e && (e.status === 429 || e.status === 503 || !e.status)) { pausedUntil = now() + PAUSE_MS; return false; }
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
    if (await due(root, DAY_MS)) yield root;
    const listed = await onelake.cached.workspaces().catch(() => null);
    const fabric = await canFabric().catch(() => false);
    for (const workspace of (listed && listed.value) || []) {
      const items = { kind: 'items', workspace };
      if (await due(items, DAY_MS)) yield items;
      const held = await onelake.cached.items(workspace).catch(() => null);
      for (const it of (held && held.value) || []) {
        const tables = { kind: 'tables', workspace, item: it.name };
        if (holdsTables(it.name) && !isStaging(it.name) && await due(tables, DAY_MS)) yield tables;
      }
      const models = { kind: 'models', workspace };
      if (fabric && await due(models, DAY_MS)) yield models;
    }
  }

  async function tick() {
    if (busy || isOffline() || now() < pausedUntil) return;
    busy = true;
    const mine = turn;
    let left = jobsPerTick;
    const drain = async listings => {
      for await (const t of listings) {
        if (mine !== turn || isOffline()) return false;
        left--;
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
      if (!await drain(mineOpen) || !await drain(pinnedListings(ttl))) return;
      // A tenant with nothing due isn't walked every few seconds.
      if (now() < sweepAfter || !lease()) return;
      if (await drain(tenantListings())) sweepAfter = now() + SWEEP_IDLE_MS;
    } catch (e) {
      log(`sync: ${(e && e.message) || e}`);
    } finally {
      busy = false;
    }
  }

  return {
    tick,
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

module.exports = { createSyncWorker };
