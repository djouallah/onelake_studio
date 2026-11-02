'use strict';
// =============================================================================
// server.js — the window's connection to the app, on this machine only
// =============================================================================
// The window is a web page, and a tab's page is an iframe in it, so what they are served from is a
// small HTTP server: the same origin for all of them, which is what lets the page's scripts load as
// they do from a webview. Messages go out as server-sent events, and come back as POSTs.
//
// It binds 127.0.0.1, and everything but the first request needs a cookie made from a token only this
// process and the window it started know. As with Excel's endpoint (xmla/server.js), a browser can
// still send a request here, so a Host that isn't this address, or an Origin that isn't this server's,
// is refused. A tab's page can reach only what it could as a webview: its own files.
// =============================================================================

const http = require('node:http');
const fs = require('node:fs');
const { join, extname, resolve, sep } = require('node:path');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { themeCss, PAGE_DEFAULTS } = require('./theme');

const MAX_BODY = 64 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

const digest = s => createHash('sha256').update(String(s)).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));
const cookieOf = req => {
  const m = /(?:^|;\s*)ols=([^;]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : '';
};

// What makes a page written for a webview run in an iframe here: acquireVsCodeApi, the messages to
// and from the window, and the right-click and the keys the window has to know of. In the page's own
// CSP, by its nonce.
function bridge(id, nonce) {
  const script = `(() => {
  const id = ${JSON.stringify(String(id))};
  const send = m => parent.postMessage(m, location.origin);
  let state = null;
  try { state = JSON.parse(sessionStorage.getItem('ols-state-' + id)); } catch (_) {}
  window.acquireVsCodeApi = () => ({
    postMessage: msg => send({ olsTab: id, msg }),
    getState: () => state,
    setState: s => { state = s; try { sessionStorage.setItem('ols-state-' + id, JSON.stringify(s)); } catch (_) {} return s; },
  });
  addEventListener('contextmenu', e => {
    const at = e.target instanceof Element ? e.target.closest('[data-vscode-context]') : null;
    if (!at) return;
    let context = {};
    try { context = JSON.parse(at.dataset.vscodeContext); } catch (_) {}
    e.preventDefault();
    send({ olsMenu: id, x: e.clientX, y: e.clientY, context });
  });
  addEventListener('keydown', e => {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'o') { e.preventDefault(); send({ olsKey: 'ctrl+alt+o' }); }
  });
  addEventListener('pointerdown', () => send({ olsFocus: id }), true);
})();`;
  return `<script nonce="${nonce}">${script}</script>`;
}

/** A tab's page, as a webview would have it. */
function pageFor(html, id, dark) {
  const nonce = (/'nonce-([^']+)'/.exec(html) || [])[1] || '';
  const head = `<style>${themeCss(dark)}\n${PAGE_DEFAULTS}</style>${bridge(id, nonce)}`;
  const cls = dark ? 'vscode-dark' : 'vscode-light';
  const withBody = /<body[^>]*\bclass="/i.test(html)
    ? html.replace(/(<body[^>]*\bclass=")/i, `$1${cls} `)
    : html.replace(/<body\b/i, `<body class="${cls}"`);
  // A function: `$` in what's inserted is not a replacement pattern.
  return withBody.replace(/<head[^>]*>/i, m => `${m}${head}`);
}

/**
 * @param {object} o
 * @param {string} o.uiDir  the window's own files
 * @param {string} o.extensionDir
 * @param {(id: string) => string|null} o.pageOf  a tab's HTML
 * @param {(call: object) => Promise<any>} o.rpc  what the window asks
 * @param {string[]} [o.roots]  the folders of the extension a page may load from
 * @param {(line: string) => void} [o.log]
 */
function createServer({ uiDir, extensionDir, pageOf, rpc, roots = ['webview', 'app', 'vendor', 'media'], log = () => {} }) {
  const token = randomBytes(32).toString('hex');
  const clients = new Set();
  let backlog = [];
  let port = 0;

  const origin = () => `http://127.0.0.1:${port}`;

  function push(message) {
    const line = `data: ${JSON.stringify(message)}\n\n`;
    if (!clients.size) { backlog.push(line); return; }
    for (const res of clients) res.write(line);
  }

  function serveFile(res, file, root) {
    const full = resolve(file);
    if (full !== root && !full.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    const stream = fs.createReadStream(full);
    stream.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); });
    stream.on('open', () => {
      res.writeHead(200, { 'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      stream.pipe(res);
    });
  }

  function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = decodeURIComponent(url.pathname);
    if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403); res.end(); return; }
    if (req.headers.origin !== undefined && req.headers.origin !== origin()) { res.writeHead(403); res.end(); return; }

    // The window's first request: its token becomes a cookie, and leaves the address.
    if (path === '/' && url.searchParams.has('k')) {
      if (!same(url.searchParams.get('k'), token)) { res.writeHead(403); res.end(); return; }
      res.writeHead(303, { Location: '/', 'Set-Cookie': `ols=${token}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (!same(cookieOf(req), token)) { res.writeHead(403); res.end(); return; }

    if (path === '/') return serveFile(res, join(uiDir, 'index.html'), resolve(uiDir));
    if (path.startsWith('/ui/')) return serveFile(res, join(uiDir, path.slice(4)), resolve(uiDir));
    if (path === '/theme.css') {
      res.writeHead(200, { 'Content-Type': MIME['.css'], 'Cache-Control': 'no-store' });
      res.end(themeCss(url.searchParams.get('dark') === '1'));
      return;
    }
    if (path.startsWith('/res/')) {
      const [root] = path.slice(5).split('/');
      if (!roots.includes(root)) { res.writeHead(403); res.end(); return; }
      return serveFile(res, join(extensionDir, path.slice(5)), resolve(extensionDir, root));
    }
    if (path.startsWith('/tab/')) {
      const id = path.slice(5);
      const html = pageOf(id);
      if (html == null) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(pageFor(html, id, url.searchParams.get('dark') === '1'));
      return;
    }
    if (path === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      for (const line of backlog) res.write(line);
      backlog = [];
      req.on('close', () => clients.delete(res));
      return;
    }
    if (path === '/rpc' && req.method === 'POST') {
      const chunks = [];
      let size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', async () => {
        let body;
        try {
          const result = await rpc(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          body = JSON.stringify({ ok: true, result: result === undefined ? null : result });
        } catch (e) {
          log(`rpc failed: ${(e && e.stack) || e}`);
          body = JSON.stringify({ ok: false, error: (e && e.message) || String(e) });
        }
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
        res.end(body);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  }

  const server = http.createServer(handler);
  return {
    push, origin,
    url: () => `${origin()}/?k=${token}`,
    /** Where a file of the extension is, for a page. */
    resourceUrl(file) {
      const full = resolve(file);
      const root = resolve(extensionDir);
      if (full !== root && !full.startsWith(root + sep)) throw new Error(`${file} is not this app's`);
      const rel = full.slice(root.length + 1).split(sep).map(encodeURIComponent).join('/');
      return `${origin()}/res/${rel}`;
    },
    listen: () => new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => { port = server.address().port; ok(port); });
    }),
    close: () => { for (const res of clients) res.end(); server.close(); },
  };
}

module.exports = { createServer, pageFor, bridge };
