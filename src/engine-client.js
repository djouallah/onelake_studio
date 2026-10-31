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
const { join } = require('node:path');
const { DuckDBInstance } = require('@duckdb/node-api');
const { sqlStr } = require('./sql');

const CONNECT_MS = 5_000;
const BOOT_MS = 180_000;       // a first boot may be downloading its extensions
const LOCK_STALE_MS = 200_000;
const TOKEN_LOST_MS = 90_000;  // longer than a server waits with no window left
const CANCEL_TRIES = 20;
const CANCEL_EVERY_MS = 100;   // a Stop can land before the statement reaches the server
const MAX_ATTACHES = 8;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const slash = p => String(p).replace(/\\/g, '/');

// Named after the user and `key` (the account and this build), so another account or build gets
// its own server. Only this user can write to it, and the token is asked for regardless.
function pipePath(key) {
  const id = crypto.createHash('sha256').update(`${os.userInfo().username}|${key}`).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\onelake-engine-${id}` : join(os.tmpdir(), `onelake-engine-${id}.sock`);
}

// The control socket, signed in, and what the server says of itself; null if nobody answers or
// the token is refused. A server still booting answers once it is up, so `waitMs` is long enough
// for a boot once something has answered the connect.
function connectControl(path, token, window, waitMs = BOOT_MS) {
  return new Promise(resolve => {
    const sock = net.connect(path);
    let buf = '';
    const done = v => { clearTimeout(timer); resolve(v); };
    let timer = setTimeout(() => { sock.destroy(); done(null); }, CONNECT_MS);
    sock.setEncoding('utf8');
    sock.on('error', () => done(null));
    sock.on('close', () => done(null));
    sock.on('connect', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { sock.destroy(); done(null); }, waitMs);
      sock.write(`${JSON.stringify({ token, window })}\n`);
    });
    const onData = chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      sock.off('data', onData);
      let state = null;
      try { state = JSON.parse(buf.slice(0, nl)); } catch (_) {}
      if (state && state.ok) done({ sock, state });
      else { sock.destroy(); done(null); }
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
function spawnServer({ script, token, pipe, options, logFile, idleMs, stateFile, build }) {
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
    child.stdin.end(`${JSON.stringify({ token, pipe, options, logFile, idleMs, stateFile, build })}\n`);
  });
}

// The running server for this key, started if there is none.
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
    const up = await connectControl(pipe, token, window);
    if (!up) throw new Error('the engine started and then refused this window');
    return { ...up, token };
  });
}

// DuckDB's error says where in OUR wrapper it failed too. The statement's own message comes
// first, so the wrapper's part and the tag go.
function clean(e) {
  if (!e || typeof e.message !== 'string') throw e;
  const message = e.message
    .replace(/\s*LINE \d+: SELECT \* FROM (?:quack_query|r\d+\.query)\([\s\S]*$/, '')
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
    if (!free) { grow(); return { text: query(sql), release() {} }; }
    free.busy = true;
    return { text: `SELECT * FROM ${free.name}.query(${sqlStr(sql)})`, release() { free.busy = false; } };
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
  return { local, admin, route, stopGrowing, reattach, reattachControl, listTagged, cancelIds };
}

// Questions on the control pipe, answered by id. A line with no id is the server's own news.
function controlChannel(sock, onNews = () => {}) {
  const asked = new Map();
  let seq = 0, lines = '';
  sock.on('data', chunk => {
    lines += chunk;
    for (let nl; (nl = lines.indexOf('\n')) >= 0;) {
      let m = null;
      try { m = JSON.parse(lines.slice(0, nl)); } catch (_) {}
      lines = lines.slice(nl + 1);
      if (m && m.id == null) { onNews(m); continue; }
      const waiting = m && asked.get(m.id);
      if (!waiting) continue;
      asked.delete(m.id);
      if (m.error) waiting.reject(new Error(m.error)); else waiting.resolve(m.value);
    }
  });
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

// This window on the server, started if there is none. A server of another build is told to stop
// and replaced: F5 after a rebuild must not find the old code, nor the state file held by it.
async function joinServer({ key, script, options, stateDir, build = null, getToken, setToken, idleMs = 60_000 }) {
  await fsp.mkdir(stateDir, { recursive: true });
  const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  const plain = typeof options === 'function' ? await options() : options;
  const asked = {
    pipe: pipePath(key), window: crypto.randomBytes(6).toString('hex'), getToken, setToken,
    lockFile: join(stateDir, `${id}.lock`),
    server: { script, options: plain, logFile: join(stateDir, `${id}.log`), idleMs, build, stateFile: join(stateDir, `${id}.duckdb`) },
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
 * The server's second DuckDB: what the extension remembers, in one file per account. It answers
 * on a Quack port of its own, so no statement a page sends can reach it. Joined on first use, and
 * again after the server went: signing out stops the server, and the tree still reads the cache.
 * @param {object} cfg  as createRemote's
 * @returns {{ run: (sql: string) => Promise<object[]>, stop: () => Promise<void>, close: () => void }}
 */
function createStateClient(cfg) {
  let joined = null, joining = null;
  function drop(j) {
    if (joined === j) joined = null;
    j.sock.destroy();
    j.client.stopGrowing();
    try { j.client.admin.closeSync(); } catch (_) {}
    try { j.client.local.closeSync(); } catch (_) {}
  }
  function connected() {
    if (joined) return Promise.resolve(joined);
    if (!joining) {
      joining = (async () => {
        const { sock, state, token, options } = await joinServer(cfg);
        if (!state.stateUri) { sock.destroy(); throw new Error(state.stateError || 'the engine has no state file open'); }
        const client = await openClient({ uri: state.stateUri, token, extensionDir: options.extensionDir, bundledExtensions: options.bundledExtensions })
          .catch(e => { sock.destroy(); throw e; });
        const ask = controlChannel(sock, m => { if (m.reattach) client.reattach().catch(() => {}); });
        const me = { sock, client, recover: recovery(ask, client) };
        sock.on('error', () => {});
        sock.on('close', () => drop(me));
        joined = me;
        return me;
      })().finally(() => { joining = null; });
    }
    return joining;
  }
  return {
    async run(sql) {
      const { client, recover } = await connected();
      const once = async () => {
        const c = await client.local.connect();
        const way = client.route(sql);
        try { return (await c.runAndReadAll(way.text)).getRowObjectsJson(); }
        finally {
          way.release();
          try { c.closeSync(); } catch (_) {}
        }
      };
      return once().catch(async e => {
        if (!LOST.test(String(e && e.message))) throw e;
        await recover();
        return once();
      });
    },
    async stop() {
      const j = joined;
      if (!j) return;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 5_000);
        j.sock.once('close', () => { clearTimeout(timer); resolve(); });
        j.sock.write(`${JSON.stringify({ stop: true })}\n`);
      });
    },
    close() { if (joined) drop(joined); },
  };
}

/**
 * What engine-host.js takes as `remote`: a function that joins the server and answers something
 * shaped like a DuckDBInstance: connect() and closeSync(), plus capabilities and tmpDir.
 * @param {object} o
 * @param {string} o.key  the account this server is for
 * @param {string} o.script  dist/engine-server.js
 * @param {object|(() => Promise<object>)} o.options  createEngineHost's plain options, for the server's engine
 * @param {string} o.stateDir  for the lock, the server's log and the state file
 * @param {*} [o.build]  which build this is; a server of another is replaced
 * @param {() => Promise<string|undefined>} o.getToken  the session token, from secret storage
 * @param {(t: string) => Promise<void>} o.setToken
 * @param {() => void} [o.onGone]  the server went away under this window
 * @param {number} [o.idleMs]  how long the server waits with no window left
 */
function createRemote({ onGone = () => {}, ...cfg }) {
  return async () => {
    const { sock, state, token, window, options } = await joinServer(cfg);
    let client;
    try {
      client = await openClient({ uri: state.uri, token, extensionDir: options.extensionDir, bundledExtensions: options.bundledExtensions });
    } catch (e) { sock.destroy(); throw e; }
    const { local, admin, route, stopGrowing, reattachControl, listTagged, cancelIds } = client;

    let closing = false;
    sock.on('error', () => {});
    sock.on('close', () => { if (!closing) onGone(); });

    const ask = controlChannel(sock, m => { if (m.reattach && !closing) client.reattach().catch(() => {}); });
    const recover = recovery(ask, client);
    const mine = r => ({ ...r, here: r.window === window });

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

    return {
      capabilities: state.capabilities,
      tmpDir: state.tmpDir,
      // Asked over the control pipe, so they cost no Quack request and leave nothing in its log. The
      // token goes this way for that reason: a statement sent over Quack is in the log.
      setStorageToken: token => ask({ storageToken: token }),
      setOffline: now => ask({ offline: now }),
      stats: () => ask({ stats: true }),
      logs: async limit => (await ask({ logs: { limit } })).map(mine),
      clearLogs: () => ask({ clearLogs: true }),
      async connect() {
        const c = await local.connect();
        let tag = null, way = null, stopped = false;
        const done = () => { if (way) way.release(); way = null; };
        // The tag ends with its comment's close, so statement 1's doesn't also match statement 12.
        const wrapped = sql => {
          done();
          tag = `${window}:${++seq}*/`;
          way = route(`${sql}\n/*onelake:${tag}`);
          return way.text;
        };
        // Nothing has come back yet when these fail, so going again repeats nothing.
        const again = (go, sql) => go(wrapped(sql)).catch(async e => {
          if (closing || !LOST.test(String(e && e.message))) throw e;
          done();
          await recover();
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
      },
      // This window's part of the server, ended while Node can still run. closeSync below blocks
      // until this DuckDB's statements are done, and those wait on the server, so what is running
      // is cancelled first and the socket's close is seen to happen first: a statement that
      // slipped past the listing is cancelled by the server when the socket goes.
      //
      // `stop` ends the server for every window: Sign Out, a restart, Clear Cached OneLake Data.
      // It waits for the server to go, since what follows may delete the files it holds open.
      async leave({ stop = false } = {}) {
        closing = true;
        const ids = await listTagged(`${window}:`).catch(() => []);
        if (ids.length && !await cancelNow(ids).catch(() => true)) {
          await cancelNow(await listTagged(`${window}:`).catch(() => [])).catch(() => {});
        }
        await new Promise(resolve => {
          const timer = setTimeout(resolve, stop ? 5_000 : 1_000);
          sock.once('close', () => { clearTimeout(timer); resolve(); });
          if (stop) sock.write(`${JSON.stringify({ stop: true })}\n`);
          else sock.destroy();
        });
        sock.destroy();
      },
      closeSync() {
        closing = true;
        stopGrowing();
        sock.destroy();
        try { admin.closeSync(); } catch (_) {}
        try { local.closeSync(); } catch (_) {}
      },
    };
  };
}

module.exports = { createRemote, createStateClient, openClient, loadExtension, pipePath };
