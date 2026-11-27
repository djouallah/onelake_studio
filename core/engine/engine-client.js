'use strict';
// =============================================================================
// engine-client.js — a window's side of the shared engine
// =============================================================================
// DuckDB runs in a process of its own (engine-server.js),
// one per account, and every window is a client of it over Quack. So every tab of every window
// shares one memory budget and one set of cached blocks, and the engine outlives a window.
//
// A window holds two things:
//   a control socket   an OS pipe to the server, authenticated with the session token. It says
//                      the window is alive: when it closes the server cancels that window's
//                      queries, and with no window left the server exits.
//   a small DuckDB     with no data, only the Quack client. Every statement goes through it, by a
//                      pool of attaches (openClient), so any number run at once and sockets are
//                      reused.
//
// THE SESSION TOKEN. A new random one per server. It is kept in VS Code's secret storage so the
// next window finds it, and reaches the server over its stdin, never a command line or a file.
// In this DuckDB it is a named secret, since an ATTACH's TOKEN option shows in duckdb_databases().
//
// STOP. interrupt() doesn't reach a query on the server. Each statement carries a tag in a comment,
// the server lists running statements with their text, and quack_cancel stops the one tagged.
//
// No `vscode` import: the extension passes in what it needs from the editor.
// =============================================================================

const net = require('node:net');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { join, isAbsolute } = require('node:path');
const { DuckDBInstance } = require('@duckdb/node-api');
const { sqlStr } = require('../sql');
const { shortHash } = require('../onelake/catalogfile');
const { logFileOf } = require('../logfile');

const CONNECT_MS = 5_000;
const BOOT_MS = 180_000;       // a first boot may be downloading its extensions
const LOCK_STALE_MS = 200_000;
const TOKEN_LOST_MS = 90_000;  // longer than a server waits with no window left
const CANCEL_TRIES = 20;
const HELLO_TRIES = 3;         // a just-started server that dropped a late hello
const CANCEL_EVERY_MS = 100;   // a Stop can land before the statement reaches the server
const MAX_ATTACHES = 8;

const sleep = ms => new Promise(r => setTimeout(r, ms));
// How often a window asks its server whether it is there, and how long it waits for the answer.
const PING_EVERY_MS = 20_000;
const PING_WAIT_MS = 30_000;

/**
 * Asks `check()` every `everyMs`; one that hasn't answered in `waitMs` is a miss, and `misses` of them in a row
 * call `onStuck()` once. A check that fails at once isn't a miss: something answered. Gives back stop().
 * A server whose loop or DuckDB stopped answering was waited on for ever, by every window.
 */
// `stuck`, when given, has the last word after the misses: false, and they count again from none.
function watchdog({ check, onStuck, everyMs, waitMs, misses = 2, stuck = () => true }) {
  let missed = 0, busy = false, done = false;
  const timer = setInterval(async () => {
    if (busy || done) return;
    busy = true;
    let timeout;
    const late = new Promise(r => { timeout = setTimeout(() => r('late'), waitMs); });
    try {
      const got = await Promise.race([Promise.resolve().then(check).then(() => 'ok', () => 'ok'), late]);
      missed = got === 'late' ? missed + 1 : 0;
      if (missed >= misses && !done) {
        if (!stuck()) missed = 0;
        else { done = true; clearInterval(timer); onStuck(); }
      }
    } finally { clearTimeout(timeout); busy = false; }
  }, everyMs);
  if (timer.unref) timer.unref();
  return () => { done = true; clearInterval(timer); };
}
const slash = p => String(p).replace(/\\/g, '/');

// Named after the user and `key` (the account and this build), so another account or build gets
// its own server. Only this user can write to it, and the token is asked for regardless.
function pipePath(key) {
  const id = crypto.createHash('sha256').update(`${os.userInfo().username}|${key}`).digest('hex').slice(0, 24);
  if (process.platform === 'win32') return `\\\\.\\pipe\\onelake-engine-${id}`;
  // In this user's runtime folder where there is one (Linux), which nobody else can open: /tmp is everyone's.
  // The server is this process's child, so both read the same XDG_RUNTIME_DIR.
  const runtime = process.env.XDG_RUNTIME_DIR;
  const mine = runtime && isAbsolute(runtime) && (() => { try { return fs.statSync(runtime).isDirectory(); } catch (_) { return false; } })();
  return join(mine ? runtime : os.tmpdir(), `onelake-engine-${id}.sock`);
}

