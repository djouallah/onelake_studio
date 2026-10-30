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
//
// The command line's contract lives here too, the one file both sides of the pipe ship: what
// may be asked (COMMANDS), and what the answer's exit code means (EXIT).
// =============================================================================

const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');

const MAX_REQUEST = 1024 * 1024;
const RETRY_MS = 30_000;
const REQUEST_MS = 10_000;   // a client has this long to send its line; the answer takes what it takes

// What an agent can branch on without reading the message.
const EXIT = { OK: 0, FAILED: 1, USAGE: 2, UNAVAILABLE: 3, NOT_CACHED: 4, DECLINED: 5, TIMEOUT: 6 };
const exitName = code => Object.keys(EXIT).find(k => EXIT[k] === code) || 'FAILED';

// The --json answer to anything that failed: the same on both sides of the pipe.
const failureJson = (code, message, { retry, notes = [] } = {}) => JSON.stringify(
  { ok: false, error: { code: exitName(code), message, ...(retry ? { retry } : {}) }, notes });

const LISTING = ['fresh', 'csv', 'json', 'limit'];
const COMMANDS = {
  ls: { usage: 'ls [<ws> [<item>]]', max: 2, flags: LISTING },
  models: { usage: 'models [<ws>]', max: 1, flags: LISTING },
  items: { usage: 'items [<ws>]', max: 1, flags: LISTING },
  files: { usage: 'files <ws> <item> [<dir>]', min: 2, max: 3, flags: LISTING },
  find: { usage: 'find <text>', min: 1, max: 1, flags: ['csv', 'json', 'limit'] },
  table: { usage: 'table <ws> <item> <schema.table>', min: 3, max: 3, flags: ['fresh', 'csv', 'json'] },
  model: { usage: 'model <ws> <model>', min: 2, max: 2, flags: ['fresh', 'json'] },
  sql: { usage: 'sql "<query>"', min: 1, max: 1, flags: ['in', 'csv', 'json', 'limit', 'showSql'] },
  export: { usage: 'export <ws> <model>, or export <ws> <item> <Files/path>', min: 2, max: 3, flags: ['json'] },
};
const FLAG_NAME = { fresh: '--fresh', csv: '--csv', json: '--json', limit: '--limit', in: '--in', showSql: '--show-sql' };

/** What is wrong with a request, or null: asked before the extension is, and by it. */
function checkRequest({ args, opts = {} }) {
  const [name, ...rest] = Array.isArray(args) ? args.map(String) : [];
  if (!name || !Object.hasOwn(COMMANDS, name)) {
    return `unknown command: ${name || '(none)'} — ${Object.keys(COMMANDS).join(', ')}`;
  }
  const c = COMMANDS[name];
  if (rest.length < (c.min || 0) || rest.length > c.max || rest.some(a => a === '')) return `usage: ${c.usage}`;
  for (const [key, flag] of Object.entries(FLAG_NAME)) {
    if (opts[key] != null && opts[key] !== false && !c.flags.includes(key)) return `${flag} is not an option of ${name}`;
  }
  if (opts.csv && opts.json) return '--csv or --json, not both';
  if (opts.limit != null && !(Number.isInteger(Number(opts.limit)) && Number(opts.limit) > 0)) {
    return `--limit takes a positive whole number, not "${opts.limit}"`;
  }
  if (opts.in != null && !/^[^/]+\/[^/]+$/.test(String(opts.in))) return `--in takes <ws>/<item>, not "${opts.in}"`;
  return null;
}

function bridgePath() {
  if (process.env.ONELAKE_STUDIO_BRIDGE) return process.env.ONELAKE_STUDIO_BRIDGE;
  const user = createHash('sha256').update(os.userInfo().username).digest('hex').slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\onelake-studio-${user}`
    : join(os.tmpdir(), `onelake-studio-${user}.sock`);
}

/**
 * Serve `handle(request, { signal }) -> Promise<reply>` until dispose(). `signal` aborts when
 * the client goes away: an agent's tool timing out kills the command line, and what it asked
 * for has nobody left to answer.
 */
function serveBridge({ handle, log = () => {}, path = bridgePath() }) {
  let server = null, timer = null, disposed = false;

  function start() {
    if (disposed) return;
    server = net.createServer(sock => {
      let buf = '';
      const gone = new AbortController();
      sock.setEncoding('utf8');
      sock.on('error', () => {});
      sock.on('close', () => gone.abort());
      // A client that connects and never finishes its line would hold the socket open for good.
      sock.setTimeout(REQUEST_MS, () => sock.destroy());
      sock.on('data', async chunk => {
        buf += chunk;
        if (buf.length > MAX_REQUEST) { sock.destroy(); return; }
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        sock.removeAllListeners('data');
        sock.setTimeout(0);
        // Serialised in here too: a reply that cannot be is an answer, not a client left waiting.
        let line;
        try { line = JSON.stringify(await handle(JSON.parse(buf.slice(0, nl)), { signal: gone.signal })); }
        catch (e) { line = JSON.stringify({ out: '', err: `error: ${(e && e.message) || e}`, code: EXIT.FAILED }); }
        sock.end(line + '\n');
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

/**
 * One request to the running extension. Rejects with code 'NO_EXTENSION' when none listens or
 * it goes away before answering, and 'TIMEOUT' after `timeoutMs` (0: wait for the answer).
 */
function askBridge(request, path = bridgePath(), { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path);
    const noExtension = message => Object.assign(new Error(message), { code: 'NO_EXTENSION' });
    const timer = timeoutMs > 0 ? setTimeout(() => {
      reject(Object.assign(new Error(`no answer in ${timeoutMs / 1000}s — the query is stopped`), { code: 'TIMEOUT' }));
      sock.destroy();
    }, timeoutMs) : null;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(request) + '\n'));
    sock.on('data', c => { buf += c; });
    sock.on('end', () => {
      try { resolve(JSON.parse(buf)); }
      catch (_) { reject(noExtension('the extension closed the connection without an answer')); }
    });
    sock.on('error', e => {
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
        reject(noExtension('OneLake Studio is not running — open VS Code with the OneLake Studio extension, signed in.'));
      } else reject(e);
    });
    // A reset with no 'end' and no 'error' still has to answer, or the caller waits for nothing.
    sock.on('close', () => {
      clearTimeout(timer);
      reject(noExtension('the extension closed the connection without an answer'));
    });
  });
}

module.exports = { serveBridge, askBridge, EXIT, exitName, failureJson, COMMANDS, checkRequest, MAX_REQUEST };
