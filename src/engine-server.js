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
//
// A window gone is a window whose queries nobody is waiting for: Quack lets them run on, so they
// are cancelled here. With no window left the server waits `idleMs`, so a window reload finds it
// warm, and exits.
// =============================================================================

const net = require('node:net');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { DuckDBInstance } = require('@duckdb/node-api');
const { createEngineHost } = require('./engine-host');
const { openClient, loadExtension } = require('./engine-client');
const { sqlStr } = require('./sql');

const sameToken = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// What the extension remembers (statestore.js): a DuckDB of its own, on a Quack port of its own, so
// no statement a page sends the engine can reach it, and it holds none of the engine's memory.
async function openState({ stateFile, token, options }) {
  const db = await DuckDBInstance.create(stateFile, {
    allow_persistent_secrets: 'false', threads: '2', memory_limit: '512MB',
    ...(options.extensionDir ? { extension_directory: options.extensionDir } : {}),
  });
  const c = await db.connect();
  await loadExtension(c, 'httpfs', options);
  await loadExtension(c, 'quack', options);
  await c.run('CREATE TABLE IF NOT EXISTS kv (k VARCHAR PRIMARY KEY, ts BIGINT, value VARCHAR);');
  const r = await c.runAndReadAll(`SELECT listen_uri FROM quack_serve('quack:127.0.0.1:0', token = ${sqlStr(token)})`);
  await c.run(`SET allowed_directories = []; SET enable_external_access = false; SET lock_configuration = true;`);
  return { db, uri: r.getRowObjectsJson()[0].listen_uri };
}

async function main({ token, pipe, options, logFile, idleMs = 60_000, stateFile = null, build = null }) {
  const log = line => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch (_) {} };
  const say = o => process.stdout.write(`${JSON.stringify(o)}\n`);
  log(`starting: pid ${process.pid}`);

  const engine = createEngineHost({ ...options, serve: { token }, onWarn: log,
    onLog: b => log(`booted in ${b.totalMs}ms`) });

  let idle = null, state = null, reaper = null, stopping = false, stateDb = null;
  const clients = new Set();
  async function shutdown(why) {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${why}`);
    server.close();
    // No engine.close(): closing an instance blocks until its statements are done, and a client's
    // are running on it. Everything it holds that matters is on disk already, or goes with it.
    if (state) await fsp.rm(state.tmpDir, { recursive: true, force: true }).catch(() => {});
    if (stateDb) { try { stateDb.closeSync(); } catch (_) {} }   // checkpoints; a kill replays its log
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
      await reaper.cancelIds(ids);
    }
  }

  let booted;
  const server = net.createServer(sock => {
    let buf = '', who = null;
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('close', () => {
      if (!who) return;
      clients.delete(who);
      reap(who.window).catch(e => log(`could not cancel a window's queries: ${e.message}`));
      watchIdle();
    });
    sock.on('data', async chunk => {
      buf += chunk;
      for (let nl; (nl = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg = {};
        try { msg = JSON.parse(line); } catch (_) {}
        if (!who) {
          if (!sameToken(msg.token, token)) { sock.destroy(); return; }
          who = { window: String(msg.window || '') };
          clients.add(who);
          watchIdle();
          // A window that arrives during the boot waits for it.
          try { await booted; sock.write(`${JSON.stringify({ ok: true, ...state })}\n`); }
          catch (e) { sock.write(`${JSON.stringify({ ok: false, error: e.message })}\n`); }
        } else if (msg.stop) {
          shutdown('a window asked');
        }
      }
    });
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
    if (stateFile) {
      // Held for the life of this process: nothing else opens the file.
      const kept = await openState({ stateFile, token, options }).catch(e => {
        log(`no state file: ${e.message}`);
        state.stateError = `the state file could not be opened: ${e.message}`;
        return null;
      });
      if (kept) { state.stateUri = kept.uri; stateDb = kept.db; }
    }
    reaper = await openClient({ uri: s.uri, token, extensionDir: options.extensionDir, bundledExtensions: options.bundledExtensions })
      .catch(e => { log(`no way to cancel a gone window's queries: ${e.message}`); return null; });
  });
  await booted;
  watchIdle();
  say({ ready: true });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  const nl = input.indexOf('\n');
  if (nl < 0) return;
  process.stdin.removeAllListeners('data');
  process.stdin.destroy();
  main(JSON.parse(input.slice(0, nl))).catch(e => {
    try { process.stdout.write(`${JSON.stringify({ error: e.message })}\n`); } catch (_) {}
    process.exit(1);
  });
});
process.on('uncaughtException', e => {
  try { process.stderr.write(`${e && e.stack}\n`); } catch (_) {}
  process.exit(1);
});