// The control socket, signed in, and what the server says of itself; null if nobody answers or
// the token is refused. A server still booting answers once it is up, so `waitMs` is long enough
// for a boot once something has answered the connect.
// `why.reason`, when it answers null: how it failed, for an error that has to say.
function connectControl(path, token, window, waitMs = BOOT_MS, why = {}) {
  return new Promise(resolve => {
    const sock = net.connect(path);
    let buf = '', settled = false, connectedAt = 0;
    const done = (v, reason) => { clearTimeout(timer); if (!settled && v == null) why.reason = reason; settled = true; resolve(v); };
    // Dropped: the server let go of a connection it had taken, before any answer. One that was up says so
    // when a hello reaches it late (engine-server.js HELLO_MS), and takes the next.
    const lost = what => {
      if (!settled && connectedAt && !buf) why.dropped = true;
      done(null, connectedAt ? `${what}, ${((Date.now() - connectedAt) / 1000).toFixed(1)}s after it connected` : what);
    };
    let timer = setTimeout(() => { sock.destroy(); done(null, `no connection to its pipe in ${CONNECT_MS / 1000}s`); }, CONNECT_MS);
    sock.setEncoding('utf8');
    sock.on('error', e => lost(`its pipe: ${e.code || e.message}`));
    sock.on('close', () => lost(buf ? 'it closed the pipe after answering' : 'it closed the pipe before answering'));
    sock.on('connect', () => {
      connectedAt = Date.now();
      clearTimeout(timer);
      timer = setTimeout(() => { sock.destroy(); done(null, `no answer in ${waitMs / 1000}s`); }, waitMs);
      sock.write(`${JSON.stringify({ token, window })}\n`);
    });
    const onData = chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      sock.off('data', onData);
      // Held until controlChannel listens: news the server sends meanwhile, and what came after the
      // hello in this chunk (`rest`), are its to read.
      sock.pause();
      let state = null;
      try { state = JSON.parse(buf.slice(0, nl)); } catch (_) {}
      if (state && state.ok) done({ sock, state, rest: buf.slice(nl + 1) });
      else { sock.destroy(); done(null, `it answered ${buf.slice(0, nl).slice(0, 300)}`); }
    };
    sock.on('data', onData);
  });
}

// Whether anything is listening there.
const pipeHeld = path => new Promise(resolve => {
  const sock = net.connect(path);
  sock.once('connect', () => { sock.destroy(); resolve(true); });
  sock.once('error', () => resolve(false));
});

// One window at a time gets to start the server.
async function withLock(file, fn) {
  const deadline = Date.now() + BOOT_MS;
  for (;;) {
    try {
      const h = await fsp.open(file, 'wx');
      await h.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const st = await fsp.stat(file).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) { await fsp.rm(file, { force: true }).catch(() => {}); continue; }
      if (Date.now() > deadline) throw new Error('another window is still starting the engine');
      await sleep(200);
    }
  }
  try { return await fn(); }
  finally { await fsp.rm(file, { force: true }).catch(() => {}); }
}

// The server's process: detached, so it outlives this window. execPath is the editor's Electron,
// which runs as plain Node with this variable set.
function spawnServer({ script, token, pipe, options, logFile, idleMs, logsFile, build }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`the engine did not start in ${BOOT_MS / 1000}s`)); }, BOOT_MS);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`the engine exited as it started (code ${code}): see ${logFile}`)); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      child.removeAllListeners('exit');
      child.stdout.destroy();
      child.unref();
      let said = {};
      try { said = JSON.parse(buf.slice(0, nl)); } catch (_) {}
      if (said.error) reject(new Error(`the engine could not start: ${said.error}`));
      else resolve(said);
    });
    child.stdin.end(`${JSON.stringify({ token, pipe, options, logFile, idleMs, logsFile, build })}\n`);
  });
}

// The running server for this key, started if there is none.
// The last lines of a server's log, or what kept them from being read.
function logTail(file, bytes = 2048) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(bytes, size));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      return buf.toString('utf8').split('\n').slice(size > bytes ? 1 : 0).join('\n').trim();
    } finally { fs.closeSync(fd); }
  } catch (e) { return `(${e.message})`; }
}

