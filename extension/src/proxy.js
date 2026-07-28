'use strict';
// =============================================================================
// proxy.js — a loopback HTTP proxy that signs OneLake reads
// =============================================================================
// In the browser, sw.js attaches the bearer token to DuckDB's range reads, because
// DuckDB's file API cannot set a header itself. A VS Code webview has no service
// worker to do that with — `navigator.serviceWorker` is undefined there, since VS
// Code runs its own for resource loading and extensions cannot register another.
//
// So the extension host signs them instead. The engine is handed
//   dfsOrigin   = http://127.0.0.1:<port>/<secret>/dfs
//   tableOrigin = http://127.0.0.1:<port>/<secret>/irc
// and everything through them is forwarded upstream with an Authorization header.
// The token never enters the webview at all, which is strictly better than the
// browser build, where the page holds it.
//
// The other half of sw.js — COOP/COEP for crossOriginIsolated — is not replaced and
// is not missed: the engine runs the single-threaded `eh` bundle either way, because
// the wasm_threads build of the avro extension is broken and read_avro is the Iceberg
// manifest reader.
//
// No `vscode` import anywhere in this file: the token arrives as an injected async
// function. That is what lets test/run-proxy.mjs drive it against a fake OneLake
// with no editor running.
// =============================================================================

const http = require('node:http');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const DFS_UPSTREAM = 'https://onelake.dfs.fabric.microsoft.com';
const TABLE_UPSTREAM = 'https://onelake.table.fabric.microsoft.com';

// Response headers something downstream actually reads:
//   content-length  — how DuckDB sizes a file, including from a HEAD
//   accept-ranges   — without it DuckDB stops issuing ranges and pulls whole files
//   content-range   — the 206 itself
//   x-ms-continuation — how listPaths pages a large directory
// A cross-origin reader sees NONE of these unless they are named in expose-headers,
// so this list is also the CORS allowlist below. Dropping a name here fails quietly:
// the read still succeeds, it just gets slow or truncated.
const PASS_THROUGH = [
  'content-type', 'content-length', 'content-range', 'accept-ranges',
  'etag', 'last-modified', 'x-ms-continuation',
];

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
  // Range is not a CORS-safelisted request header, so the webview sends a preflight
  // ahead of every ranged read and this has to answer it.
  res.setHeader('access-control-allow-headers', 'range, accept, content-type');
  res.setHeader('access-control-expose-headers', PASS_THROUGH.join(', '));
  res.setHeader('access-control-max-age', '86400');
}

// Constant-time, because the secret is the only thing standing between a local
// process — or a page the user visits, which can also reach loopback — and the whole
// of their OneLake.
function sameSecret(given, secret) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// /<secret>/dfs/<rest>?<query>  ->  { kind: 'dfs', rest: '/<rest>', query: '?<query>' }
// Two prefixes rather than one so a workspace name can never be mistaken for a route.
function route(reqUrl, secret) {
  const q = reqUrl.indexOf('?');
  const path = q === -1 ? reqUrl : reqUrl.slice(0, q);
  const query = q === -1 ? '' : reqUrl.slice(q);
  const m = /^\/([^/]+)\/(dfs|irc)(\/.*)?$/.exec(path);
  if (!m || !sameSecret(m[1], secret)) return null;
  return { kind: m[2], rest: m[3] || '/', query };
}

async function handle(req, res, opts) {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end('proxy serves GET and HEAD only');
  }

  const r = route(req.url, opts.secret);
  // Same answer for a bad secret and a bad path: nothing here confirms a guess.
  if (!r) { res.writeHead(404); return res.end('not a proxied path'); }

  let token = null;
  try { token = await opts.getToken(); } catch (_) { /* treated as no session */ }
  if (!token) { res.writeHead(401); return res.end('no Microsoft account session'); }

  const upstream = (r.kind === 'dfs' ? opts.dfsUpstream : opts.tableUpstream) + r.rest + r.query;
  // Built fresh rather than forwarded: whatever the page sent, the token is ours.
  const headers = { authorization: 'Bearer ' + token };
  if (req.headers.range) headers.range = req.headers.range;
  if (req.headers.accept) headers.accept = req.headers.accept;

  let up;
  try {
    up = await fetch(upstream, { method: req.method, headers, redirect: 'follow' });
  } catch (e) {
    res.writeHead(502);
    return res.end(`proxy could not reach OneLake: ${(e && e.message) || e}`);
  }

  const out = {};
  for (const h of PASS_THROUGH) {
    const v = up.headers.get(h);
    if (v !== null) out[h] = v;
  }
  // Upstream's status is passed through untouched — 206, and 401/403/404, all of which
  // the engine reads and turns into its own diagnosis.
  res.writeHead(up.status, out);
  if (req.method === 'HEAD' || !up.body) return res.end();
  Readable.fromWeb(up.body).pipe(res);
}

// Resolves to { port, secret, dfsOrigin, tableOrigin, close() }.
function startProxy({ getToken, dfsUpstream = DFS_UPSTREAM, tableUpstream = TABLE_UPSTREAM } = {}) {
  if (typeof getToken !== 'function') throw new TypeError('startProxy needs a getToken() function');

  const secret = crypto.randomBytes(24).toString('hex');
  const opts = { getToken, dfsUpstream, tableUpstream, secret };

  const server = http.createServer((req, res) => {
    handle(req, res, opts).catch(e => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String((e && e.message) || e));
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // 127.0.0.1 explicitly, never 0.0.0.0 — this port hands out the user's OneLake to
    // anything that can reach it, and the secret is the only other lock.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}/${secret}`;
      resolve({
        port,
        secret,
        dfsOrigin: `${base}/dfs`,
        tableOrigin: `${base}/irc`,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

module.exports = { startProxy, PASS_THROUGH };
