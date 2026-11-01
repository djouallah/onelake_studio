'use strict';
// =============================================================================
// deltamirror.js — a Delta table's log, kept in the cache folder
// =============================================================================
// delta_scan reads a table's log for itself, past DuckDB's file system and so past the disk cache. It is
// run on a local folder instead, which holds a copy of the log and of any deletion vectors, both of which it
// also reads for itself. The Parquet files it then asks for are under that folder only by name: a mount
// in cache_httpfs serves them from OneLake, through the disk cache (engine-host.js). So a table reads the same
// online and offline, and what's offline is what was read.
//
// The log is copied as it is, never rewritten, so the reader sees what the table's writer wrote. Only what's
// needed is copied: the latest checkpoint and the commits after it.
//
// No `vscode` import: the extension passes in what it owns.
// =============================================================================

const { join } = require('node:path');
const fsp = require('node:fs/promises');
const { createHash, randomBytes } = require('node:crypto');

const LOG = '_delta_log';
const SIDECARS = '_sidecars';
const LAST_CHECKPOINT = '_last_checkpoint';
const VERSIONED = /^(\d{20})\.(?:json|checkpoint(?:\.[^/]+)?\.(?:parquet|json))$/;
const CHECKPOINT = /^(\d{20})\.checkpoint/;
const DELETION_VECTOR = /^deletion_vector_[^/]+\.bin$/;

const baseOf = name => String(name).split('/').pop();
const exists = p => fsp.access(p).then(() => true, () => false);

async function writeWhole(file, bytes) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, bytes);
  try { await fsp.rename(tmp, file); }
  catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; }
}

/**
 * @param {object} o
 * @param {{ listDir: Function, readBytes: Function }} o.catalog  how OneLake is asked (catalog.js)
 * @param {() => string|null} o.base  the folder for this account's logs, or null for none
 * @param {number | (() => number)} o.ttlMs  how old a copy may be before OneLake is asked again
 * @param {() => boolean} [o.isOffline]
 * @param {() => number} [o.now]
 */
function createDeltaMirror({ catalog, base, ttlMs, isOffline = () => false, now = Date.now }) {
  const checked = new Map();    // local folder -> when OneLake was last asked about it
  const inflight = new Map();   // local folder -> the copy under way

  const ttl = () => (typeof ttlMs === 'function' ? ttlMs() : ttlMs);
  const folderOf = ({ workspace, dir }) => {
    const b = base();
    return b ? join(b, createHash('sha256').update(`${workspace}\0${dir}`).digest('hex').slice(0, 24)) : null;
  };
  const copy = async (workspace, from, to) => writeWhole(to, await catalog.readBytes(workspace, from));

  async function refresh({ workspace, dir }, local) {
    const remoteLog = `${dir}/${LOG}`;
    const listed = await catalog.listDir(workspace, remoteLog);
    const named = listed.map(e => ({ ...e, base: baseOf(e.name) }));
    const versioned = named.filter(e => !e.isDir && VERSIONED.test(e.base));
    if (!versioned.length) return false;
    const checkpoints = versioned.map(e => CHECKPOINT.exec(e.base)).filter(Boolean).map(m => m[1]);
    const from = checkpoints.length ? checkpoints.sort().pop() : '';
    const wanted = versioned.filter(e => VERSIONED.exec(e.base)[1] >= from)
      .sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));

    const logDir = join(local, LOG);
    await fsp.mkdir(logDir, { recursive: true });
    const held = new Set(await fsp.readdir(logDir).catch(() => []));
    const missing = wanted.filter(e => !held.has(e.base));

    if (missing.length) {
      // What a commit needs before the commit: deletion vectors, and a checkpoint's sidecars.
      for (const e of await catalog.listDir(workspace, dir)) {
        const name = baseOf(e.name);
        if (!e.isDir && DELETION_VECTOR.test(name) && !await exists(join(local, name))) {
          await copy(workspace, `${dir}/${name}`, join(local, name));
        }
      }
      if (named.some(e => e.isDir && e.base === SIDECARS)) {
        const sidecars = join(logDir, SIDECARS);
        await fsp.mkdir(sidecars, { recursive: true });
        for (const e of await catalog.listDir(workspace, `${remoteLog}/${SIDECARS}`)) {
          const name = baseOf(e.name);
          if (!e.isDir && !await exists(join(sidecars, name))) await copy(workspace, `${remoteLog}/${SIDECARS}/${name}`, join(sidecars, name));
        }
      }
      // In order, one at a time: a failure leaves a log that's only behind, with no gap in it.
      for (const e of missing) await copy(workspace, `${remoteLog}/${e.base}`, join(logDir, e.base));
    }
    if (named.some(e => !e.isDir && e.base === LAST_CHECKPOINT) && (missing.length || !held.has(LAST_CHECKPOINT))) {
      await copy(workspace, `${remoteLog}/${LAST_CHECKPOINT}`, join(logDir, LAST_CHECKPOINT));
    }
    // What's before the checkpoint is no longer read. Going is an optimisation, never a failure.
    const keep = new Set(wanted.map(e => e.base));
    for (const name of held) {
      if (VERSIONED.test(name) && !keep.has(name)) await fsp.rm(join(logDir, name), { force: true }).catch(() => {});
    }
    return true;
  }

  /**
   * The local folder to run delta_scan on, its log up to date as far as can be: or null if there is no log
   * here and none to be had. A copy already held is used when OneLake can't be asked.
   * @param {{ workspace: string, dir: string }} table  `dir`: the table's folder from the top of its workspace
   * @param {{ fresh?: boolean }} [o]  ask OneLake whatever the age of the copy
   */
  async function ensure(table, { fresh = false } = {}) {
    const local = folderOf(table);
    if (!local) return null;
    const held = await exists(join(local, LOG));
    if (isOffline()) return held ? local : null;
    if (held && !fresh && now() - (checked.get(local) ?? -Infinity) <= ttl()) return local;
    let running = inflight.get(local);
    if (!running) {
      running = refresh(table, local).then(found => { checked.set(local, now()); return found; })
        .finally(() => inflight.delete(local));
      inflight.set(local, running);
    }
    try {
      return await running ? local : null;
    } catch (e) {
      if (held) return local;
      throw e;
    }
  }

  return { ensure };
}

module.exports = { createDeltaMirror };
