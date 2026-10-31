import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCatalogSnapshot } = require("../../src/catalogsnapshot.js");

const A = [{ name: "a" }], B = [{ name: "b" }];

function fixture({ kept, found }) {
  const f = { kept, found, walks: 0, moved: 0, errors: 0, gate: null };
  f.snapshot = createCatalogSnapshot({
    walk: async () => { f.walks++; if (f.gate) await f.gate; if (f.found instanceof Error) throw f.found; return f.found; },
    read: async () => f.kept,
    write: async list => { f.kept = list; },
    onMoved: () => { f.moved++; },
    onError: () => { f.errors++; },
  });
  return f;
}
const settle = () => new Promise(r => setTimeout(r, 5));

test("nothing kept: the first listing walks, and keeps what it finds", async () => {
  const f = fixture({ found: A });
  assert.deepEqual(await f.snapshot.list(), A);
  assert.equal(f.walks, 1);
  assert.deepEqual(f.kept, A);
});

test("a kept list answers without waiting for the walk", async () => {
  const f = fixture({ kept: A, found: A });
  let open;
  f.gate = new Promise(r => { open = r; });
  assert.deepEqual(await f.snapshot.list(), A, "answered while the walk is still held");
  open();
  await settle();
  assert.equal(f.walks, 1, "and it still walks behind the caller");
  assert.equal(f.moved, 0, "the same list is no news");
});

test("a walk that finds something else says so, and the next listing has it", async () => {
  const f = fixture({ kept: A, found: B });
  assert.deepEqual(await f.snapshot.list(), A);
  await settle();
  assert.equal(f.moved, 1);
  assert.deepEqual(f.kept, B);
  assert.deepEqual(await f.snapshot.list(), B);
});

test("a second listing during the walk gets the kept list too, with no second walk", async () => {
  const f = fixture({ kept: A, found: A });
  let open;
  f.gate = new Promise(r => { open = r; });
  await f.snapshot.list();
  assert.deepEqual(await f.snapshot.list(), A);
  assert.equal(f.walks, 1);
  open();
  await settle();
});

test("once the cache has moved the kept list is not an answer", async () => {
  const f = fixture({ kept: A, found: B });
  f.snapshot.moved();
  assert.deepEqual(await f.snapshot.list(), B);
  assert.equal(f.moved, 0, "the caller already has the new list");
});

test("a failed walk behind the caller keeps the kept list, and says so", async () => {
  const f = fixture({ kept: A, found: new Error("no") });
  assert.deepEqual(await f.snapshot.list(), A);
  await settle();
  assert.equal(f.errors, 1);
  assert.deepEqual(f.kept, A);
});

test("another account's store answers from its own list, and an old walk keeps nothing there", async () => {
  const f = fixture({ kept: A, found: A });
  let open;
  f.gate = new Promise(r => { open = r; });
  await f.snapshot.list();
  f.snapshot.reset();
  f.kept = B;
  f.found = B;
  f.gate = null;
  assert.deepEqual(await f.snapshot.list(), B);
  open();
  await settle();
  assert.equal(f.moved, 0, "the first account's walk is not news about this one");
  assert.deepEqual(f.kept, B, "and it wrote nothing into this account's store");
});
