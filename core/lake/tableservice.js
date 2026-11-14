'use strict';
// =============================================================================
// tableservice.js — the files of OneLake tables, brought here one at a time as they are read
// =============================================================================
// The lake (onelaketable.js) names each file of a table by where it is: on OneLake until it has come down whole,
// then the local copy. This service moves files between the two:
//
// - **What a statement reads comes down.** The engine tells it the files statements opened (DuckDB's FileSystem
//   log). A file on OneLake that a statement opened is queued, downloaded whole, opened once here, and only then
//   named by its local copy, in the same transaction that records it. Opening it first is what Windows needs: the
//   first open of a file just written waited 6 to 15s, and a statement must not be the one that waits.
// - **A copy no table reads any more goes, slowly.** A commit that removes a file ends it in the lake; its copy is
//   deleted once nothing has needed it for `graceMs`, since a statement that started before keeps the paths it
//   started with and may yet open it.
// - **A file a table still reads stays,** unless what is held would go past `maxBytes`. Then the least recently
//   read is named by its OneLake path again, and its copy goes the same slow way.
//
// The unit is a file. A table is never fetched whole by this: a file comes down because a statement opened it.
// No `vscode` import. The engine passes in its connection, the token and how to download.
// =============================================================================

const { mkdirSync, renameSync, rmSync, openSync, readSync, closeSync, statSync, createWriteStream } = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { readdir } = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');
const { dirname, join } = require('node:path');
const { sqlStr: q, assertOneLakeUrl } = require('../sql');
const { META, rows } = require('./onelaketable');

const HELD = `${META}.studio_held`;
// What is held here, by the path the lake gave a file before its copy came, on connection `c`.
const heldOn = async c => new Map((await rows(c, `SELECT path, local FROM ${HELD} WHERE unread_since IS NULL`)).map(r => [r.path, r.local]));

// abfss://<workspace>@<host>/<rest> -> https://<host>/<workspace>/<rest>, which a GET reads. Only OneLake's
// host: the GET carries the token, and the path is one a table's metadata named.
function httpsOf(url) {
  const m = /^abfss?:\/\/([^@/]+)@([^/]+)\/(.+)$/.exec(url);
  if (!m) throw new Error(`not a OneLake path: ${url}`);
  assertOneLakeUrl(url);
  // Each part of the path as a URL writes it. The lake holds a file's own name (onelaketable.js decodes a Delta
  // log's), and a name with a # or a ? in it would otherwise end the path there, and one with %41 would ask for A.
  return `https://${m[2]}/${encodeURIComponent(m[1])}/${m[3].split('/').map(encodeURIComponent).join('/')}`;
}
// Where a file's copy goes: its workspace, item and folders kept, so a Delta partition's col=value folder is in
// the copy's path as DuckLake reads it.
function localOf(filesDir, url) {
  const m = /^abfss?:\/\/([^@/]+)@[^/]+\/(.+)$/.exec(url);
  // No part may climb out of filesDir: not the workspace's either, and not by a backslash, which Windows reads
  // as a folder.
  if (!m || url.includes('\\') || [m[1], ...m[2].split('/')].some(p => p === '..' || p === '.')) throw new Error(`not a OneLake path: ${url}`);
  assertOneLakeUrl(url);
  return join(filesDir, m[1], ...m[2].split('/')).replace(/\\/g, '/');
}

/**
 * @param {object} o
 * @param {(fn: (c) => Promise<any>) => Promise<any>} o.withConn  runs fn on the engine's own connection, in turn
 * @param {string} o.filesDir   the folder copies go in, inside what the engine may read
 * @param {(url: string, dst: string) => Promise<number>} o.download  writes the whole file at url to dst, its bytes
 * @param {number} [o.maxBytes]  what all copies may take together
 * @param {number} [o.parallel]
 * @param {number} [o.graceMs]   how long a copy no table reads waits before it is deleted
 * @param {() => number} [o.now]
 * @param {(line: string) => void} [o.log]
 */
// Downloads at once: OneLake's throughput is what is waited for, and six at once measured about twice as fast as one
// (docs/CATALOG.md).
const PARALLEL = 6;
// A download that failed where a second try can mend it waits this long, and is tried once more.
const RETRY_MS = 1000;
// How long a download may go with no bytes arriving before it is taken for dead.
const DOWNLOAD_IDLE_MS = 2 * 60 * 1000;

