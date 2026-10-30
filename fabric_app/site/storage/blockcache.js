// =============================================================================
// blockcache.js — the local store DuckDB reads its files from, and its only way out
// =============================================================================
// A classic script, loaded into DuckDB's worker before the engine (data.js). DuckDB reads
// nothing from the network: the page downloads every file a table needs (prefetch.js) and
// hands it to this store before the table's view is created, and DuckDB reads the files by
// names registered to https://store.local/... (duckdb-wasm's own HTTP file system; no httpfs).
// store.local is not a host: this script answers it from the store, and a file the store does
// not hold is an error (404), not a request. No SAS ever reaches this worker.
// The one other request a worker may make is DuckDB downloading its extensions from the site's
// own copy (self.DUCKDB_EXT_REPO, set by data.js: <site>/vendor/duckdb-ext/v<version>/wasm_eh/...),
// each kept here whole after its first load (a file under its version never changes). Every
// other request is refused: SQL typed in Explore cannot reach any URL, DuckDB's repository
// included.
//
// A file is kept in OPFS in blocks of BLOCK bytes under its OneLake path without the SAS
// (https://onelake.dfs.fabric.microsoft.com/<ws>/<lh>/...; store.local/<ws>/<lh>/... reads it).
// An Iceberg file is never rewritten in place, so a block is never checked again. duckdb-wasm
// asks a HEAD with Range: bytes=0- first and reads by range only if that answers 206 with a
// Content-Length; then the footer, then column chunks.
//
// Two OPFS files, in blockcache/: blocks.bin (the blocks, appended) and index.jsonl (where
// each block is, and each file's size), read back at start. Over CAP_BYTES the store starts
// over. Every worker opens them 'readwrite-unsafe', the one mode two handles share (Chrome 121+;
// 'read-only' fails while a 'readwrite' handle is open, checked 2026-10-28). Two roles:
//   - each DuckDB worker (each of the page's engines, in every tab) READS: it answers DuckDB
//     from what the writer has kept and reads the index again on a miss (both files only grow,
//     until the writer starts the store over);
//   - each tab's store worker (data.js, self.BLOCKCACHE_ROLE = 'writer') may WRITE: one of them,
//     the holder of the Web Lock 'blockcache-writer', for its lifetime. The others wait in the
//     lock's queue; when the writer's tab closes, the lock passes to the next of them.
// A file the page downloaded goes to its own tab's store worker, transferred (not copied); one
// that does not write passes it on to the one that does (BroadcastChannel 'blockcache-store',
// which only store workers listen to) and holds it until that one says it kept it.
// The index's first line names the store's generation (`gen`), new each time the writer starts
// it over: a reader whose generation is not the file's drops what it holds, so it never reads
// blocks at another store's offsets.
//
// The page's channel (BroadcastChannel 'blockcache'), to every tab's worker:
//   { ping }           the writer answers { writer: true } (it also says so when it becomes one);
//   { reset }          the writer started the store over (sent by the writer to the readers);
//   { missing, id }    store paths: the writer answers { id, missing } with those it does not
//                      hold whole;
//   { stats, id }      the writer answers { id, stats: { files, bytes } } (the Logs tab);
//   { stored }         the writer kept a file it was handed, or { stored, error } when it
//                      could not. Not the browser's HTTP cache: it does not keep a response of
//                      70-100 MB.
// A file reaches the writer as { store, bytes }: posted by the page to its tab's store worker,
// or on 'blockcache-store' between store workers (and from a DuckDB worker, an extension).
// =============================================================================
(() => {
  const WRITER = self.BLOCKCACHE_ROLE === 'writer';   // this tab's store worker, else a DuckDB worker
  const BLOCK = 256 * 1024;
  // Whole files of every table read, and over the cap the store starts over: the cap is well
  // above what a model's tables hold, so it has room to grow.
  const CAP_BYTES = 64 * 1024 * 1024 * 1024;
  const VERSION = 1;
  const LOCAL = 'https://store.local/';
  const ONELAKE = 'https://onelake.dfs.fabric.microsoft.com/';

  const P = XMLHttpRequest.prototype, open = P.open, set = P.setRequestHeader, send = P.send;
  let blocks = null, index = null;   // OPFS access handles, once open
  let writable = false;              // this worker is the writer: it keeps what it is handed
  let indexRead = 0;                 // bytes of index.jsonl applied (a reader reads on)
  let gen = null;                    // the store's generation, from the index's first line
  const where = new Map();           // `${path}#${n}` -> [offset, length] in blocks.bin
  const files = new Map();           // path -> { size }
  let end = 0;                       // bytes in blocks.bin
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const pathOf = u => String(u).split('?')[0];
  const EXT_REPO = String(self.DUCKDB_EXT_REPO || '');
  const isExtension = u => !!EXT_REPO && pathOf(u).startsWith(EXT_REPO + '/') &&
    /^v[^/]+\/wasm_[a-z]+\/[\w-]+\.duckdb_extension\.wasm$/i.test(pathOf(u).slice(EXT_REPO.length + 1));
  const isLocal = u => String(u).startsWith(LOCAL);
  // A store.local URL is the store path of the OneLake file it names.
  const storeKey = u => ONELAKE + pathOf(u).slice(LOCAL.length);

  function log(entry) {
    if (!writable) return;
    const b = enc.encode(JSON.stringify(entry) + '\n');
    index.write(b, { at: index.getSize() });
    indexRead = index.getSize();
  }
  function reset() {
    blocks.truncate(0); index.truncate(0); where.clear(); files.clear(); end = 0; indexRead = 0;
    gen = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    log({ v: VERSION, block: BLOCK, gen });
    try { bc?.postMessage({ reset: true }); } catch (e) {}
  }
  // What a reader holds, dropped: the store was started over.
  function forget() { where.clear(); files.clear(); indexRead = 0; gen = null; }
  // The index's lines not applied yet: all of them at start, and for a reader what the
  // writer added since. The first line is the store's version; a store of another version is
  // reset by its writer, and a reader leaves it alone and holds nothing.
  // A block line whose bytes are not in blocks.bin yet (indexed, not flushed) stops the read
  // there, and the next one starts from it: the line is not lost. For the writer starting up,
  // such a line is a write a closed tab never finished, and the store starts over (false).
  function applyIndex({ starting = false } = {}) {
    const size = index.getSize();
    if (size <= indexRead) return true;
    const buf = new Uint8Array(size - indexRead);
    index.read(buf, { at: indexRead });
    end = blocks.getSize();
    let at = 0;   // bytes of buf applied
    for (;;) {
      const nl = buf.indexOf(10, at);
      if (nl < 0) break;   // a line the writer has not finished
      let e = null;
      try { e = JSON.parse(dec.decode(buf.subarray(at, nl))); } catch (x) {}
      if (e?.k && e.o + e.l > end) {
        if (starting) return false;
        break;
      }
      if (e?.v !== undefined) {
        if (e.v !== VERSION || e.block !== BLOCK) return false;   // nothing applied: holds nothing
        gen = e.gen ?? null;
      } else if (e?.k) where.set(e.k, [e.o, e.l]);
      else if (e?.f && !files.has(e.f)) files.set(e.f, { size: e.s });
      at = nl + 1;
    }
    indexRead += at;
    return true;
  }
  // A reader checks that the store is still the one it read (its generation, and an index no
  // shorter than what it applied) before it reads blocks at the offsets it holds.
  function sameStore() {
    if (writable || !index) return;
    const size = index.getSize();
    if (size < indexRead) return forget();
    const head = new Uint8Array(Math.min(256, size));
    index.read(head, { at: 0 });
    const nl = head.indexOf(10);
    let first = null;
    try { first = nl < 0 ? null : JSON.parse(dec.decode(head.subarray(0, nl))); } catch (e) {}
    if (!first) { if (indexRead) forget(); return; }   // being started over right now
    if ((first.gen ?? null) !== gen && indexRead) forget();
  }
  function freshIndex() {
    sameStore();
    return applyIndex();
  }
  // A file kept whole: its size known and every block of it in the store.
  function whole(path) {
    const f = files.get(path);
    if (!f || !(f.size > 0)) return false;
    for (let n = 0; n * BLOCK < f.size; n++) if (!where.has(`${path}#${n}`)) return false;
    return true;
  }

  const announce = () => { try { bc?.postMessage({ writer: true }); } catch (e) {} };
  // This worker writes from now on: from what the index says, or from an empty store when the
  // index is of another version, holds a write never finished, or the store is over its cap.
  function becomeWriter() {
    if (writable || !blocks) return;
    sameStore();
    writable = true;
    if (!applyIndex({ starting: true }) || index.getSize() === 0 || blocks.getSize() > CAP_BYTES) reset();
    end = blocks.getSize();
    announce();
    // What this tab handed over while another worker wrote, kept now.
    for (const [path, bytes] of [...pending]) { pending.delete(path); keepAndSay(path, bytes); }
  }
  // The writer's lock, waited for: granted at once when no one holds it, else when the
  // worker holding it ends (its tab closed), and held until this worker ends. Without the Locks
  // API the handles are exclusive anyway (a browser before 121 ignores the mode), so the worker
  // that opened them writes.
  function waitToWrite() {
    if (!WRITER) return;   // a DuckDB worker only reads
    if (!navigator.locks) return becomeWriter();
    navigator.locks.request('blockcache-writer', () => { becomeWriter(); return new Promise(() => {}); })
      .catch(() => {});
  }

  let bc = null;
  (async () => {
    let dir;
    try { dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('blockcache', { create: true }); }
    catch (e) { return; }   // no OPFS: no store, and nothing for DuckDB to read
    try {
      const bh = await dir.getFileHandle('blocks.bin', { create: true });
      const ih = await dir.getFileHandle('index.jsonl', { create: true });
      const b = await bh.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
      const i = await ih.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
      blocks = b; index = i; end = b.getSize();
      applyIndex();   // a store of another version: nothing is applied until a writer resets it
    } catch (e) { blocks = index = null; return; }   // a writer of an older build holds it exclusively
    waitToWrite();
  })();

  try {
    bc = new BroadcastChannel('blockcache');
    bc.onmessage = async e => {
      const d = e.data ?? {};
      if (d.ping && writable) announce();
      if (d.missing && d.id != null && writable) bc.postMessage({ id: d.id, missing: d.missing.filter(p => !whole(p)) });
      if (d.stats && d.id != null && writable) bc.postMessage({ id: d.id, stats: { files: files.size, bytes: end } });
      if (d.reset && !writable) forget();
      if (WRITER) {
        // Kept by the writer (this tab's file, or another's): no longer held here.
        if (d.stored) pending.delete(d.stored);
        // A new writer, after a tab closed: what this tab still holds is handed to it.
        if (d.writer && !writable) for (const [path, bytes] of pending) pass(path, bytes);
      }
    };
  } catch (e) {}

  // The files handed to the writer. `pending`: this tab's, held until the writer says it kept
  // them (a store worker that does not write).
  const pending = new Map();   // path -> bytes
  // Only a store worker keeps 'blockcache-store' open: a channel gets its own copy of every
  // message, listened to or not, so a DuckDB worker opens one just to send (an extension).
  let storeBc = null;
  if (WRITER) { try { storeBc = new BroadcastChannel('blockcache-store'); } catch (e) {} }
  const pass = (path, bytes) => {
    try {
      if (storeBc) return storeBc.postMessage({ store: path, bytes });
      const once = new BroadcastChannel('blockcache-store');
      once.postMessage({ store: path, bytes });
      once.close();
    } catch (e) {}
  };
  function keepAndSay(path, bytes) {
    let error = null;
    try { const b = new Uint8Array(bytes); keep(path, b, b.length); }
    catch (x) { error = String(x?.message || x); }
    try { bc?.postMessage(error ? { stored: path, error } : { stored: path }); } catch (e) {}
  }
  function storeBytes(path, bytes) {
    if (writable) return keepAndSay(path, bytes);
    pending.set(path, bytes);
    pass(path, bytes);
  }
  if (WRITER) {
    // From this tab's page, transferred.
    self.onmessage = e => { const d = e.data ?? {}; if (d.store && d.bytes) storeBytes(d.store, d.bytes); };
    // From the other tabs' store workers, and the DuckDB workers' extensions: the writer keeps them.
    if (storeBc) storeBc.onmessage = e => { const d = e.data ?? {}; if (writable && d.store && d.bytes) keepAndSay(d.store, d.bytes); };
  }

  // A response DuckDB reads as if it came from a server: status, bytes and the headers it asks.
  function answer(xhr, status, body, headers = {}) {
    const h = Object.fromEntries(Object.entries(headers).filter(([, v]) => v != null).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const text = { 200: 'OK', 206: 'Partial Content', 403: 'Forbidden', 404: 'Not Found' }[status] ?? '';
    const props = { status, readyState: 4, statusText: text, response: body, responseURL: xhr.__bcU };
    for (const [k, v] of Object.entries(props)) Object.defineProperty(xhr, k, { value: v, configurable: true });
    xhr.getResponseHeader = k => h[String(k).toLowerCase()] ?? null;
    xhr.getAllResponseHeaders = () => Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  }

  // The bytes [a, b] of `path` from the store, or null when a block is missing.
  function fromStore(path, a, b) {
    const out = new Uint8Array(b - a + 1);
    for (let n = Math.floor(a / BLOCK); n <= Math.floor(b / BLOCK); n++) {
      const at = where.get(`${path}#${n}`);
      if (!at) return null;
      const block = new Uint8Array(at[1]);
      blocks.read(block, { at: at[0] });
      const s = Math.max(a, n * BLOCK), e = Math.min(b, n * BLOCK + at[1] - 1);
      out.set(block.subarray(s - n * BLOCK, e - n * BLOCK + 1), s - a);
    }
    return out;
  }

  // Keeps a whole file, `body` of `size` bytes, as blocks (the writer only). Over the browser's
  // quota the store starts over and the file is written once more: a full store that failed
  // every write from then on would never hold a table again.
  function keep(path, body, size, retried = false) {
    if (!writable) return;
    if (end > CAP_BYTES) reset();   // before the size is recorded: a reset clears it
    try {
      if (!files.has(path)) { files.set(path, { size }); log({ f: path, s: size }); }
      for (let n = 0; n * BLOCK < size; n++) {
        const key = `${path}#${n}`;
        const len = Math.min(BLOCK, size - n * BLOCK);
        if (where.has(key)) continue;
        blocks.write(body.subarray(n * BLOCK, n * BLOCK + len), { at: end });
        where.set(key, [end, len]);
        log({ k: key, o: end, l: len });
        end += len;
      }
      blocks.flush(); index.flush();
    } catch (e) {
      if (e?.name !== 'QuotaExceededError' || retried) throw e;
      reset();
      keep(path, body, size, true);
    }
  }

  // A store.local read, answered from the store: a HEAD (its size; 206 when asked with a
  // range, as duckdb-wasm checks), a range, or the whole file. Not held: 404.
  function local(xhr) {
    if (!blocks || (xhr.__bcM !== 'GET' && xhr.__bcM !== 'HEAD')) return answer(xhr, 404, null);
    const path = storeKey(xhr.__bcU);
    sameStore();
    let f = files.get(path);
    if (!f || !whole(path)) { freshIndex(); f = files.get(path); }   // the writer may have it by now
    if (!f || !whole(path)) return answer(xhr, 404, null);
    const r = /^bytes=(\d+)-(\d*)$/.exec(xhr.__bcR || '');
    if (xhr.__bcM === 'HEAD') return answer(xhr, r ? 206 : 200, null, { 'Content-Length': f.size, 'Accept-Ranges': 'bytes' });
    const a = r ? Number(r[1]) : 0, b = r && r[2] !== '' ? Math.min(Number(r[2]), f.size - 1) : f.size - 1;
    if (a > b) return answer(xhr, 404, null);
    const out = fromStore(path, a, b);
    if (!out) return answer(xhr, 404, null);
    return answer(xhr, r ? 206 : 200, out.buffer, { 'Content-Length': out.length, 'Accept-Ranges': 'bytes',
      ...(r ? { 'Content-Range': `bytes ${a}-${b}/${f.size}` } : {}) });
  }

  // Only a DuckDB worker's requests are answered from the store; the store worker makes none.
  if (WRITER) return;
  P.open = function (m, u, ...r) {
    this.__bcM = String(m).toUpperCase(); this.__bcU = String(u); this.__bcR = null;
    return open.call(this, m, u, ...r);
  };
  P.setRequestHeader = function (k, v) {
    if (String(k).toLowerCase() === 'range') this.__bcR = String(v);
    return set.call(this, k, v);
  };
  P.send = function (body) {
    if (isLocal(this.__bcU)) return local(this);
    if (!isExtension(this.__bcU)) return answer(this, 403, null);   // nothing else leaves this worker
    // An extension: from the store, else from DuckDB's repository, then kept.
    const path = pathOf(this.__bcU);
    try {
      if (blocks) sameStore();
      if (blocks && this.__bcM === 'GET' && !this.__bcR && (whole(path) || (freshIndex() && whole(path)))) {
        const out = fromStore(path, 0, files.get(path).size - 1);
        if (out) return answer(this, 200, out.buffer, { 'Content-Length': out.length });
      }
    } catch (e) {}
    const r = send.call(this, body);
    try {
      if (blocks && this.__bcM === 'GET' && !this.__bcR && this.status === 200 && this.response?.byteLength) {
        const bytes = new Uint8Array(this.response);
        if (writable) keep(path, bytes, bytes.length);
        else pass(path, bytes);   // the writer keeps it
      }
    } catch (e) {}
    return r;
  };
})();
