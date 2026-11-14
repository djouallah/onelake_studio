'use strict';
// =============================================================================
// engine-server.js — the shared engine's process
// =============================================================================
// One DuckDB for one account on this machine, with every tab of every window as a client over
// Quack (engine-client.js). Started detached by the first window that needs it. It reads one line
// from stdin, { token, pipe, options, logFile, idleMs }, answers one line on stdout, and from then
// on talks only over its control pipe:
//
//   window -> server   { token, window }   then the socket stays open: it says the window is alive
//   server -> window   { ok, uri, capabilities, tmpDir }
//   window -> server   { stop: true }      Sign Out, a restart, Clear Cached OneLake Data
//   window -> server   { id, stats | othersRunning | logs | clearLogs | storageToken | lakeTable | lakeSync | lakeTables | lakeStats | lakeFetch | lakeStop | icebergAttach | icebergDetach | deltaAttach | deltaDetach | listen }, answered { id, value | error }
//   server -> window   { reattach: true }   its own news, with no id
//
// A window gone is a window whose queries nobody is waiting for: Quack lets them run on, so they
// are cancelled here. With no window left the server waits `idleMs`, so a window reload finds it
// warm, and exits.
// =============================================================================

const net = require('node:net');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { dirname, join } = require('node:path');
const { createEngineHost } = require('./engine-host');
const { openClient, lineReader } = require('./engine-client');
const { createLogFile } = require('../logfile');
const { createLogKeeper } = require('./enginelog');

const sameToken = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// What a connection may send before it has said who it is, and how long it has to say it: a window's first line is
// its token and its name, a few hundred bytes, sent at once. And the longest line a window sends after.
const MAX_HELLO = 64 * 1024;
const HELLO_MS = 10_000;
const MAX_LINE = 64 * 1024 * 1024;

// State files and logs from when they were named after the install, each left behind by an update.
const OLD_STATE_FILE = /^[0-9a-f]{16}\.(duckdb(\.wal)?|log)$/;
const LOG_KEEP_BYTES = 1024 * 1024;

// The log outlives every update, so only its end is kept, from a whole line.
function trimLog(file) {
  try {
    if (fs.statSync(file).size <= LOG_KEEP_BYTES) return;
    const end = fs.readFileSync(file).subarray(-LOG_KEEP_BYTES);
    fs.writeFileSync(file, end.subarray(end.indexOf('\n') + 1));
  } catch (_) {}
}

