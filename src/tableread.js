'use strict';
// =============================================================================
// tableread.js — a table with OneLake security, read through OneLake's table read API
// =============================================================================
// OneLake refuses a table's files to a user its row or column rules restrict (OneLake security), so
// neither delta_scan nor iceberg_scan can read it for them. Its table read API can: `POST …/read` on the
// user's own token answers one or more Arrow IPC streams, from one snapshot, with the user's rules
// already applied, and `GET …/readStream/<id>` reads each. DuckDB reads them with `read_arrow`
// (nanoarrow, engine-host.js).
//
// Each read costs the caller capacity (on the POST, per million rows scanned), and there is no row
// filter, so a read is every row the user may see. What it answers is kept in the cache folder, one
// folder a table, and read again only past `tableMetadataTtlHours` or after a Refresh, as a table's
// metadata is. A copy is whole or not there: the streams go into a `.part` folder that is renamed once
// every one of them has arrived, and its name is when it was read.
//
// What was learned of the API by calling it, beyond its docs:
// - Names work in the URL (`workspaces/tmp/items/data.Lakehouse/…`), on the storage token.
// - The POST needs a body: `{}` is every column. `["*"]` is refused.
// - A missing table, schema or column, and a table the user may not read, are a 403
//   UserDoesNotHaveTableAccess, not the 404 the docs say. Both are taken for "not yours to read".
// - A stream can be read again with no new POST, so a dropped connection is retried.
// - A very large stream (3.6 GB over 4 streams) answered 500 "Stream was too long": no retry helps.
//
// No `vscode` import: the extension passes in what it owns.
// =============================================================================

const { join } = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { createHash, randomBytes } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { authedFetch, offlineError } = require('./http');

const TABLE_READ_ORIGIN = 'https://onelake.table.fabric.microsoft.com';
// A POST may scan the whole table before it answers.
const POST_TIMEOUT_MS = 10 * 60 * 1000;
// A stream has no time limit as a whole, only between its bytes.
const STREAM_IDLE_MS = 2 * 60 * 1000;
const STREAM_ATTEMPTS = 3;
const STREAMS_AT_ONCE = 4;
const COPY = /^\d+$/;
const STREAM_FILE = /^s(\d+)\.arrows$/;

const label = t => `${t.schema || 'dbo'}.${t.table}`;
const seg = s => encodeURIComponent(String(s));

// What the API said, from its error body: at the top level, or under `error`.
async function said(r) {
  try {
    const j = JSON.parse(await r.text());
    return (j && (j.message || (j.error && j.error.message) || j.errorCode || (j.error && j.error.code))) || '';
  } catch (_) { return ''; }
}

// Bytes, and an error if none come for `ms`.
function idleWatch(ms, onIdle) {
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(onIdle, ms); };
  arm();
  return new Transform({
    transform(chunk, _enc, done) { arm(); done(null, chunk); },
    flush(done) { clearTimeout(timer); done(); },
    destroy(e, done) { clearTimeout(timer); done(e); },
  });
}

/**
 * @param {object} o
 * @param {(o?: {fresh?: boolean}) => Promise<string|null>} o.getToken  the storage token, the one OneLake reads take
 * @param {() => string|null} o.base  this account's folder for the copies, or null for none (the disk cache off)
 * @param {number | (() => number)} o.ttlMs  how old a copy may be before it is read again
 * @param {() => string|null} [o.offlineReason]  why OneLake can't be asked now, or null
 * @param {() => boolean} [o.enabled]  whether the API may be asked (onelakeStudio.securedTableRead); a copy here is used either way
 * @param {(e: object) => void} [o.onRequest]  each request, for the read log
 */