async function acquire({ pipe, window, getToken, setToken, lockFile, server }) {
  const known = await getToken();
  if (known) {
    const up = await connectControl(pipe, known, window);
    if (up) return { ...up, token: known };
  }
  return withLock(lockFile, async () => {
    // Another window may have started it while this one waited.
    const now = await getToken();
    if (now) {
      const up = await connectControl(pipe, now, window);
      if (up) return { ...up, token: now };
    }
    const token = crypto.randomBytes(32).toString('hex');
    await setToken(token);
    // A server just told to stop may hold the pipe a moment more. One whose token is lost (the
    // editor's secret storage was emptied, say) can't be told anything, and holds it until it goes
    // idle: this window waits for that.
    const deadline = Date.now() + TOKEN_LOST_MS;
    let said = await spawnServer({ ...server, token, pipe });
    while (said.taken && Date.now() < deadline) {
      await sleep(500);
      if (!await pipeHeld(pipe)) said = await spawnServer({ ...server, token, pipe });
    }
    if (said.taken) throw new Error('an engine with another session is still running: try again in a minute');
    // The server has said it is ready, so one that drops this window's hello took it too late (a loop held
    // up on either side): it takes the next.
    const until = Date.now() + BOOT_MS;
    let why = {};
    let up = await connectControl(pipe, token, window, BOOT_MS, why);
    for (let i = 0; !up && why.dropped && i < HELLO_TRIES && Date.now() < until; i++) {
      await sleep(200);
      why = {};
      up = await connectControl(pipe, token, window, Math.max(1, until - Date.now()), why);
    }
    // How the connection failed, and what the server said of itself, its log's last lines: why it went, or what it was doing.
    if (!up) throw new Error(`the engine started and then refused this window (${why.reason}). Its log ends:\n${logTail(server.logFile)}`);
    return { ...up, token };
  });
}