async function main({ token, pipe, options, logFile, idleMs = 60_000, logsFile = null, build = null, helloMs = HELLO_MS }) {
  trimLog(logFile);
  const log = line => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch (_) {} };
  const say = o => process.stdout.write(`${JSON.stringify(o)}\n`);
  log(`starting: pid ${process.pid}`);

  const engine = createEngineHost({ ...options, serve: { token }, onWarn: log,
    onLog: b => log(`booted in ${b.totalMs}ms: ${b.stages.map(s => `${s.stage} ${s.ms}ms`).join(', ')}`) });

  let idle = null, state = null, reaper = null, stopping = false, logs = null, keeper = null;
  const clients = new Set();

  // What the engine runs goes to the log file, where the Logs tab reads it.
  async function keepLog() {
    logs = createLogFile({ file: logsFile, log });
    // A database that has died takes every window's statements with it. Gone, the windows hear so and the
    // next statement starts a new one.
    keeper = createLogKeeper({ engine, logs, log, maxBytes: Math.max(0, Number(options.logMaxGB ?? 1) || 0) * 1024 ** 3,
      onFatal: () => { shutdown('the database died of a fatal error'); } });
    keeper.start();
    for (const name of await fsp.readdir(dirname(logsFile)).catch(() => [])) {
      if (OLD_STATE_FILE.test(name)) await fsp.rm(join(dirname(logsFile), name), { force: true }).catch(() => {});
    }
  }
  async function shutdown(why) {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${why}`);
    server.close();
    // No engine.close(): closing an instance blocks until its statements are done, and a client's
    // are running on it. Everything it holds that matters is on disk already, or goes with it.
    if (keeper) { keeper.stop(); await keeper.flush().catch(() => {}); }
    if (state) await fsp.rm(state.tmpDir, { recursive: true, force: true }).catch(() => {});
    if (logs) logs.close();
    process.exit(0);
  }
  function watchIdle() {
    clearTimeout(idle);
    idle = clients.size ? null : setTimeout(() => shutdown('no window left'), idleMs);
  }

  // Whatever a window left running.
  async function reap(window) {
    if (!reaper) return;
    const ids = await reaper.listTagged(`${window}:`).catch(() => []);
    if (ids.length) {
      log(`cancelling ${ids.length} left by a window that went`);
      await reaper.cancelIds(ids).catch(async () => {
        await reaper.reattachControl();
        await reaper.cancelIds(ids);
      });
    }
  }

  // A window couldn't reach Quack. The process being alive doesn't mean its listeners are: one has
  // been seen gone with no error anywhere, and nothing else would start it again. `force` is for tests.
  const accepting = uri => new Promise(resolve => {
    const [host, port] = uri.replace(/^quack:/, '').split(':');
    const s = net.connect(Number(port), host);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
  async function listenAgain(force) {
    let again = false;
    if (force || !await accepting(state.uri)) {
      log(`the engine's listener on ${state.uri} had stopped: starting it again`);
      await engine.relisten();
      if (reaper) await reaper.reattach().catch(e => log(`could not attach again: ${e.message}`));
      again = true;
    }
    // Every window's attaches belong to the listener that stopped (engine-client.js).
    if (again) for (const c of clients) { if (!c.sock.destroyed) c.sock.write(`${JSON.stringify({ reattach: true })}\n`); }
  }

  // What a window asks over the pipe rather than Quack: nothing here is in Quack's log, the token above all.
  async function answer(msg) {
    await booted;
    const scopes = Array.isArray(msg.storageScopes) ? msg.storageScopes.map(String) : [];
    if (msg.storageToken) { await engine.setStorageToken(String(msg.storageToken), scopes); return true; }
    // OneLake places a window is about to read: the secret here goes nowhere it wasn't told (sql.js ONELAKE_SCOPES).
    if (msg.storageScopes) { await engine.allowStorage(scopes); return true; }
    // A OneLake table's lake table, synced here, where the lake is (engine-host.js lakeTable, lakeSync).
    if (msg.lakeTable) return engine.lakeTable(msg.lakeTable);
    if (msg.lakeSync) return engine.lakeSync(msg.lakeSync);
    if (msg.lakeTables) return engine.lakeTables();
    if (msg.lakeStats) return engine.lakeStats();
    // A lake table's every file brought here whole, or the rest of them left (engine-host.js keepWhole).
    if (msg.lakeFetch) return engine.lakeFetch(String(msg.lakeFetch));
    if (msg.lakeStop) return engine.lakeStop(String(msg.lakeStop));
    // A write's Iceberg catalog, attached for its one statement and detached after (engine-host.js runWrite).
    if (msg.icebergAttach) return engine.icebergAttach(msg.icebergAttach);
    if (msg.icebergDetach) return engine.icebergDetach(msg.icebergDetach);
    // A Delta table a write goes to, the same way.
    if (msg.deltaAttach) return engine.deltaAttach(msg.deltaAttach);
    if (msg.deltaDetach) return engine.deltaDetach(msg.deltaDetach);
    if (msg.listen) { await listenAgain(!!msg.listen.force); return true; }
    if (msg.stats) return { ...await engine.stats(), statements: keeper ? await keeper.statements() : 0 };
    if (msg.othersRunning) return engine.othersRunning();
    if (msg.logs) {
      if (keeper) return keeper.read(msg.logs.limit);
      return [];
    }
    if (msg.clearLogs) { if (keeper) await keeper.clear(); return true; }
    throw new Error('the engine was asked something it does not know');
  }

  let booted;
  const server = net.createServer(sock => {
    let who = null;
    const tell = o => { if (!sock.destroyed) sock.write(`${JSON.stringify(o)}\n`); };
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    // A connection that says nothing holds a handle here for as long as it likes, unless it is closed.
    const hello = setTimeout(() => { if (!who) sock.destroy(); }, helloMs);
    sock.on('close', () => {
      clearTimeout(hello);
      if (!who) return;
      clients.delete(who);
      reap(who.window).catch(e => log(`could not cancel a window's queries: ${e.message}`));
      watchIdle();
    });
    sock.on('data', lineReader(line => {
      if (sock.destroyed) return;
      let msg = null;
      try { msg = JSON.parse(line); } catch (_) {}
      // Anything that isn't an object asks nothing: `null` is JSON too, and has no token to read.
      if (!msg || typeof msg !== 'object') msg = {};
      if (!who) {
        if (!sameToken(msg.token, token)) { sock.destroy(); return; }
        clearTimeout(hello);
        who = { window: String(msg.window || ''), sock };
        clients.add(who);
        watchIdle();
        // A window that arrives during the boot waits for it.
        booted.then(() => tell({ ok: true, ...state }), e => tell({ ok: false, error: e.message }));
      } else if (msg.stop) {
        shutdown('a window asked');
      } else if (msg.id != null) {
        // Answered by id: these finish in any order.
        answer(msg).then(value => ({ value }), e => ({ error: (e && e.message) || String(e) }))
          .then(reply => tell({ id: msg.id, ...reply }));
      }
    }, { maxLine: () => (who ? MAX_LINE : MAX_HELLO), onTooLong: () => sock.destroy() }));
  });

  // The pipe first: it is what says this is the one server for this key.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, resolve);
  }).catch(e => {
    if (e.code !== 'EADDRINUSE') throw e;
    say({ taken: true });
    process.exit(0);
  });
  server.on('error', e => log(`pipe: ${e.message}`));
  if (process.platform !== 'win32') { try { fs.chmodSync(pipe, 0o600); } catch (_) {} }

  booted = engine.boot().then(async s => {
    state = { ...s, build };
    log(`serving ${s.uri}`);
    if (logsFile) await keepLog();
    reaper = await openClient({ uri: s.uri, token, extensionDir: options.extensionDir, bundledExtensions: options.bundledExtensions })
      .catch(e => { log(`no way to cancel a gone window's queries: ${e.message}`); return null; });
  });
  await booted;
  watchIdle();
  say({ ready: true });
}

