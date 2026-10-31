// http.js: one request with a token — a fresh one once on a 401, a 429 waited out — and paging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { authedFetch, listPages, mapPool, fabricMessage, useConnectivity } = require("../../src/http.js");

const res = (status, { retryAfter, body = "" } = {}) => {
  let cancelled = false;
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: h => (h === "retry-after" && retryAfter != null ? String(retryAfter) : null) },
    body: { cancel: async () => { cancelled = true; } },
    text: async () => body,
    get cancelled() { return cancelled; },
  };
};

test("offline, nothing is sent and no token is asked for, and it says why", async t => {
  t.after(() => useConnectivity(null));
  let asked = 0;
  const go = () => authedFetch("https://x/a", {
    getToken: async () => { asked++; return "t"; }, timeoutMs: 1000,
    fetchImpl: async () => { asked++; return res(200); },
  });
  for (const [reason, said] of [["no internet", /there is no internet/], ["not signed in", /you are not signed in/]]) {
    useConnectivity({ offline: () => true, reason: () => reason, networkFailed() {} });
    await assert.rejects(go(), e => e.offline === true && said.test(e.message), reason);
  }
  assert.equal(asked, 0);
});

test("a request with no answer at all is reported; any status is an answer", async t => {
  t.after(() => useConnectivity(null));
  let failures = 0;
  useConnectivity({ offline: () => false, reason: () => null, networkFailed: () => { failures++; } });
  const opts = { getToken: async () => "t", timeoutMs: 1000 };
  await assert.rejects(authedFetch("https://x/a", { ...opts, fetchImpl: async () => { throw new TypeError("fetch failed"); } }), /fetch failed/);
  assert.equal(failures, 1);
  assert.equal((await authedFetch("https://x/a", { ...opts, fetchImpl: async () => res(500) })).status, 500);
  assert.equal(failures, 1);
});

test("a 401 is retried once with a fresh token, and the refused body let go", async () => {
  const sent = [], answers = [res(401), res(401)];
  const first = answers[0];
  const r = await authedFetch("https://x/a", {
    getToken: async ({ fresh } = {}) => (fresh ? "new" : "old"), timeoutMs: 1000,
    fetchImpl: async (_, o) => { sent.push(o.headers.authorization); return answers.shift(); },
  });
  assert.deepEqual(sent, ["Bearer old", "Bearer new"]);
  assert.equal(r.status, 401, "a second 401 is the answer, not a third try");
  assert.equal(first.cancelled, true);
});

test("no token is a 401 that says so, and nothing is sent", async () => {
  let sent = 0;
  await assert.rejects(authedFetch("https://x", { getToken: async () => null, timeoutMs: 1000, who: "the Fabric API",
    fetchImpl: async () => { sent++; return res(200); } }), e => e.status === 401 && /the Fabric API/.test(e.message));
  assert.equal(sent, 0);
});

test("a 429 is waited out by Retry-After, up to the attempts asked for", async () => {
  const waits = [];
  const answers = [res(429, { retryAfter: 2 }), res(503), res(429), res(200)];
  const r = await authedFetch("https://x", {
    getToken: async () => "t", timeoutMs: 1000, attempts: 4, retry: [503],
    backoffMs: a => a * 100, sleep: async ms => { waits.push(ms); },
    fetchImpl: async () => answers.shift(),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(waits, [2000, 200, 300]);
  const once = await authedFetch("https://x", { getToken: async () => "t", timeoutMs: 1000,
    sleep: async () => assert.fail("no wait with one attempt"), fetchImpl: async () => res(429) });
  assert.equal(once.status, 429, "one attempt: the 429 is the caller's");
});

test("pages follow continuationToken, and a server that never stops is given up on", async () => {
  const urls = [];
  const all = await listPages("https://x/items?type=A", async url => {
    urls.push(url);
    return urls.length < 3 ? { value: [urls.length], continuationToken: `c${urls.length}` } : { value: [3] };
  }, { what: "Listing" });
  assert.deepEqual(all, [1, 2, 3]);
  assert.equal(urls[1], "https://x/items?type=A&continuationToken=c1");
  await assert.rejects(listPages("https://x", async () => ({ value: [], continuationToken: "same" }), { what: "Listing", maxPages: 3 }),
    /did not finish after 3 pages/);
});

test("mapPool keeps the items' order and runs at most `limit` at once", async () => {
  let live = 0, most = 0;
  const out = await mapPool([5, 1, 3, 2], async n => {
    most = Math.max(most, ++live);
    await new Promise(r => setTimeout(r, n));
    live--;
    return n * 10;
  }, 2);
  assert.deepEqual(out, [50, 10, 30, 20]);
  assert.equal(most, 2);
});

test("Fabric's message is read from either shape of its error body", async () => {
  assert.equal(await fabricMessage(res(400, { body: '{"message":"no capacity"}' })), "no capacity");
  assert.equal(await fabricMessage(res(400, { body: '{"error":{"message":"denied"}}' })), "denied");
  assert.equal(await fabricMessage(res(400, { body: "<html>" })), "");
});