function createTableRead({ getToken, base, ttlMs, offlineReason = () => null, enabled = () => true, onRequest = () => {},
                           origin = TABLE_READ_ORIGIN, fetchImpl, now = Date.now }) {
  const inflight = new Map();   // table folder -> { run, ac, waiting }
  const ttl = () => (typeof ttlMs === 'function' ? ttlMs() : ttlMs);
  const urlOf = t => `${origin}/v1.0/workspaces/${seg(t.workspace)}/items/${seg(t.item)}/schemas/${seg(t.schema || 'dbo')}/tables/${seg(t.table)}`;
  const folderOf = t => {
    const b = base();
    if (!b) return null;
    const key = [t.workspace, t.item, t.schema || 'dbo', t.table].join('\0').toLowerCase();
    return join(b, createHash('sha256').update(key).digest('hex').slice(0, 24));
  };

  const report = (path, r, t0, bytes, error) => {
    try { onRequest({ cache: 'miss', ms: now() - t0, status: r ? r.status : 0, path, bytes, error }); } catch (_) {}
  };
  const send = (url, o) => authedFetch(url, { getToken, ...(fetchImpl ? { fetchImpl } : {}), ...o });

  // The newest whole copy here: { files, at }, or null.
  async function held(t) {
    const dir = folderOf(t);
    if (!dir) return null;
    const copies = (await fsp.readdir(dir).catch(() => [])).filter(n => COPY.test(n)).map(Number).sort((a, b) => b - a);
    for (const at of copies) {
      const here = join(dir, String(at));
      const names = (await fsp.readdir(here).catch(() => null)) || [];
      const files = names.filter(n => STREAM_FILE.test(n))
        .sort((a, b) => Number(STREAM_FILE.exec(a)[1]) - Number(STREAM_FILE.exec(b)[1]))
        .map(n => join(here, n));
      if (files.length) return { files, at, dir: here };
    }
    return null;
  }

  async function readStream(t, id, file, signal) {
    const url = `${urlOf(t)}/readStream/${seg(id)}`;
    const path = `/${t.workspace}/${t.item}/${label(t)}/readStream`;
    for (let attempt = 1; ; attempt++) {
      const idle = new AbortController();
      const t0 = now();
      let r = null;
      try {
        r = await send(url, { timeoutMs: 0, signal: AbortSignal.any([idle.signal, ...(signal ? [signal] : [])]) });
        if (!r.ok) {
          const why = await said(r);
          report(path, r, t0, 0, why);
          if (r.status === 500 && /too long/i.test(why)) {
            throw Object.assign(new Error(`${label(t)} is too large for OneLake's table read API ("${why}"), so it can't be read here.`), { final: true });
          }
          throw Object.assign(new Error(`reading ${label(t)} through OneLake's table read API failed (HTTP ${r.status})${why ? ` — ${why}` : ''}`),
            { status: r.status, final: r.status < 500 });
        }
        let bytes = 0;
        const count = new Transform({ transform(c, _e, done) { bytes += c.length; done(null, c); } });
        await pipeline(Readable.fromWeb(r.body), idleWatch(STREAM_IDLE_MS, () => idle.abort(new Error('no data came for two minutes'))),
          count, fs.createWriteStream(file));
        report(path, r, t0, bytes);
        return bytes;
      } catch (e) {
        if (r && r.ok) report(path, r, t0, 0, (e && e.message) || String(e));
        else if (!r) report(path, null, t0, 0, (e && e.message) || String(e));
        if (signal && signal.aborted) throw signal.reason || e;
        if (e.final || attempt >= STREAM_ATTEMPTS) throw e;
      }
    }
  }

  async function download(t, dir, signal) {
    const at = now();
    const part = join(dir, `${at}.part-${randomBytes(4).toString('hex')}`);
    const t0 = now();
    const path = `/${t.workspace}/${t.item}/${label(t)}/read`;
    const r = await send(`${urlOf(t)}/read`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', timeoutMs: POST_TIMEOUT_MS, signal,
    }).catch(e => { report(path, null, t0, 0, (e && e.message) || String(e)); throw e; });
    if (!r.ok) {
      const why = await said(r);
      report(path, r, t0, 0, why);
      const refused = r.status === 403 || r.status === 404;
      throw Object.assign(new Error(refused
        ? `OneLake's table read API says you may not read ${label(t)}, or it does not exist (HTTP ${r.status})${why ? ` — ${why}` : ''}`
        : `reading ${label(t)} through OneLake's table read API failed (HTTP ${r.status})${why ? ` — ${why}` : ''}`), { status: r.status });
    }
    let streams;
    try { streams = (await r.json()).streams; }
    catch (e) { throw new Error(`OneLake's table read API cut off its answer for ${label(t)} — ${e.message}`); }
    report(path, r, t0, 0);
    if (!Array.isArray(streams) || !streams.length || streams.some(s => !s || !s.streamId)) {
      throw new Error(`OneLake's table read API answered no data for ${label(t)}`);
    }
    await fsp.mkdir(part, { recursive: true });
    try {
      // One stream failing stops the rest, and they finish before the part goes: an open file can't be removed on Windows.
      const others = new AbortController();
      const either = AbortSignal.any([signal, others.signal].filter(Boolean));
      let next = 0, failed = null;
      await Promise.all(Array.from({ length: Math.min(STREAMS_AT_ONCE, streams.length) }, async () => {
        for (let i = next++; i < streams.length && !failed; i = next++) {
          try { await readStream(t, streams[i].streamId, join(part, `s${i}.arrows`), either); }
          catch (e) { if (!failed) { failed = e; others.abort(e); } }
        }
      }));
      if (failed) throw failed;
      await fsp.rename(part, join(dir, String(at)));
      // The copies before it are read no more, nor a part another window left a day ago. Going is an
      // optimisation: a file a DuckDB holds open stays, and a view still on one that went reads the new one.
      for (const n of await fsp.readdir(dir).catch(() => [])) {
        const old = COPY.test(n) ? Number(n) < at : /\.part-/.test(n) && Number(n.split('.')[0]) < at - 24 * 3600 * 1000;
        if (old) await fsp.rm(join(dir, n), { recursive: true, force: true }).catch(() => {});
      }
      const got = await held(t);
      if (!got) throw new Error(`${label(t)} was read through OneLake's table read API, and its copy is gone from ${dir}`);
      return got;
    } catch (e) {
      await fsp.rm(part, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }

  // Whether a copy read at `at` is still the answer: within its age, and after the last Refresh.
  const current = (at, since = 0) => now() - at <= ttl() && at >= since;

  /**
   * The table's rows as the API answers them for this user: { files, at } once every stream is here.
   * A copy within its age is the answer, with nothing asked; offline, one of any age.
   * @param {{ workspace: string, item: string, schema?: string, table: string }} t  `item`: its folder, `data.Lakehouse`
   * @param {{ since?: number, signal?: AbortSignal }} [o]
   *   `since`: a Refresh; a copy before it is old. `signal`: the caller has gone. A read two callers
   *   wait for stops when both have. There is no `fresh`: a read costs the user, and a copy here is whole.
   */
  async function ensure(t, { since = 0, signal } = {}) {
    const dir = folderOf(t);
    if (!dir) throw new Error(`${label(t)} has OneLake security, and reading it needs the disk cache, which is off (onelakeStudio.diskCacheMaxGB)`);
    const kept = await held(t);
    const why = offlineReason();
    if (kept && (why || current(kept.at, since))) {
      // Used: the disk cache's trim goes by this.
      const touched = new Date(now());
      fsp.utimes(kept.dir, touched, touched).catch(() => {});
      return { ...kept, cached: true };
    }
    if (why) throw offlineError(why, `${label(t)}, which has OneLake security,`);
    if (!enabled()) {
      throw Object.assign(new Error('If the table has OneLake security, turning on onelakeStudio.securedTableRead reads the rows ' +
        "and columns your roles allow, through OneLake's table read API, which uses the workspace's capacity."), { turnedOff: true });
    }
    if (signal && signal.aborted) throw signal.reason;
    let job = inflight.get(dir);
    if (!job) {
      const ac = new AbortController();
      job = { ac, waiting: 0 };
      job.run = fsp.mkdir(dir, { recursive: true }).then(() => download(t, dir, ac.signal))
        .finally(() => { if (inflight.get(dir) === job) inflight.delete(dir); });
      job.run.catch(() => {});
      inflight.set(dir, job);
    }
    // A caller with no signal never goes away, so the read is never stopped under it.
    job.waiting += signal ? 1 : Infinity;
    if (!signal) return { ...await job.run, cached: false };
    let leave;
    const gone = new Promise((_, reject) => {
      leave = () => {
        if (--job.waiting <= 0) job.ac.abort(signal.reason);
        reject(signal.reason);
      };
      signal.addEventListener('abort', leave, { once: true });
    });
    try { return { ...await Promise.race([job.run, gone]), cached: false }; }
    finally { signal.removeEventListener('abort', leave); if (!signal.aborted) job.waiting--; }
  }

  return { ensure, held, current };
}

// A copy is every stream of one read, a folder of its own: kept, used or gone whole. For the disk cache's
// trim (engine-host.js), which goes oldest used first: { p, bytes, at } each.
async function tableReadCopies(dir) {
  const out = [];
  for (const t of await fsp.readdir(dir).catch(() => [])) {
    for (const n of await fsp.readdir(join(dir, t)).catch(() => [])) {
      if (!COPY.test(n)) continue;
      const p = join(dir, t, n);
      const st = await fsp.stat(p).catch(() => null);
      if (!st || !st.isDirectory()) continue;
      let bytes = 0;
      for (const f of await fsp.readdir(p).catch(() => [])) bytes += (await fsp.stat(join(p, f)).catch(() => ({ size: 0 }))).size;
      out.push({ p, bytes, at: st.mtimeMs });
    }
  }
  return out;
}

module.exports = { createTableRead, tableReadCopies, TABLE_READ_ORIGIN, TABLE_READ_FOLDER: 'secured' };
