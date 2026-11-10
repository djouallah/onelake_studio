'use strict';
// =============================================================================
// server.js — the window's connection to the app, on this machine only
// =============================================================================
// The window is a web page, and a tab's page is an iframe in it, so what they are served from is a
// small HTTP server on two ports: the window's, and the pages'. Messages go out as server-sent events,
// and come back as POSTs to the window's.
//
// It binds 127.0.0.1, and everything but the first request needs a cookie made from a token only this
// process and the window it started know (a cookie is the host's, whatever the port, so the pages have
// it too). As with Excel's endpoint (xmla/server.js), a browser can still send a request here, so a Host
// that isn't this address, or an Origin that isn't the port's own, is refused.
//
// A tab's page can reach only what it could as a webview: its own files. Its port is another origin, so
// it can't reach into the window's page, and the window's port refuses its requests: the messages, and
// the calls that run commands, change settings or close the app, are the window's only. It talks to the
// window as a webview does, by postMessage.
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
//
// A key the window takes (`keys`, which the window names in the page's address) goes to it, and the
// page and the browser leave it: a shortcut works wherever the focus is, and the browser's own (F5,
// Ctrl+P, Ctrl+F) never run. A right-click outside the extension's menus shows nothing, unless it's on
// text to cut, copy or paste.
function bridge(id, nonce, shell, keys) {
  const script = `(() => {
  const id = ${JSON.stringify(String(id))};
  const shell = ${JSON.stringify(String(shell))};
  const keys = new Set(${JSON.stringify(keys).replace(/</g, '\\u003c')});
  const send = m => parent.postMessage(m, shell);
  let state = null;
  try { state = JSON.parse(sessionStorage.getItem('ols-state-' + id)); } catch (_) {}
  window.acquireVsCodeApi = () => ({
    postMessage: msg => send({ olsTab: id, msg }),
    getState: () => state,
    setState: s => { state = s; try { sessionStorage.setItem('ols-state-' + id, JSON.stringify(s)); } catch (_) {} return s; },
  });
  addEventListener('contextmenu', e => {
    const at = e.target instanceof Element ? e.target.closest('[data-vscode-context]') : null;
    if (!at) {
      const editable = e.target instanceof Element && e.target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]');
      if (!editable && !String(getSelection())) e.preventDefault();
      return;
    }
    let context = {};
    try { context = JSON.parse(at.dataset.vscodeContext); } catch (_) {}
    e.preventDefault();
    send({ olsMenu: id, x: e.clientX, y: e.clientY, context });
  }, true);   // before the page's own handler, which may redraw what was clicked
  addEventListener('keydown', e => {
    // As desktop/ui/keys.js names it.
    const key = e.key === ' ' ? 'space' : String(e.key || '').toLowerCase();
    const chord = [e.ctrlKey && 'ctrl', e.shiftKey && 'shift', e.altKey && 'alt', key].filter(Boolean).join('+');
    if (!keys.has(chord)) return;
    e.preventDefault();
    send({ olsKey: id, key: { key: e.key, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey } });
  }, true);
  addEventListener('pointerdown', () => send({ olsFocus: id }), true);
})();`;
  return `<script nonce="${nonce}">${script}</script>`;
}