// Why this process ended, in the one place it can be read afterwards: it runs detached, with no
// stderr anyone sees.
let crashLog = null;
function sayWhy(e) {
  if (!crashLog) return;
  try { fs.appendFileSync(crashLog, `${new Date().toISOString()} ended: ${(e && e.stack) || e}\n`); } catch (_) {}
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  const nl = input.indexOf('\n');
  if (nl < 0) return;
  process.stdin.removeAllListeners('data');
  process.stdin.destroy();
  const asked = JSON.parse(input.slice(0, nl));
  crashLog = asked.logFile;
  main(asked).catch(e => {
    sayWhy(e);
    try { process.stdout.write(`${JSON.stringify({ error: e.message })}\n`); } catch (_) {}
    process.exit(1);
  });
});
// A promise nobody was waiting on that failed: said in the log, and the server goes on. Every window's
// statements are in this process, and Node's own answer to one stray rejection is to end it.
process.on('unhandledRejection', e => {
  if (!crashLog) return;
  try { fs.appendFileSync(crashLog, `${new Date().toISOString()} a promise nobody waited for failed: ${(e && e.stack) || e}\n`); } catch (_) {}
});
process.on('uncaughtException', e => {
  sayWhy(e);
  try { process.stderr.write(`${e && e.stack}\n`); } catch (_) {}
  process.exit(1);
});