// DuckDB's error says where in OUR wrapper it failed too. The statement's own message comes
// first, so the wrapper's part and the tag go.
function clean(e) {
  if (!e || typeof e.message !== 'string') throw e;
  const message = e.message
    .replace(/\s*LINE \d+: SELECT \* FROM (?:quack_query|[rt]\d+\.query)\([\s\S]*$/, '')
    .replace(/\s*\/\*onelake:[^*]*\*\//g, '');
  if (message !== e.message) {
    try { e.message = message; } catch (_) { throw Object.assign(new Error(message), { cancelled: e.cancelled }); }
  }
  throw e;
}

async function loadExtension(conn, ext, { bundledExtensions }) {
  const shipped = bundledExtensions && join(bundledExtensions, `${ext}.duckdb_extension`);
  if (shipped && fs.existsSync(shipped)) {
    try { await conn.run(`LOAD ${sqlStr(slash(shipped))};`); return; } catch (_) { /* try the repository */ }
  }
  try { await conn.run(`LOAD ${ext};`); }
  catch (_) { await conn.run(`INSTALL ${ext}; LOAD ${ext};`); }
}

/**
 * A DuckDB with no data and the Quack client, signed in to one server. `control` is a catalog
 * attached only so quack_cancel has something to name; statements don't go through it, since one
 * attach runs one statement at a time.
 */
async function openClient({ uri, token, extensionDir, bundledExtensions, lockdown = true }) {
  const local = await DuckDBInstance.create(':memory:', {
    allow_persistent_secrets: 'false', threads: '2', memory_limit: '1GB',
    ...(extensionDir ? { extension_directory: extensionDir } : {}),
  });
  const admin = await local.connect();
  await loadExtension(admin, 'httpfs', { bundledExtensions });
  await loadExtension(admin, 'quack', { bundledExtensions });
  // DuckDB takes its proxy from the environment too, and this is the same machine.
  await admin.run(`SET http_proxy = '';`).catch(() => {});
  await admin.run(`CREATE SECRET studio (TYPE quack, TOKEN ${sqlStr(token)}, SCOPE ${sqlStr(uri)});`);
  await admin.run(`ATTACH ${sqlStr(uri)} AS control (TYPE quack, SECRET studio);`);
  if (lockdown) {
    // The same lockdown as the server's, with one way out: the server.
    const url = `http://${uri.replace(/^quack:/, '')}/`;
    await admin.run(`SET allowed_directories = [${sqlStr(url)}]; SET enable_external_access = false; SET lock_configuration = true;`);
  }
  const query = sql => `SELECT * FROM quack_query(${sqlStr(uri)}, ${sqlStr(sql)})`;

  // How a statement goes: through an attach, whose socket stays open. quack_query opens a new socket
  // each time, about 10ms, and at hundreds a second Windows runs out of ports. One attach runs one
  // statement (a second cancels the first), so there are several, added as they are needed. With
  // all of them busy a statement doesn't wait: it goes by quack_query, and the next attach is on its way.
  const attaches = [];
  let growing = false, closed = false, named = 0;
  function grow() {
    if (growing || closed || attaches.length >= MAX_ATTACHES) return;
    growing = true;
    const name = `r${named++}`;
    (async () => {
      const c = await local.connect();
      try { await c.run(`ATTACH ${sqlStr(uri)} AS ${name} (TYPE quack, SECRET studio);`); }
      finally { try { c.closeSync(); } catch (_) {} }
      attaches.push({ name, busy: false });
    })().catch(() => {}).finally(() => { growing = false; });
  }
  grow();
  // The text to run `sql`, and what gives back what it took.
  function route(sql) {
    const free = attaches.find(a => !a.busy);
    if (!free) { grow(); return { text: query(sql), release() {}, retire() {} }; }
    free.busy = true;
    return {
      text: `SELECT * FROM ${free.name}.query(${sqlStr(sql)})`,
      release() { free.busy = false; },
      // After a Stop. Its reads on the server take time to wind down, and a statement sent down the
      // same connection before they have waited on them, about 80s measured, then failed as
      // interrupted itself. So it isn't used again: the next statement gets a connection of its own.
      retire() {
        // A reattach may have emptied the pool under it: -1 would take the newest one out instead.
        const at = attaches.indexOf(free);
        if (at >= 0) attaches.splice(at, 1);
        (async () => {
          const c = await local.connect();
          try { await c.run(`DETACH ${free.name};`); }
          finally { try { c.closeSync(); } catch (_) {} }
        })().catch(() => {});
        grow();
      },
    };
  }
  const stopGrowing = () => { closed = true; };
  // After the server's listener was started again: what was attached knows a session it has lost.
  async function reattach() {
    const c = await local.connect();
    try {
      for (const a of attaches.splice(0)) await c.run(`DETACH ${a.name};`).catch(() => {});
    } finally { try { c.closeSync(); } catch (_) {} }
    await reattachControl();
    grow();
  }

  // The running statements whose tag starts with `tag`. The tag is built at run time, or this
  // statement, which holds it too, would find itself.
  async function listTagged(tag) {
    const c = await local.connect();
    try {
      const sql = `SELECT connection_id FROM quack_active_connections() WHERE state = 'active' AND query LIKE '%onelake:' || ${sqlStr(`${tag}%`)}`;
      return (await c.runAndReadAll(query(sql))).getRowObjectsJson().map(r => r.connection_id);
    } finally { try { c.closeSync(); } catch (_) {} }
  }
  // A failure is the caller's to see: a Stop that didn't reach anything must not look as if it had.
  async function cancelIds(ids) {
    const c = await local.connect();
    try {
      for (const id of ids) await c.run(`SELECT * FROM quack_cancel('control', ${sqlStr(id)});`);
    } finally { try { c.closeSync(); } catch (_) {} }
  }
  // Only what Stop goes through: a pool's attaches may have statements running on them.
  async function reattachControl() {
    const c = await local.connect();
    try {
      await c.run('DETACH control;').catch(() => {});
      await c.run(`ATTACH ${sqlStr(uri)} AS control (TYPE quack, SECRET studio);`);
    } finally { try { c.closeSync(); } catch (_) {} }
  }
  // An attach of a tab's own: one server session, which keeps what DuckDB keeps on a connection (SET VARIABLE, TEMP
  // tables and views) from one statement to the next. Its statements are sent one at a time (engine-host.js session).
  async function dedicated() {
    const name = `t${named++}`;
    const c = await local.connect();
    try { await c.run(`ATTACH ${sqlStr(uri)} AS ${name} (TYPE quack, SECRET studio);`); }
    finally { try { c.closeSync(); } catch (_) {} }
    return {
      text: sql => `SELECT * FROM ${name}.query(${sqlStr(sql)})`,
      async detach() {
        const d = await local.connect();
        try { await d.run(`DETACH ${name};`); }
        catch (_) { /* gone with the server's listener */ }
        finally { try { d.closeSync(); } catch (_) {} }
      },
    };
  }
  return { local, admin, route, dedicated, stopGrowing, reattach, reattachControl, listTagged, cancelIds };
}

// Lines from a stream's text, in time linear in its length: each chunk is searched once, and a line
// is joined from its pieces once it ends. An answer of tens of MB comes in thousands of
// chunks, and searching all of it again at each one froze the extension host for seconds.
// `maxLine()` is the longest line taken, asked at each chunk since it can change (the server's is short until a
// connection has said who it is). Past it nothing more is read and `onTooLong` is called once: what was held is
// let go, so a line that never ends costs no more memory than the limit.
function lineReader(onLine, { maxLine = () => Infinity, onTooLong = () => {} } = {}) {
  let pieces = [], held = 0, over = false;
  const tooLong = () => { over = true; pieces = []; held = 0; onTooLong(); };
  return chunk => {
    if (over) return;
    let from = 0;
    for (let nl; (nl = chunk.indexOf('\n', from)) >= 0; from = nl + 1) {
      if (held + (nl - from) > maxLine()) return tooLong();
      pieces.push(chunk.slice(from, nl));
      const line = pieces.length === 1 ? pieces[0] : pieces.join('');
      pieces = []; held = 0;
      onLine(line);
      if (over) return;
    }
    if (from < chunk.length) {
      held += chunk.length - from;
      if (held > maxLine()) return tooLong();
      pieces.push(chunk.slice(from));
    }
  };
}

// Questions on the control pipe, answered by id. A line with no id is the server's own news.
function controlChannel(sock, onNews = () => {}, rest = '') {
  const asked = new Map();
  let seq = 0;
  const read = lineReader(line => {
    let m = null;
    try { m = JSON.parse(line); } catch (_) {}
    if (m && m.id == null) { onNews(m); return; }
    const waiting = m && asked.get(m.id);
    if (!waiting) return;
    asked.delete(m.id);
    if (m.error) waiting.reject(new Error(m.error)); else waiting.resolve(m.value);
  });
  read(rest);
  sock.on('data', read);
  sock.resume();
  sock.on('close', () => {
    for (const w of asked.values()) w.reject(new Error('the engine stopped'));
    asked.clear();
  });
  return msg => new Promise((resolve, reject) => {
    if (sock.destroyed) { reject(new Error('the engine stopped')); return; }
    const id = ++seq;
    asked.set(id, { resolve, reject });
    sock.write(`${JSON.stringify({ id, ...msg })}\n`);
  });
}

// A statement that can't reach the server although the pipe to it is fine. The server's listener can
// stop while its process lives on, and an attach outlives the session it knew. Asked over the pipe,
// the server starts its listener again if it has to, and what was attached is attached again: once,
// however many statements noticed.
//
// Every window is told when that happens. An attach whose socket is still open goes on being answered
// by the listener that was stopped, where a statement runs and nothing can find it to Stop it, so
// waiting to notice isn't enough.
const LOST = /Could not connect to server|Invalid connection id/;
function recovery(ask, client) {
  let going = null;
  return () => {
    if (!going) {
      going = (async () => {
        await ask({ listen: {} });
        await client.reattach();
      })().finally(() => { going = null; });
    }
    return going;
  };
}

// Which install's server holds a lake: written by the window that joins it, before it starts one. A lake is
// one account's, and open in one process only, but a server is one install's (`key`): after an update the new
// install can't find the old one's server by its own key, and that server still holds the lake.
const holderFileOf = (stateDir, lakeKey) => join(stateDir, `server-${shortHash(lakeKey)}.json`);
function serverHolder({ stateDir, lakeKey }) {
  try {
    const v = JSON.parse(fs.readFileSync(holderFileOf(stateDir, lakeKey), 'utf8'));
    return v && typeof v.key === 'string' ? { key: v.key, version: String(v.version || '') } : null;
  } catch (_) { return null; }
}
async function claimLake({ stateDir, lakeKey, key, version }) {
  // A name of its own: two windows of one process (a window and its background reader) claim at once.
  const file = holderFileOf(stateDir, lakeKey), partial = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(partial, JSON.stringify({ key, version }));
  // On Windows a rename onto a file another window is renaming or reading at that moment fails (EPERM,
  // EACCES, EBUSY) and goes through a moment later. Past the tries, a claim another window made the same is
  // this one's too.
  for (let i = 0; ; i++) {
    try { await fsp.rename(partial, file); return; } catch (e) {
      if (i < 8 && ['EPERM', 'EACCES', 'EBUSY'].includes(e && e.code)) { await new Promise(r => setTimeout(r, 25 * (i + 1))); continue; }
      await fsp.rm(partial, { force: true }).catch(() => {});
      const now = serverHolder({ stateDir, lakeKey });
      if (now && now.key === key && now.version === String(version)) return;
      throw e;
    }
  }
}
// 0.2.10 is newer than 0.2.9. A version that can't be read is newer than nothing.
function newerVersion(a, b) {
  const parts = v => String(v || '').split('.').map(n => parseInt(n, 10));
  const x = parts(a), y = parts(b);
  if (x.some(Number.isNaN) || y.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}
const UPDATED = 'OneLake Studio was updated. Reload this window to go on reading tables.';

// This window on the server, started if there is none. A server of another build is told to stop
// and replaced: F5 after a rebuild must not find the old code. So is another install's server that holds
// this lake (`lakeKey`, `tokenOf`), unless that install is the newer one: then this window is the one left
// behind by an update, and it says so (`superseded`).
async function joinServer({ key, stateKey = key, lakeKey = stateKey, version = '', tokenOf = null, script, options, stateDir, build = null, getToken, setToken, idleMs = 60_000 }) {
  await fsp.mkdir(stateDir, { recursive: true });
  const id = shortHash(key);
  const logsFile = logFileOf(stateDir, stateKey);
  const plain = typeof options === 'function' ? await options() : options;
  const held = serverHolder({ stateDir, lakeKey });
  const other = held && held.key !== key && tokenOf && await pipeHeld(pipePath(held.key)) ? held : null;
  if (other && newerVersion(other.version, version)) throw Object.assign(new Error(UPDATED), { superseded: true });
  // Claimed before the other is stopped: its windows read this as they lose it, and know why.
  if (!held || held.key !== key || held.version !== String(version)) await claimLake({ stateDir, lakeKey, key, version: String(version) });
  if (other) await stopServer({ key: other.key, getToken: () => tokenOf(other.key) });
  const asked = {
    pipe: pipePath(key), window: crypto.randomBytes(6).toString('hex'), getToken, setToken,
    lockFile: join(stateDir, `${id}.lock`),
    server: { script, options: plain, logFile: logsFile.replace(/\.sqlite$/, '.log'), idleMs, build, logsFile },
  };
  let joined = await acquire(asked);
  if (joined.state.build !== build) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 5_000);
      joined.sock.once('close', () => { clearTimeout(timer); resolve(); });
      joined.sock.write(`${JSON.stringify({ stop: true })}\n`);
    });
    joined.sock.destroy();
    joined = await acquire(asked);
  }
  return { ...joined, window: asked.window, options: plain };
}

