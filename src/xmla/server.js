'use strict';
// =============================================================================
// server.js — the XMLA endpoint Excel connects to, on this machine only
// =============================================================================
// Excel's provider speaks HTTP, so this is the one port the extension opens. It binds 127.0.0.1,
// and a request has to name a token no web page or other user can read. A browser can still send
// a request here, so anything with an Origin is refused, and a Host that isn't this address, which
// is what DNS rebinding would show. Everything it reads goes through the same guard as any query.
//
// One window serves at a time, as the command line's bridge does (bridge.js): another finds the
// port taken by this server and tries again later. Port and token stay the same across reloads,
// since a saved workbook holds them and refreshes on them.
// =============================================================================
const http = require('node:http');
const { randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { parseRequest, discoverResponse, executeResponse, EMPTY_ROOT, fault } = require('./soap.js');
const { WITHOUT_MODEL, discoverServer, discover } = require('./rowsets.js');
const { execute, literal } = require('./cellset.js');

const MAX_REQUEST = 32 * 1024 * 1024;   // a deselected item is listed by name, and there may be many
const RETRY_MS = 30_000;
const PING = 'onelake-studio-xmla';

const digest = s => createHash('sha256').update(String(s)).digest();
const sameToken = (a, b) => timingSafeEqual(digest(a), digest(b));

/**
 * `backend.cube(catalog)` -> the cube of a model (cube.js), or throws why it can't be read.
 * `backend.query(sql, { signal })` -> { fields, rows, numRows }, a model SELECT run as any query.
 */
function createHandler({ token, port, backend, log = () => {} }) {
  const expectedHost = `127.0.0.1:${port}`;
  return function handler(req, res) {
    const reply = (status, type, body) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    const parts = String(req.url || '').split('?')[0].split('/').filter(Boolean);
    if (req.headers.host !== expectedHost || req.headers.origin !== undefined) { req.resume(); return reply(403, 'text/plain', 'Forbidden'); }
    if (parts.length !== 1 || !sameToken(parts[0], token)) { req.resume(); return reply(404, 'text/plain', 'Not found'); }
    if (req.method === 'GET') return reply(200, 'text/plain', PING);
    if (req.method !== 'POST') { req.resume(); return reply(405, 'text/plain', 'POST'); }
    const type = String(req.headers['content-type'] || '');
    if (!/xml/i.test(type) || /xpress|sx/i.test(type)) { req.resume(); return reply(415, 'text/plain', 'Plain XML only: Protocol Format=XML'); }

    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_REQUEST) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      const gone = new AbortController();
      let asked = 'a request';
      const t0 = Date.now();
      // Excel gave up on it: cancelled, or closed. Its statement stops, and this says so.
      res.on('close', () => {
        if (res.writableFinished) return;
        log(`xmla: Excel dropped ${asked} after ${Date.now() - t0}ms`);
        gone.abort();
      });
      let session = null;
      try {
        const r = parseRequest(Buffer.concat(chunks).toString('utf8'));
        asked = r.requestType || (r.statement ? `the statement ${r.statement.replace(/\s+/g, ' ').slice(0, 200)}` : 'a request');
        session = r.begin ? randomUUID() : r.sessionId;
        reply(200, 'text/xml; charset=utf-8', await answer(r, session, gone.signal));
      } catch (e) {
        log(`xmla: ${e.message}`);
        if (!res.headersSent) reply(200, 'text/xml; charset=utf-8', fault(session, e.message));
      }
    });
    return undefined;
  };

  async function answer(r, session, signal) {
    if (r.end) return executeResponse(null, EMPTY_ROOT);
    if (r.requestType) {
      if (WITHOUT_MODEL.has(r.requestType)) return discoverResponse(session, discoverServer(r.requestType, r.restrictions, r.catalog));
      const catalog = r.catalog || r.restrictions.CATALOG_NAME?.[0];
      if (!catalog) throw new Error(`No semantic model named for ${r.requestType}: open the workbook from OneLake Studio.`);
      const cube = await backend.cube(catalog);
      return discoverResponse(session, await discover(cube, r.requestType, r.restrictions, { query: backend.query, literal, signal }));
    }
    if (!r.statement || !r.statement.trim()) return executeResponse(session, EMPTY_ROOT);
    if (!r.catalog) throw new Error('No semantic model named: open the workbook from OneLake Studio.');
    const cube = await backend.cube(r.catalog);
    return executeResponse(session, await execute(r.statement, { cube, query: backend.query, literal, signal }));
  }
}

/**
 * Serve until dispose(). `port` may be taken: by a window of ours, which is left to serve until it
 * closes, or by something else, which `onPortLost` is told about so a new port can be chosen.
 */
function serveXmla({ port, token, backend, log = () => {}, onPortLost = () => {} }) {
  let server = null, timer = null, disposed = false;

  function ours() {
    return new Promise(resolve => {
      const req = http.get({ host: '127.0.0.1', port, path: `/${token}`, headers: { Host: `127.0.0.1:${port}` }, timeout: 2000 }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; });
        res.on('end', () => resolve(res.statusCode === 200 && body === PING));
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
  }

  function start() {
    if (disposed) return;
    server = http.createServer(createHandler({ token, port, backend, log }));
    server.on('error', async e => {
      server = null;
      if (e.code !== 'EADDRINUSE') { log(`xmla: ${e.message}`); return; }
      if (await ours()) { if (!disposed) timer = setTimeout(start, RETRY_MS); return; }
      log(`xmla: port ${port} is taken by something else`);
      onPortLost();
    });
    server.listen(port, '127.0.0.1', () => log(`xmla: serving Excel on 127.0.0.1:${port}`));
  }
  start();

  return {
    dispose() {
      disposed = true;
      clearTimeout(timer);
      if (server) { try { server.close(); server.closeAllConnections?.(); } catch (_) {} }
    },
  };
}

module.exports = { createHandler, serveXmla, PING };
