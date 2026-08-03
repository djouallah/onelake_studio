// What the loopback proxy must REFUSE. Its port is reachable by any local process and —
// through a victim's browser — by any web page that guesses it, so the interesting
// properties are the negative ones: no path escapes the vendor directory, no foreign
// origin gets a CORS grant, and the OneLake bearer never follows a redirect off-host.
//
// Plain node --test, no editor, no credentials, no Chrome.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { startProxy } = require("../extension/src/proxy.js");

const TOKEN = "test-token";

// One request against the proxy, raw enough to send request targets fetch() would refuse
// to produce (backslashes, dot-dot segments).
function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
    req.on("error", reject);
    req.end();
  });
}

test("proxy security properties", async t => {
  // A vendor directory with one legitimate file, and a secret one OUTSIDE it that a
  // traversal would reach.
  const base = await mkdtemp(join(tmpdir(), "onelake-proxy-sec-"));
  const vendorDir = join(base, "vendor");
  await mkdir(join(vendorDir, "cdn.jsdelivr.net", "npm"), { recursive: true });
  await writeFile(join(vendorDir, "cdn.jsdelivr.net", "npm", "lib.js"), "export default 1;\n");
  await writeFile(join(base, "outside.txt"), "SECRET-OUTSIDE-VENDOR");

  // A fake OneLake that redirects one path off-host, and a "foreign host" that records
  // whether the authorization header followed the redirect there.
  let foreignSawAuth = null;
  const foreign = http.createServer((req, res) => {
    foreignSawAuth = req.headers.authorization || "";
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("foreign body");
  });
  await new Promise(r => foreign.listen(0, "127.0.0.1", r));
  const foreignPort = foreign.address().port;

  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith("/redirect-off-host")) {
      res.writeHead(302, { location: `http://127.0.0.1:${foreignPort}/landed` });
      return res.end();
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401);
      return res.end("no bearer");
    }
    res.writeHead(200, { "content-type": "text/plain", "content-length": "2" });
    res.end("ok");
  });
  await new Promise(r => upstream.listen(0, "127.0.0.1", r));
  const upBase = `http://127.0.0.1:${upstream.address().port}`;

  // A stand-in for jsDelivr. A request the vendor route REFUSES falls through to the CDN
  // fetch, and without this seam that fallthrough is a real network round trip — which
  // makes this file slow, flaky and dependent on someone else's uptime. It also records
  // what was asked for, so "refused locally" can be told from "served locally".
  const cdnAsked = [];
  const cdn = http.createServer((req, res) => {
    cdnAsked.push(req.url);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("no such CDN file");
  });
  await new Promise(r => cdn.listen(0, "127.0.0.1", r));
  const cdnBase = `http://127.0.0.1:${cdn.address().port}`;

  const proxy = await startProxy({
    getToken: async () => TOKEN,
    dfsUpstream: upBase,
    tableUpstream: upBase,
    cdnUpstream: cdnBase,
    vendorDir,
  });

  t.after(async () => {
    await proxy.close();
    upstream.close();
    foreign.close();
    cdn.close();
    await rm(base, { recursive: true, force: true }).catch(() => {});
  });

  await t.test("the vendor route serves what it should", async () => {
    const r = await rawGet(proxy.port, "/npm/lib.js");
    assert.equal(r.status, 200, "a packaged file is served");
    assert.match(r.body, /export default 1/);
  });

  await t.test("no traversal escapes the vendor directory", async () => {
    // Windows join() treats '\' as a separator, so a backslash inside one segment was a
    // way out of vendorDir; '..' segments and absolute drive paths are the classic ones.
    for (const path of [
      "/npm/..%5C..%5Coutside.txt",          // encoded backslashes
      "/npm/%2e%2e/%2e%2e/outside.txt",      // encoded dot-dot
      "/npm/a%5C..%5C..%5Coutside.txt",      // backslash inside a segment
      "/npm/c%3A/windows/win.ini",           // drive colon
    ]) {
      const r = await rawGet(proxy.port, path);
      assert.notEqual(r.status, 200, `${path} must not be served`);
      assert.ok(!r.body.includes("SECRET-OUTSIDE-VENDOR"), `${path} must not leak the file`);
    }
  });

  await t.test("CORS is granted to the webview and localhost, and nobody else", async () => {
    const webview = await rawGet(proxy.port, "/npm/lib.js",
      { origin: "vscode-webview://webviewid123" });
    assert.equal(webview.headers["access-control-allow-origin"], "vscode-webview://webviewid123",
      "the webview origin is echoed");

    const local = await rawGet(proxy.port, "/npm/lib.js",
      { origin: "http://127.0.0.1:5207" });
    assert.equal(local.headers["access-control-allow-origin"], "http://127.0.0.1:5207",
      "a loopback harness origin is echoed");

    const evil = await rawGet(proxy.port, "/npm/lib.js",
      { origin: "https://evil.example" });
    assert.equal(evil.headers["access-control-allow-origin"], undefined,
      "a foreign web origin gets no grant at all");
    assert.equal(evil.headers.vary, "origin", "and caches are told the answer varies");
  });

  await t.test("a signed route works, and the bearer does not follow a redirect off-host", async () => {
    const ok = await rawGet(proxy.port, `/${proxy.secret}/dfs/some/file`);
    assert.equal(ok.status, 200, "a signed read reaches the upstream");
    assert.equal(ok.body, "ok");

    foreignSawAuth = null;
    await rawGet(proxy.port, `/${proxy.secret}/dfs/redirect-off-host`);
    assert.equal(foreignSawAuth, "",
      "the host that the redirect pointed at saw NO authorization header");
  });

  await t.test("a wrong secret and a wrong path are the same 404", async () => {
    const bad = await rawGet(proxy.port, `/${"0".repeat(48)}/dfs/some/file`);
    assert.equal(bad.status, 404);
    const nonsense = await rawGet(proxy.port, "/not-a-route");
    assert.equal(nonsense.status, 404);
  });
});