/**
 * Stops this account and install's server if one is running, and starts nothing. A window with only
 * the tree open isn't joined to it, and Sign Out still has to take its token away.
 * @param {{ key: string, getToken: () => Promise<string|undefined> }} o
 */
async function stopServer({ key, getToken }) {
  const pipe = pipePath(key);
  if (!await pipeHeld(pipe)) return;
  const token = await getToken();
  if (!token) return;
  const joined = await connectControl(pipe, token, crypto.randomBytes(6).toString('hex'), CONNECT_MS);
  if (!joined) return;
  joined.sock.resume();
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 5_000);
    joined.sock.once('close', () => { clearTimeout(timer); resolve(); });
    joined.sock.write(`${JSON.stringify({ stop: true })}\n`);
  });
  joined.sock.destroy();
  // Gone, not only told: what it held open (the lake) is free once its process is.
  const pid = joined.state && joined.state.pid;
  const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  for (const until = Date.now() + 10_000; pid && alive() && Date.now() < until;) await sleep(100);
}

/**
 * What engine-host.js takes as `remote`: a function that joins the server and answers something
 * shaped like a DuckDBInstance: connect() and closeSync(), plus capabilities and tmpDir.
 * @param {object} o
 * @param {string} o.key  the account and install this server is for
 * @param {string} [o.stateKey]  what its log file is named after: the account, not the install
 * @param {string} o.script  dist/engine-server.js
 * @param {object|(() => Promise<object>)} o.options  createEngineHost's plain options, for the server's engine
 * @param {string} [o.lakeKey]  what the server's lake belongs to: an account, whatever the install
 * @param {string} [o.version]  this install's version: an older install's server holding the lake is replaced
 * @param {(key: string) => Promise<string|undefined>} [o.tokenOf]  another install's session token, to stop its server
 * @param {string} o.stateDir  for the lock and the server's logs
 * @param {*} [o.build]  which build this is; a server of another is replaced
 * @param {() => Promise<string|undefined>} o.getToken  the session token, from secret storage
 * @param {(t: string) => Promise<void>} o.setToken
 * @param {() => void} [o.onGone]  the server went away under this window
 * @param {number} [o.idleMs]  how long the server waits with no window left
 */
