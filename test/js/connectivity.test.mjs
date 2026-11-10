// connectivity.js: when this window counts as offline, driven with a fake probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createConnectivity, probeOf } = require("../../core/onelake/connectivity.js");

test("the probe: a line too busy to answer in time gets a longer try, and a refusal is known at once", async () => {
  const timeout = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const asked = [];
  const answers = (...them) => probeOf(async ms => {
    asked.push(ms);
    const a = them.shift();
    if (a) throw a;
  });
  assert.equal(await answers(null)(), true);
  assert.deepEqual(asked.splice(0), [5000], "an answer needs no second try");
  assert.equal(await answers(timeout(), null)(), true, "a full line is online");
  assert.deepEqual(asked.splice(0), [5000, 20000]);
  assert.equal(await answers(timeout(), timeout())(), false, "no answer twice is no internet");
  asked.length = 0;
  assert.equal(await answers(new TypeError("fetch failed"))(), false, "no route is known at once");
  assert.deepEqual(asked, [5000]);
});

test("a probe that failed while the thread was held is asked again, and believed when it wasn't", async () => {
  const refused = () => new TypeError("fetch failed");
  let asked = 0;
  const probe = (answers, held) => probeOf(async () => { asked++; const a = answers.shift(); if (a) throw a; },
    { watch: () => () => held.shift() });
  assert.equal(await probe([refused(), null], [true, false])(), true, "held the first time: the second answer counts");
  assert.equal(asked, 2);
  asked = 0;
  assert.equal(await probe([refused()], [false])(), false, "not held: no internet, at once");
  assert.equal(asked, 1);
  asked = 0;
  assert.equal(await probe([refused(), refused(), refused(), null], [true, true, true, true])(), false, "held every time: three tries, no more");
  assert.equal(asked, 3);
});

function setup(answer = true, everyMs = 60_000) {
  const w = { answer, probes: 0, changes: [] };
  w.c = createConnectivity({ everyMs, probe: async () => { w.probes++; return w.answer; }, onChange: r => w.changes.push(r) });
  return w;
}

test("starts online, and a failed request with a passing probe stays online", async t => {
  const w = setup(true);
  t.after(() => w.c.dispose());
  assert.equal(w.c.offline(), false);
  await w.c.check();
  assert.equal(w.c.offline(), false);
  assert.deepEqual(w.changes, []);
});

test("no answer from the probe either is no internet, and a burst shares one probe", async t => {
  const w = setup(false);
  t.after(() => w.c.dispose());
  const all = [w.c.check(), w.c.check(), w.c.check()];
  await Promise.all(all);
  assert.equal(w.probes, 1);
  assert.equal(w.c.reason(), "no internet");
  assert.equal(w.c.noInternet(), true);
  assert.deepEqual(w.changes, ["no internet"]);
});

test("a probe that throws is no answer", async t => {
  const c = createConnectivity({ probe: async () => { throw new Error("dns"); } });
  t.after(() => c.dispose());
  await c.check();
  assert.equal(c.reason(), "no internet");
});

test("the probe repeats while offline, comes back by itself, and then stops", async t => {
  const w = setup(false, 5);
  t.after(() => w.c.dispose());
  await w.c.check();
  w.answer = true;
  const end = Date.now() + 2000;
  while (w.c.offline() && Date.now() < end) await new Promise(r => setTimeout(r, 5));
  assert.equal(w.c.offline(), false);
  assert.deepEqual(w.changes, ["no internet", null], "each change said once");
  const probes = w.probes;
  await new Promise(r => setTimeout(r, 30));
  assert.equal(w.probes, probes, "online, it is not polling");
});

test("no session is offline with its own reason, and no internet outranks it", async t => {
  const w = setup(false);
  t.after(() => w.c.dispose());
  w.c.setSession(false);
  assert.equal(w.c.reason(), "not signed in");
  assert.equal(w.c.noInternet(), false);
  await w.c.check();
  assert.equal(w.c.reason(), "no internet");
  w.answer = true;
  await w.c.check();
  assert.equal(w.c.reason(), "not signed in");
  w.c.setSession(true);
  assert.equal(w.c.reason(), null);
  assert.deepEqual(w.changes, ["not signed in", "no internet", "not signed in", null]);
});
