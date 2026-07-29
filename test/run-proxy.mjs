// Verifies extension/src/proxy.js — the thing that replaces sw.js in a VS Code webview.
//
// Two halves, and the second is the one that mattered enough to build this before any
// extension UI: DuckDB-WASM must issue RANGE reads against a loopback URL that carries a
// path prefix (http://127.0.0.1:<port>/<secret>/dfs/...). If it instead downloaded whole
// files, or refused the cross-origin read, the whole extension design is wrong — and the
// symptom in the app would be "slow", not "broken", which is the kind of thing that ships.
//
// No editor and no credentials: proxy.js takes its token as an injected function, and the
// upstream here is a fake OneLake that checks for it.
//
// Run: node test/run-proxy.mjs
import http from "node:http";
import { readFile, writeFile, stat, mkdir, mkdtemp, rm, readdir, utimes } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

import { startProxy } from "../extension/src/proxy.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const FIXTURE = join(root, "test", "fixtures", "sample.parquet");
const TOKEN = "test-token-not-a-real-one";
const PAGE_PORT = 5199;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("ok  —", msg); }
                            else { fail++; console.log("FAIL—", msg); } };
const eq = (got, want, msg) =>
  ok(got === want, `${msg}${got === want ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);

// --- a parquet big enough that reading it whole is distinguishable from ranging it ----
async function fixture() {
  try { const s = await stat(FIXTURE); if (s.size > 1_000_000) return; } catch (_) {}
  await mkdir(join(root, "test", "fixtures"), { recursive: true });
  console.log("generating test/fixtures/sample.parquet ...");
  execFileSync("duckdb", ["-c",
    `COPY (SELECT i AS id, i * 2 AS d, 'row ' || i AS s FROM range(400000) t(i))` +
    ` TO '${FIXTURE.replace(/\\/g, "/")}' (FORMAT PARQUET)`], { stdio: "inherit" });
}

// --- fake OneLake: demands the bearer token, serves ranges, and keeps a log ------------
function fakeUpstream(body) {
  const log = [];
  const server = http.createServer((req, res) => {
    log.push({ method: req.method, url: req.url, range: req.headers.range || null,
               auth: req.headers.authorization || null });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end("upstream saw no bearer token"); return;
    }
    if (req.url.startsWith("/paged")) {
      res.writeHead(200, { "content-type": "application/json", "x-ms-continuation": "next-page" });
      res.end(JSON.stringify({ paths: [] })); return;
    }
    if (req.url.startsWith("/iceberg")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ from: "table-endpoint" })); return;
    }
    const head = { "content-type": "application/octet-stream", "accept-ranges": "bytes" };
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
      const slice = body.subarray(start, end + 1);
      res.writeHead(206, { ...head, "content-length": String(slice.length),
                           "content-range": `bytes ${start}-${end}/${body.length}` });
      res.end(req.method === "HEAD" ? undefined : slice); return;
    }
    res.writeHead(200, { ...head, "content-length": String(body.length) });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  return { server, log };
}

await fixture();
const parquet = await readFile(FIXTURE);
console.log(`fixture: ${(parquet.length / 1e6).toFixed(1)} MB\n`);

const { server: upstream, log } = fakeUpstream(parquet);
await new Promise(r => upstream.listen(0, "127.0.0.1", r));
const upBase = `http://127.0.0.1:${upstream.address().port}`;

let token = TOKEN;
// Every call the proxy makes, with the options it passed — the retry path is only
// observable from here.
const tokenCalls = [];
const CACHE_DIR = await mkdtemp(join(tmpdir(), "onelake-proxy-cache-"));
const proxy = await startProxy({
  getToken: async opts => { tokenCalls.push(opts); return opts && opts.fresh ? TOKEN : token; },
  cacheDir: CACHE_DIR,
  dfsUpstream: upBase,
  tableUpstream: `${upBase}`,
});

// =============================================================================
// Part 1 — the proxy on its own
// =============================================================================
console.log("--- proxy behaviour ---");
{
  const r = await fetch(`${proxy.dfsOrigin}/ws/f.parquet`, { method: "HEAD" });
  eq(r.status, 200, "HEAD is proxied");
  eq(r.headers.get("content-length"), String(parquet.length),
     "HEAD forwards content-length (DuckDB sizes files from it)");
  eq(r.headers.get("accept-ranges"), "bytes",
     "accept-ranges survives (without it DuckDB stops ranging)");
  ok(log.at(-1).auth === `Bearer ${TOKEN}`, "the proxy attached the bearer token");
}
{
  const r = await fetch(`${proxy.dfsOrigin}/ws/f.parquet`, { headers: { Range: "bytes=0-99" } });
  eq(r.status, 206, "a ranged GET comes back 206");
  eq(r.headers.get("content-range"), `bytes 0-99/${parquet.length}`, "content-range survives");
  eq((await r.arrayBuffer()).byteLength, 100, "and the body is just that range");
}
{
  const r = await fetch(`${proxy.dfsOrigin}/paged?resource=filesystem`);
  eq(r.headers.get("x-ms-continuation"), "next-page",
     "x-ms-continuation survives (listPaths pages on it)");
  const exposed = r.headers.get("access-control-expose-headers") || "";
  ok(exposed.includes("x-ms-continuation") && exposed.includes("content-range") &&
     exposed.includes("accept-ranges") && exposed.includes("content-length"),
     "…and every header a cross-origin reader needs is in expose-headers");
}
{
  const r = await fetch(`${proxy.tableOrigin}/iceberg/v1/config`);
  eq((await r.json()).from, "table-endpoint", "the irc route reaches the table endpoint");
}
{
  const r = await fetch(`${proxy.dfsOrigin}/ws/f.parquet`, { method: "OPTIONS" });
  eq(r.status, 204, "the preflight is answered");
  ok((r.headers.get("access-control-allow-headers") || "").includes("range"),
     "…and it allows Range, which is what makes it a preflight at all");
}
{
  const bad = proxy.dfsOrigin.replace(proxy.secret, "0".repeat(proxy.secret.length));
  eq((await fetch(`${bad}/ws/f.parquet`)).status, 404, "a wrong secret gets nothing");
  eq((await fetch(`http://127.0.0.1:${proxy.port}/ws/f.parquet`)).status, 404,
     "and so does a path with no secret at all");
  eq((await fetch(`${proxy.dfsOrigin}/ws/f.parquet`, { method: "PUT" })).status, 405,
     "writes are refused outright");
}
{
  token = null;
  eq((await fetch(`${proxy.dfsOrigin}/ws/f.parquet`)).status, 401, "no session -> 401, not a hang");
  token = TOKEN;
}
// The caller caches the token — it has to, or every range read costs a lookup in the
// account provider, which is what made the panel slower than the browser build. So an
// expiry now surfaces HERE, as a 401 from upstream, and the proxy has to ask again with
// `fresh` rather than hand the failure back.
{
  const before = tokenCalls.length;
  token = "stale-token";
  const r = await fetch(`${proxy.dfsOrigin}/ws/f.parquet`, { headers: { range: "bytes=0-15" } });
  eq(r.status, 206, "a stale cached token is retried, not reported");
  eq(tokenCalls.slice(before).some(c => c && c.fresh === true), true,
     "...and the retry asked for a fresh one, which is the only thing that could help");
  token = TOKEN;
}
{
  const before = tokenCalls.length;
  token = TOKEN;
  await fetch(`${proxy.dfsOrigin}/ws/f.parquet`, { headers: { range: "bytes=0-15" } });
  eq(tokenCalls.slice(before).length, 1, "a read that works asks for the token exactly once");
}

// --- the data cache: sw.js's rules, on disk, for the webview -----------------------------
// The browser build has kept immutable Iceberg objects since sw.js started caching them,
// and the panel had nothing — which is why opening the same table twice was slower here
// than on the website. The rules are copied, so what must NOT be cached is as much of the
// test as what must.
const TABLE_FILE = `${proxy.dfsOrigin}/ws/lh.Lakehouse/Tables/t/data_0.parquet`;
{
  // A cold ranged read is served exactly as asked — and triggers ONE background fetch of
  // the whole object, because the next range will be different and the object never will
  // be. This is the fix for the original disease: the old design stored the slice under
  // its range, and nothing ever asked for the same slice twice.
  const RANGED_FILE = `${proxy.dfsOrigin}/ws/lh.Lakehouse/Tables/t/data_r.parquet`;
  const before = log.length;
  const a = await fetch(RANGED_FILE, { headers: { Range: "bytes=0-99" } });
  const aBody = Buffer.from(await a.arrayBuffer());
  eq(a.status, 206, "a cold ranged read is answered");
  ok(aBody.equals(parquet.subarray(0, 100)), "…with exactly those bytes");
  await proxy.cacheIdle();
  const mine = log.slice(before);
  eq(mine.length, 2, "…and costs two upstream requests: the slice, and one whole-object fill");
  eq(mine.filter(x => !x.range).length, 1, "…where the fill asked for the object, not a range");

  const at = log.length;
  const b = await fetch(RANGED_FILE, { headers: { Range: "bytes=200-299" } });
  const bBody = Buffer.from(await b.arrayBuffer());
  eq(b.status, 206, "a DIFFERENT range afterwards is a 206");
  eq(log.length, at, "…served locally — the read shape that used to refetch every time");
  ok(bBody.equals(parquet.subarray(200, 300)), "…byte-exact");
}
{
  // Many cold ranged reads of one object at once: one fill between them, not one each.
  const SF_FILE = `${proxy.dfsOrigin}/ws/lh.Lakehouse/Tables/t/data_sf.parquet`;
  const before = log.length;
  await Promise.all([[0, 99], [100, 199], [300, 399], [500, 599]].map(([s, e]) =>
    fetch(SF_FILE, { headers: { Range: `bytes=${s}-${e}` } }).then(r => r.arrayBuffer())));
  await proxy.cacheIdle();
  const mine = log.slice(before);
  eq(mine.filter(x => x.range).length, 4, "four concurrent cold ranged reads go upstream");
  eq(mine.filter(x => !x.range).length, 1, "…and share exactly ONE background fill");
  const at = log.length;
  const whole = Buffer.from(await (await fetch(SF_FILE)).arrayBuffer());
  eq(log.length, at, "…which now serves even the whole object locally");
  ok(whole.equals(parquet), "…byte-for-byte");
}
{
  // The shape that matters most: duckdb-wasm often reads a data file WHOLE rather than
  // by range (see part 2), and a Fabric Iceberg data file is far bigger than anything
  // worth buffering. Multi-megabyte, no Range, teed to disk as it streams past — and
  // from then on the stored object answers EVERY shape of read, because a range is a
  // slice of it, not a different thing.
  const first = log.length;
  await (await fetch(TABLE_FILE)).arrayBuffer();
  eq(log.length, first + 1, "a whole-file read goes upstream once");
  await proxy.cacheIdle();

  const second = log.length;
  const r = await fetch(TABLE_FILE);
  const body = Buffer.from(await r.arrayBuffer());
  eq(log.length, second, "the whole file is served from disk the second time");
  eq(body.length, parquet.length, `…all ${(parquet.length / 1e6).toFixed(1)}MB of it`);
  ok(body.equals(parquet), "…byte-for-byte");

  // Overlapping, disjoint, and open-ended ranges of the stored object — the reads the
  // old design refetched every single time.
  for (const [start, end] of [[0, 99], [200, 299], [50, 149]]) {
    const at = log.length;
    const rr = await fetch(TABLE_FILE, { headers: { Range: `bytes=${start}-${end}` } });
    const bb = Buffer.from(await rr.arrayBuffer());
    eq(rr.status, 206, `bytes=${start}-${end} of a stored object is a 206`);
    eq(log.length, at, "…served locally");
    eq(rr.headers.get("content-range"), `bytes ${start}-${end}/${parquet.length}`,
       "…with the right content-range");
    ok(bb.equals(parquet.subarray(start, end + 1)), "…and exactly those bytes");
  }
  {
    const at = log.length;
    const tail = parquet.length - 64;
    const rr = await fetch(TABLE_FILE, { headers: { Range: `bytes=${tail}-` } });
    const bb = Buffer.from(await rr.arrayBuffer());
    eq(log.length, at, "an open-ended tail range is served locally");
    ok(bb.equals(parquet.subarray(tail)), "…to the last byte");
  }
  {
    const at = log.length;
    const rr = await fetch(TABLE_FILE, { headers: { Range: `bytes=${parquet.length + 5}-` } });
    eq(rr.status, 416, "a range past the end is a 416");
    eq(rr.headers.get("content-range"), `bytes */${parquet.length}`, "…that names the real size");
    eq(log.length, at, "…answered locally — the stored length knows the answer");
  }
}
{
  // DuckDB sizes a file with a HEAD before every open. A stored object knows its own
  // length, so a HEAD after a GET costs nothing — even though no HEAD was ever proxied.
  const at = log.length;
  const b = await fetch(TABLE_FILE, { method: "HEAD" });
  eq(log.length, at, "a HEAD of a stored object does not go upstream at all");
  eq(b.headers.get("content-length"), String(parquet.length), "…and reports the object's length");
  eq((await b.arrayBuffer()).byteLength, 0, "…with no body, because that is what HEAD means");
}
{
  // A HEAD on a file never fetched still keeps the one thing it learned — the length.
  const HEAD_FILE = `${proxy.dfsOrigin}/ws/lh.Lakehouse/Tables/t/data_h.parquet`;
  const at = log.length;
  const a = await fetch(HEAD_FILE, { method: "HEAD" });
  eq(a.headers.get("content-length"), String(parquet.length), "a HEAD on an unseen file is sized upstream");
  eq(log.length, at + 1, "…which costs one request");
  await proxy.cacheIdle();
  const then = log.length;
  const b = await fetch(HEAD_FILE, { method: "HEAD" });
  eq(log.length, then, "the next HEAD is answered from the sidecar");
  eq(b.headers.get("content-length"), String(parquet.length), "…and reports the same length");
}
{
  // Files/ is overwritten by users, a listing carries a query string, metadata.json is
  // rewritten by conversion, and a catalog answer changes with every snapshot. They are
  // all kept anyway — for a short TTL, because in the field the second ask for the same
  // 3KB catalog answer landed seconds after the first and OneLake charged 2-10 seconds
  // each time. Five minutes of possible staleness was chosen, explicitly, over that.
  for (const [what, url] of [
    ["a file under Files/", `${proxy.dfsOrigin}/ws/lh.Lakehouse/Files/data.parquet`],
    ["a listing", `${proxy.dfsOrigin}/ws/lh.Lakehouse/Tables/t/data_0.parquet?resource=filesystem`],
    ["table metadata", `${proxy.dfsOrigin}/ws/lh.Lakehouse/Tables/t/metadata/v1.metadata.json`],
    ["an Iceberg catalog answer", `${proxy.tableOrigin}/iceberg/v1/config`],
  ]) {
    await (await fetch(url)).arrayBuffer();
    await proxy.cacheIdle();
    const before = log.length;
    await (await fetch(url)).arrayBuffer();
    eq(log.length, before, `${what} is served from disk inside the TTL`);
  }
}
{
  // A cached listing must replay the headers that make it a listing: pagination rides on
  // x-ms-continuation, and a hit that dropped it would silently truncate a directory.
  const url = `${proxy.dfsOrigin}/paged?page=two`;
  const a = await fetch(url);
  eq(a.headers.get("x-ms-continuation"), "next-page", "a listing arrives with its continuation");
  await proxy.cacheIdle();
  const before = log.length;
  const b = await fetch(url);
  eq(log.length, before, "the same listing inside the TTL is served from disk");
  eq(b.headers.get("x-ms-continuation"), "next-page", "…and keeps the continuation header a pager needs");
  eq(b.headers.get("content-type"), "application/json", "…and the content-type it answered with");
}
{
  // The TTL is real: past it, the same URL is asked again, and the fresh answer replaces
  // the stale one on disk. Its own proxy, so the clock can be short.
  const TTL_DIR = await mkdtemp(join(tmpdir(), "onelake-ttl-"));
  const short = await startProxy({
    getToken: async () => TOKEN,
    cacheDir: TTL_DIR, cacheTtlMs: 250,
    dfsUpstream: upBase, tableUpstream: upBase,
  });
  const url = `${short.dfsOrigin}/ws/lh.Lakehouse/Tables/t/metadata/v1.metadata.json`;
  try {
    await (await fetch(url)).arrayBuffer();
    await short.cacheIdle();
    let before = log.length;
    await (await fetch(url)).arrayBuffer();
    eq(log.length, before, "inside the TTL the answer comes from disk");

    await new Promise(r => setTimeout(r, 400));   // real time: the TTL is a clock, not an event
    before = log.length;
    await (await fetch(url)).arrayBuffer();
    eq(log.length, before + 1, "past the TTL the same URL is asked again");
    await short.cacheIdle();

    before = log.length;
    await (await fetch(url)).arrayBuffer();
    eq(log.length, before, "…and the fresh answer took the stale one's place on disk");
  } finally {
    await short.close();
    await rm(TTL_DIR, { recursive: true, force: true }).catch(() => {});
  }
}
{
  await proxy.clearCache();
  const before = log.length;
  await (await fetch(TABLE_FILE, { headers: { Range: "bytes=0-99" } })).arrayBuffer();
  await proxy.cacheIdle();   // the fill this triggers must not bleed into later counts
  eq(log.slice(before).filter(x => x.range === "bytes=0-99").length, 1,
     "clearing the cache really lets go of the bytes: the read goes upstream again");
}
// Eviction, on its own proxy with a cap small enough to cross. The default is twenty
// gigabytes precisely so this never runs in practice — which is why it needs proving here
// rather than in the field.
{
  const PRUNE_DIR = await mkdtemp(join(tmpdir(), "onelake-prune-"));
  // The fixture is 5.2MB, so two files overflow an 8MB cap and one does not.
  const CAP = 8 * 1024 * 1024;
  const small = await startProxy({
    getToken: async () => TOKEN,
    cacheDir: PRUNE_DIR, cacheMaxBytes: CAP,
    dfsUpstream: upBase, tableUpstream: upBase,
  });
  const url = n => `${small.dfsOrigin}/ws/lh.Lakehouse/Tables/t/data_${n}.parquet`;
  const settle = () => small.cacheIdle();
  try {
    await (await fetch(url(1))).arrayBuffer();
    await settle();
    ok(await small.cacheSize() > 0, "a first file is kept");

    await (await fetch(url(2))).arrayBuffer();
    await settle();
    const size = await small.cacheSize();
    ok(size <= CAP, `the cap is honoured (${(size / 1e6).toFixed(1)}MB)`);

    // Oldest-first: the one read second survives, the one read first does not.
    let before = log.length;
    await (await fetch(url(2))).arrayBuffer();
    eq(log.length, before, "…and the newest entry is the one still there");

    before = log.length;
    await (await fetch(url(1))).arrayBuffer();
    eq(log.length, before + 1, "…while the oldest was the one evicted");
  } finally {
    await small.close();
    await rm(PRUNE_DIR, { recursive: true, force: true }).catch(() => {});
  }
}
{
  // A cap below a single object's size used to mean caching nothing at all: the entry was
  // written, counted, and immediately evicted for being over the limit. Keeping one thing
  // and sitting over the cap beats being reliably useless.
  const TINY_DIR = await mkdtemp(join(tmpdir(), "onelake-tiny-"));
  const tiny = await startProxy({
    getToken: async () => TOKEN,
    cacheDir: TINY_DIR, cacheMaxBytes: 1024,
    dfsUpstream: upBase, tableUpstream: upBase,
  });
  const url = `${tiny.dfsOrigin}/ws/lh.Lakehouse/Tables/t/data_9.parquet`;
  try {
    await (await fetch(url)).arrayBuffer();
    await tiny.cacheIdle();
    const before = log.length;
    await (await fetch(url)).arrayBuffer();
    eq(log.length, before, "a file bigger than the whole cap is still kept");

    // The tee keeps what it was already paying for; the background fill must not START
    // a download that can never be kept.
    const ranged = `${tiny.dfsOrigin}/ws/lh.Lakehouse/Tables/t/data_10.parquet`;
    const at = log.length;
    await (await fetch(ranged, { headers: { Range: "bytes=0-99" } })).arrayBuffer();
    await tiny.cacheIdle();
    eq(log.length, at + 1,
       "…but a ranged read of one fills nothing: a download that cannot be kept is not begun");
  } finally {
    await tiny.close();
    await rm(TINY_DIR, { recursive: true, force: true }).catch(() => {});
  }
}

{
  // A crash between the rename and the sidecar leaves a .bin no read can ever serve, that
  // scan() never counts and prune() never deletes — a leak with no expiry. A sidecar with
  // no .bin is the same tear from the other side. An abandoned .tmp is an interrupted
  // write — but a YOUNG .tmp may be another VS Code window's write still in flight
  // (globalStorage is shared), so age, not existence, is what convicts it. Start-up is
  // the moment all of these are recognised, and what was validly on disk from an earlier
  // session must be counted then too — for a long time it silently was not.
  const SWEEP_DIR = await mkdtemp(join(tmpdir(), "onelake-sweep-"));
  const seed = (name, bytes) => writeFile(join(SWEEP_DIR, name), Buffer.alloc(bytes));
  await seed("0rphan.bin", 2048);                                   // renamed, sidecar never written
  await writeFile(join(SWEEP_DIR, "t0rn.json"), JSON.stringify({ bytes: 4096, at: Date.now() }));
  await seed("stale.123.1.tmp", 1024);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(join(SWEEP_DIR, "stale.123.1.tmp"), old, old);
  await seed("fresh.456.2.tmp", 1024);                              // possibly another window's
  await seed("g00d.bin", 2048);                                     // a real entry from "last session"
  await writeFile(join(SWEEP_DIR, "g00d.json"), JSON.stringify({ bytes: 2048, at: Date.now(), v: 2 }));
  await seed("legacy.bin", 512);                                    // the range-keyed era: no v
  await writeFile(join(SWEEP_DIR, "legacy.json"), JSON.stringify({ contentRange: "", bytes: 512, at: Date.now() }));

  const swept = await startProxy({
    getToken: async () => TOKEN,
    cacheDir: SWEEP_DIR, dfsUpstream: upBase, tableUpstream: upBase,
  });
  try {
    await swept.cacheIdle();
    const left = await readdir(SWEEP_DIR);
    ok(!left.includes("0rphan.bin"), "a .bin with no sidecar is swept at start-up");
    ok(!left.includes("t0rn.json"), "a sidecar with no .bin is swept too");
    ok(!left.includes("stale.123.1.tmp"), "an hour-old .tmp is swept");
    ok(left.includes("fresh.456.2.tmp"), "a fresh .tmp is spared — it may be another window's live write");
    ok(left.includes("g00d.bin") && left.includes("g00d.json"), "a whole entry is untouched");
    ok(!left.includes("legacy.bin") && !left.includes("legacy.json"),
       "an entry from the range-keyed era is swept — nothing can ever ask for its key again");
    eq(swept.cacheStatus().storedBytes, 2048,
       "…and bytes already on disk are counted at start-up, not discovered later");
  } finally {
    await swept.close();
    await rm(SWEEP_DIR, { recursive: true, force: true }).catch(() => {});
  }
}

// =============================================================================
// Part 2 — DuckDB-WASM range-reading through it, in real Chrome
// =============================================================================
console.log("\n--- DuckDB-WASM through the proxy (real Chrome) ---");

// The CSP the extension really generates (panel.js csp()), with the webview's cspSource
// standing in as this page's origin. Chromium enforces a policy identically wherever it
// comes from, so this is where 'unsafe-eval' — which a VS Code webview needs for
// WebAssembly.instantiate, and where wasm-unsafe-eval alone does not work — gets proven,
// along with worker-src blob: for DuckDB's Blob worker and connect-src for its downloads.
const NONCE = "t3stn0nce";
const PAGE_CSP = [
  `default-src 'none'`,
  `img-src http://127.0.0.1:${PAGE_PORT} data: blob:`,
  `font-src http://127.0.0.1:${PAGE_PORT}`,
  `style-src http://127.0.0.1:${PAGE_PORT} 'unsafe-inline'`,
  `script-src http://127.0.0.1:${PAGE_PORT} 'nonce-${NONCE}' 'unsafe-eval' https://cdn.jsdelivr.net`,
  `worker-src blob:`,
  `connect-src http://127.0.0.1:${proxy.port} https://cdn.jsdelivr.net https://extensions.duckdb.org`,
].join("; ");

const PAGE = `<!doctype html><meta charset=utf-8><title>working</title>
<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
<body><script type="module" nonce="${NONCE}">
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/+esm";
const say = m => { document.title = m; };
try {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(
    new Blob([\`importScripts("\${bundle.mainWorker}");\`], { type: "text/javascript" }));
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  // Exactly what data.js does for a table's data files.
  await db.registerFileURL("f.parquet", ${JSON.stringify(`${proxy.dfsOrigin}/ws/f.parquet`)}, duckdb.DuckDBDataProtocol.HTTP, false);
  const conn = await db.connect();
  const res = await conn.query("SELECT count(*) AS n, max(d) AS m FROM read_parquet('f.parquet')");
  const row = res.toArray()[0];
  window.ANSWER = { n: Number(row.n), m: Number(row.m) };
  say("DONE");
} catch (e) { window.ANSWER = { error: String(e && e.message || e) }; say("ERROR"); }
</script>`;

const pageServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise(r => pageServer.listen(PAGE_PORT, "127.0.0.1", r));

const before = log.length;
let browser;
try {
  browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("pageerror", e => console.log("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${PAGE_PORT}/`);
  await page.waitForFunction(() => ["DONE", "ERROR"].includes(document.title), { timeout: 180000 });
  const answer = await page.evaluate(() => window.ANSWER);

  ok(!answer.error,
     `DuckDB booted and read through the proxy under the extension's real CSP` +
     `${answer.error ? ` — ${answer.error}` : ""}`);
  if (!answer.error) {
    eq(answer.n, 400000, "…and got every row");
    eq(answer.m, 799998, "…with the right values");
  }

  const reads = log.slice(before);
  ok(reads.length > 0 && reads.every(r => r.auth === `Bearer ${TOKEN}`),
     `every read arrived signed (${reads.length} request(s), none unauthenticated)`);

  // MEASURED, and not what this file originally asserted: duckdb-wasm 1.33.1-dev57.0 never
  // sends a Range header for an HTTP file. Probed four ways in real Chrome — registerFileURL
  // with directIO both ways, a bare http:// URL, and parquet_file_metadata, which needs only
  // the footer — and every one of them was a single whole-file GET, with the origin
  // advertising `accept-ranges: bytes` throughout. So this proxy is at parity with what sw.js
  // does in the browser, and the cost of opening a table is the file count, not the bytes
  // within a file — which is exactly what the statTable/peekTable/loadTable tiers already
  // assume. If a later duckdb-wasm starts ranging, the part-1 checks above already prove the
  // proxy handles 206 correctly, and this check turns into a nice surprise rather than a bug.
  ok(reads.every(r => !r.range), `parity with the browser build: no ranged reads issued ` +
     `(duckdb-wasm ${reads.length === 1 ? "made one whole-file GET" : "made whole-file GETs"})`);
} catch (e) {
  fail++; console.log("FAIL—", e.message);
} finally {
  await browser?.close().catch(() => {});
  pageServer.close();
  await proxy.close();
  upstream.close();
  await rm(CACHE_DIR, { recursive: true, force: true }).catch(() => {});
}

console.log(`\nRESULT: ${fail ? "FAILED" : "OK"} — ${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