function createRemote({ onGone = () => {}, ...cfg }) {
  return async () => {
    const { sock, state, rest, token, window, options } = await joinServer(cfg);
    // Listened to from here, not once the client is open: that takes seconds, and a reattach said or the
    // server gone meanwhile was lost, with a dead engine left in the window.
    let client = null, closing = false, gone = false, reattachSaid = false;
    sock.on('error', () => {});
    sock.on('close', () => { gone = true; if (!closing && client) onGone(); });
    const ask = controlChannel(sock, m => {
      if (!m.reattach || closing) return;
      if (client) client.reattach().catch(() => {});
      else reattachSaid = true;
    }, rest);
    try {
      client = await openClient({ uri: state.uri, token, extensionDir: options.extensionDir, bundledExtensions: options.bundledExtensions });
    } catch (e) { sock.destroy(); throw e; }
    if (gone) {
      client.stopGrowing();
      try { client.admin.closeSync(); } catch (_) {}
      try { client.local.closeSync(); } catch (_) {}
      throw new Error('the engine stopped');
    }
    if (reattachSaid) client.reattach().catch(() => {});
    const { local, admin, route, dedicated, stopGrowing, reattachControl, listTagged, cancelIds } = client;
    const recover = recovery(ask, client);
    // A server that doesn't answer its pipe has its loop stuck: every statement of every window waits on it, for
    // ever. Two pings with no answer, and it is stopped; this window starts another, as when one goes (onGone).
    const unwatch = options.selfCheck === false ? () => {} : watchdog({
      check: () => ask({ ping: true }), everyMs: PING_EVERY_MS, waitMs: PING_WAIT_MS, misses: 2,
      onStuck: () => {
        if (closing || gone) return;
        try { if (state.pid) process.kill(state.pid); } catch (_) {}
        sock.destroy();
      },
    });

    let seq = 0;
    // Statements can work while `control` is stale: an attach made after the listener came back knows
    // nothing is wrong. So a failed cancel looks again: gone from the list means it finished, and
    // still there means `control` is what's lost.
    async function cancelNow(ids) {
      try { await cancelIds(ids); return true; }
      catch (e) {
        if (!LOST.test(String(e && e.message))) throw e;
        await ask({ listen: {} }).catch(() => {});
        await reattachControl();
        return false;
      }
    }
    async function cancel(tagNow) {
      for (let i = 0; i < CANCEL_TRIES && !closing; i++) {
        const ids = await listTagged(tagNow()).catch(() => []);
        if (ids.length && await cancelNow(ids)) return;
        await sleep(CANCEL_EVERY_MS);
      }
    }

    // A connection of this window's DuckDB whose statements go to the server: `routeOf` says down which attach
    // each one goes. A statement that found the listener gone is sent again once it is back, after `recovered`
    // (a tab's session attaches again there), unless `recovered` says it can't be.
    async function wrap(routeOf, { recovered = async () => {} } = {}) {
      const c = await local.connect();
      let tag = null, way = null, stopped = false;
      const done = () => { if (way) { if (stopped) way.retire(); else way.release(); } way = null; };
      // The tag ends with its comment's close, so statement 1's doesn't also match statement 12.
      const wrapped = sql => {
        done();
        tag = `${window}:${++seq}*/`;
        way = routeOf(`${sql}\n/*onelake:${tag}`);
        return way.text;
      };
      // Nothing has come back yet when these fail, so going again repeats nothing.
      const again = (go, sql) => go(wrapped(sql)).catch(async e => {
        if (closing || !LOST.test(String(e && e.message))) throw e;
        done();
        await recover();
        await recovered();
        // A Stop that came while this recovered: there is no statement to go again.
        if (stopped) throw new Error('INTERRUPT Error: Interrupted!');
        return go(wrapped(sql));
      });
      return {
        run: sql => again(x => c.run(x), sql).catch(clean).finally(done),
        runAndReadAll: sql => again(x => c.runAndReadAll(x), sql).catch(clean).finally(done),
        // A stream holds its attach until its connection closes: rows are still coming through it.
        async stream(sql) {
          const r = await again(x => c.stream(x), sql).catch(clean);
          return {
            deduplicatedColumnNames: () => r.deduplicatedColumnNames(),
            columnType: i => r.columnType(i),
            fetchChunk: () => r.fetchChunk().catch(clean),
          };
        },
        interrupt() {
          stopped = true;
          // The tag as it is by then: going again gives a statement a new one.
          if (tag) cancel(() => tag).catch(() => {});
        },
        closeSync() { done(); c.closeSync(); },
      };
    }

    return {
      capabilities: state.capabilities,
      tmpDir: state.tmpDir,
      // Asked over the control pipe, so they cost no Quack request and leave nothing in its log. The
      // token goes this way for that reason: a statement sent over Quack is in the log.
      // A connection on this window's own DuckDB, for what needs no server: asking its parser.
      connectLocal: () => local.connect(),
      setStorageToken: (token, scopes = []) => ask({ storageToken: token, storageScopes: scopes }),
      allowStorage: scopes => ask({ storageScopes: scopes }),
      lakeTable: t => ask({ lakeTable: t }),
      lakeSync: t => ask({ lakeSync: t }),
      lakeTables: () => ask({ lakeTables: true }),
      lakeLocal: () => ask({ lakeLocal: true }),
      lakeSnapshots: names => ask({ lakeSnapshots: names }),
      lakeStats: () => ask({ lakeStats: true }),
      lakeFetch: name => ask({ lakeFetch: name }),
      lakeStop: name => ask({ lakeStop: name }),
      icebergAttach: w => ask({ icebergAttach: w }),
      icebergDetach: w => ask({ icebergDetach: w }),
      deltaAttach: w => ask({ deltaAttach: w }),
      deltaDetach: w => ask({ deltaDetach: w }),
      stats: () => ask({ stats: true }),
      othersRunning: () => ask({ othersRunning: true }),
      logs: limit => ask({ logs: { limit } }),
      async connect() { return wrap(sql => route(sql)); },
      /**
       * A tab's own session on the server (engine-host.js tabSession): `connect()` gives what connect() does, its
       * statements sent down the session's one attach. `close()` ends the session, and what it kept goes with it.
       * When the server lost it (its listener started again, a new server after an update), the session attaches
       * again, as a new one, and `lost()` decides: it throws when what the old one kept matters, and the statement
       * goes again on the new one when it doesn't.
       */
      async session({ lost = () => {} } = {}) {
        let way = await dedicated();
        let ended = false;
        const recovered = async () => {
          way = await dedicated();
          lost();
        };
        return {
          connect: () => wrap(sql => ({ text: way.text(sql), release() {}, retire() {} }), { recovered }),
          close() { if (ended) return; ended = true; way.detach().catch(() => {}); },
        };
      },
      // This window's part of the server, ended while Node can still run. closeSync below blocks
      // until this DuckDB's statements are done, and those wait on the server, so what is running
      // is cancelled first and the socket's close is seen to happen first: a statement that
      // slipped past the listing is cancelled by the server when the socket goes.
      //
      // `stop` ends the server for every window: Sign Out, a restart, Clear Cached OneLake Data.
      // It waits for the server to go, since what follows may delete the files it holds open.
      async leave({ stop = false } = {}) {
        unwatch();
        closing = true;
        const ids = await listTagged(`${window}:`).catch(() => []);
        if (ids.length && !await cancelNow(ids).catch(() => true)) {
          await cancelNow(await listTagged(`${window}:`).catch(() => [])).catch(() => {});
        }
        await new Promise(resolve => {
          // A server asked to stop that is still there after 5 s is ended: what follows may need what it holds.
          const timer = setTimeout(() => {
            if (stop) { try { if (state.pid) process.kill(state.pid); } catch (_) {} }
            resolve();
          }, stop ? 5_000 : 1_000);
          sock.once('close', () => { clearTimeout(timer); resolve(); });
          if (stop) sock.write(`${JSON.stringify({ stop: true })}\n`);
          else sock.destroy();
        });
        sock.destroy();
      },
      closeSync() {
        unwatch();
        closing = true;
        stopGrowing();
        sock.destroy();
        try { admin.closeSync(); } catch (_) {}
        try { local.closeSync(); } catch (_) {}
      },
    };
  };
}

module.exports = { createRemote, stopServer, openClient, loadExtension, pipePath, lineReader, watchdog, LOST, serverHolder, newerVersion, UPDATED };