function createTableService({ withConn, filesDir, download, maxBytes = 10 * 1024 ** 3, parallel = PARALLEL,
                              graceMs = 15 * 60 * 1000, now = Date.now, log = () => {} }) {
  const queued = new Map();   // OneLake URL -> its expected size
  const busy = new Set();
  let ready = null, closed = false;
  // The bytes of the downloads under way: not held yet, and on the disk already or about to be. Counted with
  // what is held, or `parallel` downloads would each find the same room and take it.
  let coming = 0;
  // When a copy was read, strictly increasing: two reads in one millisecond still have an order to evict by.
  let lastStamp = 0;
  const stamp = () => (lastStamp = Math.max(now(), lastStamp + 1));
  const counts = { downloaded: 0, bytes: 0, swapped: 0, missed: 0, evicted: 0, deleted: 0, failed: 0 };

  const init = () => ready || (ready = withConn(c => c.run(`CREATE TABLE IF NOT EXISTS ${HELD} (
    local VARCHAR PRIMARY KEY, path VARCHAR, relative BOOLEAN, bytes BIGINT, last_read BIGINT, unread_since BIGINT)`)).then(sweepParts));
  // A download a process didn't live to finish left its .part: no table names it, so nothing would ever count it
  // or delete it. Before this process's first download, when none of them can be one of its own. Not a copy that
  // is held, whatever its name ends in. Listed off the event loop: the folder can hold a great many files.
  async function sweepParts() {
    let names = [];
    try { names = await readdir(filesDir, { recursive: true }); } catch (_) { return; }
    const parts = names.map(String).filter(n => n.endsWith('.part'));
    if (!parts.length) return;
    const held = new Set((await withConn(c => rows(c, `SELECT local FROM ${HELD}`))).map(r => String(r.local).toLowerCase()));
    let gone = 0;
    for (const name of parts) {
      const file = join(filesDir, name).replace(/\\/g, '/');
      if (held.has(file.toLowerCase())) continue;
      try { rmSync(file, { force: true }); gone++; } catch (_) {}
    }
    if (gone) log(`table service: ${gone} unfinished download(s) from before deleted`);
  }

  // What the lake reads from OneLake now, by full URL: of every table, or of lake table `name`.
  async function remoteFiles(c, name = null) {
    return rows(c, `SELECT f.data_file_id AS id, f.path, f.path_is_relative AS relative, f.file_size_bytes AS size,
        CASE WHEN f.path_is_relative THEN t.path || f.path ELSE f.path END AS url
      FROM ${META}.ducklake_data_file f JOIN ${META}.ducklake_table t ON t.table_id = f.table_id AND t.end_snapshot IS NULL
      WHERE f.end_snapshot IS NULL AND (f.path_is_relative OR f.path LIKE 'abfs%')${name == null ? '' : ` AND t.table_name = ${q(name)}`}`);
  }

  /** The paths statements opened, as DuckDB's FileSystem log names them. */
  async function noteOpened(paths) {
    if (closed || !paths.length) return;
    await init();
    const remote = paths.filter(p => /^abfss?:\/\//.test(p)), local = paths.filter(p => !/^[a-z]+:\/\//i.test(p));
    await withConn(async c => {
      if (local.length) {
        const mine = local.map(p => p.replace(/\\/g, '/'));
        await c.run(`UPDATE ${HELD} SET last_read = ${stamp()} WHERE lower(local) IN (${mine.map(p => q(p.toLowerCase())).join(', ')})`);
      }
      if (!remote.length) return;
      const wanted = new Set(remote);
      for (const f of await remoteFiles(c)) if (wanted.has(f.url) && !queued.has(f.url) && !busy.has(f.url)) queued.set(f.url, Number(f.size));
    });
    pump();
  }

  function pump() {
    while (!closed && busy.size < parallel && queued.size) {
      const [url, size] = queued.entries().next().value;
      // One too big to keep at all is never fetched: out of the queue, so it holds nothing up behind it.
      if (size > maxBytes) { queued.delete(url); continue; }
      // The downloads under way would fill the cache by themselves: this one waits for one of them to land.
      if (busy.size && coming + size > maxBytes) break;
      queued.delete(url);
      busy.add(url);
      // Its bytes are spoken for from here, before anything is asked: the next file in this loop counts them.
      let mine = size > maxBytes ? 0 : size;
      coming += mine;
      const landed = () => { coming -= mine; mine = 0; };
      fetchOne(url, size, landed).catch(e => { counts.failed++; log(`table service: ${url} not kept: ${e.message}`); })
        .finally(() => { landed(); busy.delete(url); pump(); });
    }
  }

  // `landed`: called once the file is held, in the same turn, so its bytes are never counted twice.
  async function fetchOne(url, size, landed) {
    if (size > maxBytes) return;
    const local = localOf(filesDir, url), part = `${local}.part`;
    await makeRoom();
    mkdirSync(dirname(local), { recursive: true });
    let got;
    // Whatever stopped it, what came so far is not left here: nothing would ever name it.
    // (A file Windows still holds can't be deleted yet: the error that stopped the download is the one to say.)
    const drop = () => { try { rmSync(part, { force: true }); } catch (_) {} };
    try { got = await download(url, part); }
    catch (e) { drop(); throw e; }
    if (got !== size) { drop(); throw new Error(`${got} bytes, the table says ${size}`); }
    renameSync(part, local);
    // Opened once, as DuckDB will, before anything reads it from here.
    const fd = openSync(local, 'r');
    const tail = Buffer.alloc(4);
    try { readSync(fd, tail, 0, 4, size - 4); } finally { closeSync(fd); }
    // Not left here under a name the lake could come to read.
    if (tail.toString('latin1') !== 'PAR1') { rmSync(local, { force: true }); throw new Error('not a Parquet file'); }
    counts.downloaded++; counts.bytes += size;
    const swapped = await withConn(async c => {
      await c.run('BEGIN');
      try {
        const f = (await remoteFiles(c)).filter(r => r.url === url);
        if (f.length) {
          await c.run(`UPDATE ${META}.ducklake_data_file SET path = ${q(local)}, path_is_relative = false WHERE data_file_id IN (${f.map(r => r.id).join(', ')})`);
          await c.run(`INSERT OR REPLACE INTO ${HELD} VALUES (${q(local)}, ${q(f[0].path)}, ${f[0].relative}, ${size}, ${stamp()}, NULL)`);
        }
        await c.run('COMMIT');
        if (f.length) landed();
        return f.length > 0;
      } catch (e) { await c.run('ROLLBACK').catch(() => {}); throw e; }
    });
    if (swapped) counts.swapped++;
    else { counts.missed++; rmSync(local, { force: true }); }   // a commit removed it while it came down
  }

  // Under maxBytes, with the downloads under way counted (this one among them): the least recently read copies
  // go back to their OneLake paths.
  async function makeRoom() {
    await withConn(async c => {
      const held = await rows(c, `SELECT local, path, relative, bytes FROM ${HELD} WHERE unread_since IS NULL ORDER BY last_read`);
      let total = held.reduce((n, h) => n + Number(h.bytes), 0) + coming;
      for (const h of held) {
        if (total <= maxBytes) break;
        await evict(c, h);
        total -= Number(h.bytes);
      }
    });
  }
  async function evict(c, h) {
    await c.run('BEGIN');
    try {
      await c.run(`UPDATE ${META}.ducklake_data_file SET path = ${q(h.path)}, path_is_relative = ${h.relative} WHERE path = ${q(h.local)} AND end_snapshot IS NULL`);
      await c.run(`UPDATE ${HELD} SET unread_since = ${now()} WHERE local = ${q(h.local)}`);
      await c.run('COMMIT');
      counts.evicted++;
    } catch (e) { await c.run('ROLLBACK').catch(() => {}); throw e; }
  }

  /** The slow pass: copies no live file names are marked, and deleted once past the grace. */
  async function tidy() {
    if (closed) return;
    await init();
    const gone = await withConn(async c => {
      await c.run(`UPDATE ${HELD} SET unread_since = ${now()} WHERE unread_since IS NULL AND NOT EXISTS (
        SELECT 1 FROM ${META}.ducklake_data_file f WHERE f.path = ${HELD}.local AND f.end_snapshot IS NULL)`);
      // One a commit named again (the same file, new deletes) is live again.
      await c.run(`UPDATE ${HELD} SET unread_since = NULL WHERE unread_since IS NOT NULL AND EXISTS (
        SELECT 1 FROM ${META}.ducklake_data_file f WHERE f.path = ${HELD}.local AND f.end_snapshot IS NULL)`);
      return rows(c, `SELECT local FROM ${HELD} WHERE unread_since IS NOT NULL AND unread_since <= ${now() - graceMs}`);
    });
    for (const { local } of gone) {
      try { rmSync(local, { force: true }); } catch (e) { log(`table service: ${local} stays for now: ${e.message}`); continue; }
      await withConn(c => c.run(`DELETE FROM ${HELD} WHERE local = ${q(local)}`));
      counts.deleted++;
    }
  }

  /** What is held here, by the path the lake gave a file before its copy came: for syncTable. */
  async function held() {
    await init();
    return withConn(heldOn);
  }

  /**
   * Every file of lake table `name` still on OneLake, brought here whole, as a statement's would be: for a table
   * someone asked to have here (Keep offline, Download for offline). Resolves once none of them is queued or coming
   * down, with how many are still on OneLake (a failed download, or one too big for the cache).
   */
  const asked = new Map();   // lake table -> its files' URLs, while fetchTable waits on them
  async function fetchTable(name) {
    await init();
    const files = await withConn(c => remoteFiles(c, name));
    const urls = new Set(files.map(f => f.url));
    asked.set(name, urls);
    for (const f of files) if (!queued.has(f.url) && !busy.has(f.url)) queued.set(f.url, Number(f.size));
    pump();
    try {
      while (!closed && [...urls].some(u => queued.has(u) || busy.has(u))) await new Promise(r => setTimeout(r, 200));
    } finally { if (asked.get(name) === urls) asked.delete(name); }
    const left = await withConn(c => remoteFiles(c, name));
    return { files: files.length, bytes: files.reduce((n, f) => n + Number(f.size), 0), left: left.length };
  }
  /** fetchTable(name) stopped: its files not started yet are left on OneLake. */
  function stopTable(name) {
    const urls = asked.get(name);
    if (urls) for (const u of urls) queued.delete(u);
  }

  async function idle() {
    while (queued.size || busy.size) await new Promise(r => setTimeout(r, 20));
  }

  async function stats() {
    await init();
    const [h] = await withConn(c => rows(c, `SELECT count(*) FILTER (WHERE unread_since IS NULL)::INTEGER AS files,
      coalesce(sum(bytes) FILTER (WHERE unread_since IS NULL), 0)::BIGINT AS bytes, count(*) FILTER (WHERE unread_since IS NOT NULL)::INTEGER AS going FROM ${HELD}`));
    return { ...counts, queued: queued.size, busy: busy.size, held: Number(h.files), heldBytes: Number(h.bytes), going: Number(h.going) };
  }

  return { noteOpened, fetchTable, stopTable, tidy, held, idle, stats, close() { closed = true; queued.clear(); } };
}

/**
 * A download over HTTPS with a bearer token: the whole file, written to dst as it arrives, so a large file is
 * never held whole in memory and the engine's process isn't stopped for one write. Tried once more when the
 * connection or the server failed; a refusal (a 4xx but 429) is final.
 */
function httpsDownload({ getToken, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), idleMs = DOWNLOAD_IDLE_MS }) {
  const once = async (url, dst) => {
    // No answer, or no more bytes, for `idleMs`: the download is over. A file's size says nothing of how long it
    // takes, so there is no limit on the whole; one that stopped arriving would otherwise hold its place for good.
    const quiet = new AbortController();
    const stalled = () => new Error(`no data moved for ${Math.round(idleMs / 1000)}s while a file came from OneLake`);
    const waiting = setTimeout(() => quiet.abort(stalled()), idleMs);
    let res;
    try {
      const gaveUp = new Promise((_, reject) => quiet.signal.addEventListener('abort', () => reject(quiet.signal.reason), { once: true }));
      gaveUp.catch(() => {});
      res = await Promise.race([gaveUp,
        fetchImpl(httpsOf(url), { headers: { Authorization: `Bearer ${await getToken()}`, 'x-ms-version': '2023-11-03' }, signal: quiet.signal })]);
    } catch (e) { throw quiet.signal.aborted ? quiet.signal.reason : e; }
    finally { clearTimeout(waiting); }
    if (!res.ok) {
      // Its body is not read: let go of, so the connection is.
      if (res.body) res.body.cancel().catch(() => {});
      throw Object.assign(new Error(`OneLake answered ${res.status}`), { status: res.status });
    }
    try {
      await pipeline(Readable.fromWeb(res.body), idleWatch(idleMs, () => { const e = stalled(); quiet.abort(e); return e; }), createWriteStream(dst));
    } catch (e) {
      try { rmSync(dst, { force: true }); } catch (_) {}
      throw e;
    }
    return statSync(dst).size;
  };
  return async (url, dst) => {
    try { return await once(url, dst); }
    catch (e) {
      if (e.status && e.status !== 429 && e.status < 500) throw e;
      await sleep(RETRY_MS);
      return once(url, dst);
    }
  };
}

// Bytes passed on as they come, and the stream ended with onIdle's error when none came for `ms`.
function idleWatch(ms, onIdle) {
  let timer = null;
  const watch = new Transform({
    transform(chunk, _enc, done) { arm(); done(null, chunk); },
    flush(done) { clearTimeout(timer); done(); },
    destroy(e, done) { clearTimeout(timer); done(e); },
  });
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => watch.destroy(onIdle()), ms); };
  arm();
  return watch;
}

// The paths statements opened since `sinceUs`, from DuckDB's FileSystem log.
async function openedSince(c, sinceUs) {
  const r = await rows(c, `SELECT epoch_us(timestamp) AS us, regexp_extract(message, '"path":"((?:[^"\\\\]|\\\\.)*)"', 1) AS path
    FROM duckdb_logs WHERE type = 'FileSystem' AND message LIKE '%"op":"OPEN"%' AND epoch_us(timestamp) > ${Number(sinceUs)} ORDER BY timestamp`);
  return { paths: [...new Set(r.map(x => x.path.replace(/\\\\/g, '\\')))], lastUs: r.length ? Number(r[r.length - 1].us) : sinceUs };
}

module.exports = { createTableService, httpsDownload, openedSince, heldOn, httpsOf, localOf };
