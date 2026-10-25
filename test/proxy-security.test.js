// What the loopback proxy must REFUSE. Its port is reachable by any local process and —
// through a victim's browser — by any web page that guesses it, so the interesting
// properties are the negative ones: no path escapes the vendor directory, no foreign
// origin gets a CORS grant, no foreign Host is answered at all, the unsecreted route
// serves only the vendored packages, and the OneLake bearer never follows a redirect
// off-host. The bridge listener — the website's way in — gets the same treatment.
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
const { VENDORED_PREFIXES } = require("../extension/src/vendored.js");

const TOKEN = "test-token";
// "/npm/sql.js@1.13.0/" -> "sql.js@1.13.0"
const VENDORED_DIR = VENDORED_PREFIXES[0].split("/")[2];
const LIB = `/npm/${VENDORED_DIR}/lib.js`;
const SITE = "https://studio.example.com";

// One request against the proxy, raw enough to send request targets fetch() would refuse
// to produce (backslashes, dot-dot segments) and Host headers it would not let us set.
function rawGet(port, path, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers },
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
  // A vendor directory with one legitimate file under a vendored prefix, and a secret one
  // OUTSIDE it that a traversal would reach.
  const base = await mkdtemp(join(tmpdir(), "onelake-proxy-sec-"));
  const vendorDir = join(base, "vendor");
  await mkdir(join(vendorDir, "cdn.jsdelivr.net", "npm", VENDORED_DIR), { recursive: true });
  await writeFile(join(vendorDir, "cdn.jsdelivr.net", "npm", VENDORED_DIR, "lib.js"), "export default 1;\n");
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

  let signedIn = true;
  const proxy = await startProxy({
    getToken: async () => (signedIn ? TOKEN : null),
    dfsUpstream: upBase,
    tableUpstream: upBase,
    cdnUpstream: cdnBase,
    vendorDir,
  });

  // The website's listener. `verdict` is what the person clicked in VS Code.
  let verdict = { allowed: true, account: "someone@example.com" };
  const asked = [];
  const bridge = await proxy.startBridge({
    port: 0, origins: [SITE],
    onPair: async origin => { asked.push(origin); return verdict; },
  });

  t.after(async () => {
    await proxy.close();
    upstream.close();
    foreign.close();
    cdn.close();
    await rm(base, { recursive: true, force: true }).catch(() => {});
  });

  await t.test("the vendor route serves what it should", async () => {
    const r = await rawGet(proxy.port, LIB);
    assert.equal(r.status, 200, "a packaged file is served");
    assert.match(r.body, /export default 1/);
  });

  await t.test("the unsecreted route serves the vendored packages and nothing else", async () => {
    const before = cdnAsked.length;
    for (const path of ["/npm/evil-package@1.0.0/+esm", "/npm/sql.js@0.0.1/+esm", "/gh/someone/repo/x.js"]) {
      const r = await rawGet(proxy.port, path);
      assert.equal(r.status, 404, `${path} is refused`);
    }
    assert.equal(cdnAsked.length, before, "…without asking the CDN for it");
  });

  await t.test("no traversal escapes the vendor directory", async () => {
    // Windows join() treats '\' as a separator, so a backslash inside one segment was a
    // way out of vendorDir; '..' segments and absolute drive paths are the classic ones.
    for (const path of [
      `/npm/${VENDORED_DIR}/..%5C..%5C..%5Coutside.txt`,       // encoded backslashes
      `/npm/${VENDORED_DIR}/%2e%2e/%2e%2e/%2e%2e/outside.txt`, // encoded dot-dot
      `/npm/${VENDORED_DIR}/a%5C..%5C..%5C..%5Coutside.txt`,   // backslash inside a segment
      `/npm/${VENDORED_DIR}/c%3A/windows/win.ini`,             // drive colon
    ]) {
      const r = await rawGet(proxy.port, path);
      assert.notEqual(r.status, 200, `${path} must not be served`);
      assert.ok(!r.body.includes("SECRET-OUTSIDE-VENDOR"), `${path} must not leak the file`);
    }
  });

  await t.test("CORS is granted to the webview and localhost, and nobody else", async () => {
    const webview = await rawGet(proxy.port, LIB, { origin: "vscode-webview://webviewid123" });
    assert.equal(webview.headers["access-control-allow-origin"], "vscode-webview://webviewid123",
      "the webview origin is echoed");

    const local = await rawGet(proxy.port, LIB, { origin: "http://127.0.0.1:5207" });
    assert.equal(local.headers["access-control-allow-origin"], "http://127.0.0.1:5207",
      "a loopback harness origin is echoed");

    const evil = await rawGet(proxy.port, LIB, { origin: "https://evil.example" });
    assert.equal(evil.headers["access-control-allow-origin"], undefined,
      "a foreign web origin gets no grant at all");
    assert.equal(evil.headers.vary, "origin", "and caches are told the answer varies");

    const site = await rawGet(proxy.port, LIB, { origin: SITE });
    assert.equal(site.headers["access-control-allow-origin"], undefined,
      "the website gets nothing from the PANEL listener — only from the bridge");
  });

  await t.test("a foreign Host is refused before anything else (DNS rebinding)", async () => {
    const rebound = await rawGet(proxy.port, `/${proxy.secret}/dfs/some/file`,
      { host: `evil.example:${proxy.port}` });
    assert.equal(rebound.status, 421, "a request addressed to another name is misdirected");
    const wrongPort = await rawGet(proxy.port, LIB, { host: "127.0.0.1:1" });
    assert.equal(wrongPort.status, 421, "…and so is one addressed to another port");
    const byName = await rawGet(proxy.port, LIB, { host: `localhost:${proxy.port}` });
    assert.equal(byName.status, 200, "localhost:<port> is still this port");
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

  // ---- the bridge -------------------------------------------------------------------

  await t.test("the bridge answers its website, and nobody else", async () => {
    const pre = await rawGet(bridge.port, "/pair",
      { origin: SITE, "access-control-request-method": "GET",
        "access-control-request-private-network": "true" }, "OPTIONS");
    assert.equal(pre.status, 204);
    assert.equal(pre.headers["access-control-allow-origin"], SITE, "the website's origin is echoed");
    assert.equal(pre.headers["access-control-allow-private-network"], "true",
      "the Private Network Access preflight is answered");

    for (const origin of ["https://evil.example", "vscode-webview://abc", "http://127.0.0.1:5207",
                          `${SITE}.evil.example`, "http://studio.example.com"]) {
      const r = await rawGet(bridge.port, "/pair?probe", { origin });
      assert.equal(r.headers["access-control-allow-origin"], undefined, `${origin} gets no grant`);
      assert.equal(r.status, 403, `${origin} is refused`);
    }
  });

  await t.test("a probe answers at once and asks nobody", async () => {
    const n = asked.length;
    const r = await rawGet(bridge.port, "/pair?probe", { origin: SITE });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { v: 1, signedIn: true });
    assert.equal(asked.length, n, "no prompt for a probe");
  });

  await t.test("pairing asks, and hands back signed origins on the bridge's own port", async () => {
    verdict = { allowed: true, account: "someone@example.com" };
    const r = await rawGet(bridge.port, "/pair", { origin: SITE });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.account, "someone@example.com");
    assert.ok(asked.includes(SITE), "VS Code was asked");
    const dfs = new URL(body.dfsOrigin);
    assert.equal(Number(dfs.port), bridge.port, "the origins point at the bridge, not the panel");
    assert.ok(!body.dfsOrigin.includes(proxy.secret), "…and carry the bridge's secret, not the panel's");
    assert.ok(!JSON.stringify(body).includes(TOKEN), "the token itself is never handed out");

    const read = await rawGet(bridge.port, `${dfs.pathname}/some/file`, { origin: SITE });
    assert.equal(read.status, 200, "a read through the paired origin is signed upstream");
    assert.equal(read.body, "ok");
    assert.equal(read.headers["access-control-allow-origin"], SITE);
    assert.ok(/content-range/.test(read.headers["access-control-expose-headers"] || ""),
      "DuckDB can see content-range");

    const irc = await rawGet(bridge.port, `${new URL(body.tableOrigin).pathname}/iceberg/v1/config`,
      { origin: SITE });
    assert.equal(irc.status, 200, "the catalog route works through the bridge too");
  });

  await t.test("the bridge serves only dfs and irc", async () => {
    const r = await rawGet(bridge.port, "/pair", { origin: SITE });
    const secret = new URL(JSON.parse(r.body).dfsOrigin).pathname.split("/")[1];
    assert.equal((await rawGet(bridge.port, `/${secret}/cdn/cdn.jsdelivr.net${LIB}`)).status, 404,
      "no /cdn on the bridge");
    assert.equal((await rawGet(bridge.port, LIB)).status, 404, "no /npm on the bridge");
    assert.equal((await rawGet(bridge.port, `/${proxy.secret}/dfs/some/file`)).status, 404,
      "the panel's secret means nothing on the bridge");
  });

  await t.test("a refusal and a signed-out window both say no", async () => {
    verdict = { allowed: false };
    const refused = await rawGet(bridge.port, "/pair", { origin: SITE });
    assert.equal(refused.status, 403);
    assert.ok(!refused.body.includes("dfsOrigin"));

    verdict = { allowed: true, account: "x" };
    signedIn = false;
    const out = await rawGet(bridge.port, "/pair", { origin: SITE });
    assert.equal(out.status, 401);
    assert.deepEqual(JSON.parse(out.body), { signedIn: false });
    const probe = await rawGet(bridge.port, "/pair?probe", { origin: SITE });
    assert.deepEqual(JSON.parse(probe.body), { v: 1, signedIn: false }, "the probe says so too");
    signedIn = true;
  });

  await t.test("a second bridge on a taken port fails with EADDRINUSE and nothing else", async () => {
    await assert.rejects(
      proxy.startBridge({ port: bridge.port, origins: [SITE], onPair: async () => verdict }),
      e => e.code === "EADDRINUSE");
    const still = await rawGet(bridge.port, "/pair?probe", { origin: SITE });
    assert.equal(still.status, 200, "the first bridge is untouched");
  });
});