/** A tab's page, as a webview would have it. `shell` is the window's origin, `keys` the chords it takes. */
function pageFor(html, id, dark, { shell = '', keys = [] } = {}) {
  const nonce = (/'nonce-([^']+)'/.exec(html) || [])[1] || '';
  const head = `<style>${themeCss(dark)}\n${PAGE_DEFAULTS}</style>${bridge(id, nonce, shell, keys)}`;
  const cls = dark ? 'vscode-dark' : 'vscode-light';
  const withBody = /<body[^>]*\bclass="/i.test(html)
    ? html.replace(/(<body[^>]*\bclass=")/i, `$1${cls} `)
    : html.replace(/<body\b/i, `<body class="${cls}"`);
  // A function: `$` in what's inserted is not a replacement pattern.
  return withBody.replace(/<head[^>]*>/i, m => `${m}${head}`);
}

// The chords the window takes, from a page's address: strings only, whatever else is there.
function keysOf(text) {
  try {
    const list = JSON.parse(text || '[]');
    return Array.isArray(list) ? list.filter(k => typeof k === 'string' && k.length < 40).slice(0, 200) : [];
  } catch (_) { return []; }
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
function createServer({ uiDir, extensionDir, pageOf, rpc, roots = ['webview', 'page', 'vendor', 'media'], log = () => {} }) {
  const token = randomBytes(32).toString('hex');
  const clients = new Set();
  let backlog = [];
  let port = 0, pagesPort = 0;

  const origin = () => `http://127.0.0.1:${port}`;
  const pagesOrigin = () => `http://127.0.0.1:${pagesPort}`;

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

  // `pages`: the pages' port, which serves their files and nothing else.
  function handler(req, res, pages) {
    const url = new URL(req.url, 'http://x');
    const path = decodeURIComponent(url.pathname);
    if (req.headers.host !== `127.0.0.1:${pages ? pagesPort : port}`) { res.writeHead(403); res.end(); return; }
    if (req.headers.origin !== undefined && req.headers.origin !== (pages ? pagesOrigin() : origin())) { res.writeHead(403); res.end(); return; }

    // The window's first request: its token becomes a cookie, and leaves the address.
    if (!pages && path === '/' && url.searchParams.has('k')) {
      if (!same(url.searchParams.get('k'), token)) { res.writeHead(403); res.end(); return; }
      res.writeHead(303, { Location: '/', 'Set-Cookie': `ols=${token}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (!same(cookieOf(req), token)) { res.writeHead(403); res.end(); return; }

    // The extension's files, on both: the window's style draws its mark from media/.
    if (path.startsWith('/res/')) {
      const [root] = path.slice(5).split('/');
      if (!roots.includes(root)) { res.writeHead(403); res.end(); return; }
      return serveFile(res, join(extensionDir, path.slice(5)), resolve(extensionDir, root));
    }
    if (pages && path.startsWith('/tab/')) {
      const id = path.slice(5);
      const html = pageOf(id);
      if (html == null) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(pageFor(html, id, url.searchParams.get('dark') === '1', { shell: origin(), keys: keysOf(url.searchParams.get('keys')) }));
      return;
    }
    if (pages) { res.writeHead(404); res.end(); return; }

    if (path === '/') return serveFile(res, join(uiDir, 'index.html'), resolve(uiDir));
    if (path.startsWith('/ui/')) return serveFile(res, join(uiDir, path.slice(4)), resolve(uiDir));
    if (path === '/theme.css') {
      res.writeHead(200, { 'Content-Type': MIME['.css'], 'Cache-Control': 'no-store' });
      res.end(themeCss(url.searchParams.get('dark') === '1'));
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

  const server = http.createServer((req, res) => handler(req, res, false));
  const pagesServer = http.createServer((req, res) => handler(req, res, true));
  const listenOn = s => new Promise((ok, fail) => {
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => ok(s.address().port));
  });
  return {
    push, origin, pagesOrigin,
    url: () => `${origin()}/?k=${token}`,
    /** Where a file of the extension is, for a page. */
    resourceUrl(file) {
      const full = resolve(file);
      const root = resolve(extensionDir);
      if (full !== root && !full.startsWith(root + sep)) throw new Error(`${file} is not this app's`);
      const rel = full.slice(root.length + 1).split(sep).map(encodeURIComponent).join('/');
      return `${pagesOrigin()}/res/${rel}`;
    },
    /** The window's port. The pages' is in pagesOrigin. */
    async listen() {
      port = await listenOn(server);
      pagesPort = await listenOn(pagesServer);
      return port;
    },
    close: () => { for (const res of clients) res.end(); server.close(); pagesServer.close(); },
  };
}

module.exports = { createServer, pageFor, bridge };
