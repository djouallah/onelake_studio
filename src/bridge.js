'use strict';
// =============================================================================
// bridge.js — the doorbell between cli.mjs and the running extension
// =============================================================================
// The extension listens on a local pipe (Windows) or socket (macOS, Linux) named after the
// user; cli.mjs connects, sends one request as a line of JSON, and gets one line back. No
// port, no network: the channel is the operating system's, and only this user can write to
// it (a Windows pipe gives other users read access at most; the socket is made 0600).
//
// One window serves at a time. Another window finds the name taken and tries again later,
// so closing the serving window hands the bridge to the next one within a minute.
// =============================================================================

const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');

const MAX_REQUEST = 1024 * 1024;
const RETRY_MS = 30_000;
const REQUEST_MS = 10_000;   // a client has this long to send its line; the answer takes what it takes

function bridgePath() {
  const user = createHash('sha256').update(os.userInfo().username).digest('hex').slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\onelake-studio-${user}`
    : join(os.tmpdir(), `onelake-studio-${user}.sock`);
}

/** Serve `handle(request) -> Promise<reply>` until dispose(). */
function serveBridge({ handle, log = () => {}, path = bridgePath() }) {
  let server = null, timer = null, disposed = false;

  function start() {
    if (disposed) return;
    server = net.createServer(sock => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('error', () => {});
      // A client that connects and never finishes its line would hold the socket open for good.
      sock.setTimeout(REQUEST_MS, () => sock.destroy());
      sock.on('data', async chunk => {
        buf += chunk;
        if (buf.length > MAX_REQUEST) { sock.destroy(); return; }
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        sock.removeAllListeners('data');
        sock.setTimeout(0);
        let reply;
        try { reply = await handle(JSON.parse(buf.slice(0, nl))); }
        catch (e) { reply = { out: '', err: `error: ${(e && e.message) || e}`, code: 1 }; }
        sock.end(JSON.stringify(reply) + '\n');
      });
    });
    server.on('error', e => {
      server = null;
      if (e.code !== 'EADDRINUSE') { log(`bridge: ${e.message}`); return; }
      // Taken: another window serving, or a socket file left by one that crashed.
      const probe = net.connect(path);
      probe.on('connect', () => { probe.destroy(); timer = setTimeout(start, RETRY_MS); });
      probe.on('error', () => {
        if (process.platform !== 'win32') { try { fs.unlinkSync(path); } catch (_) {} start(); }
        else timer = setTimeout(start, RETRY_MS);
      });
    });
    server.listen(path, () => {
      if (process.platform !== 'win32') { try { fs.chmodSync(path, 0o600); } catch (_) {} }
      log(`bridge: serving the command line on ${path}`);
    });
  }
  start();

  return {
    dispose() {
      disposed = true;
      clearTimeout(timer);
      if (server) server.close();
    },
  };
}

/** One request to the running extension. Rejects with code 'NO_EXTENSION' when none listens. */
function askBridge(request, path = bridgePath()) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(request) + '\n'));
    sock.on('data', c => { buf += c; });
    sock.on('end', () => {
      try { resolve(JSON.parse(buf)); } catch (_) { reject(new Error('the extension closed the connection without an answer')); }
    });
    sock.on('error', e => {
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
        const err = new Error('OneLake Studio is not running — open VS Code with the OneLake Studio extension, signed in.');
        err.code = 'NO_EXTENSION';
        reject(err);
      } else reject(e);
    });
  });
}

module.exports = { serveBridge, askBridge };
