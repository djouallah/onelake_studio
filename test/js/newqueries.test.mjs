// newqueries.js: a new query is known for as long as it has a tab, across a reload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { createNewQueries } = createRequire(import.meta.url)("../../src/newqueries.js");

const memento = () => {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: (k, v) => { m.set(k, v); } };
};
const Q1 = "untitled:Untitled-1", Q2 = "untitled:Untitled-2";

test("a reload restores the tab, and it is still a query", () => {
  const state = memento();
  createNewQueries(state, () => []).add(Q1);
  // A new extension host: the same storage, and the tab restored by VS Code.
  assert.equal(createNewQueries(state, () => [Q1]).has(Q1), true);
  // Tabs not restored yet when the extension starts: nothing is forgotten.
  assert.equal(createNewQueries(state, () => []).has(Q1), true);
});

test("an untitled editor nobody opened as a query is not one", () => {
  assert.equal(createNewQueries(memento(), () => [Q1]).has(Q1), false);
});

test("a closed tab frees its name, for this session and the next", () => {
  const state = memento();
  let tabs = [Q1, Q2];
  const q = createNewQueries(state, () => tabs);
  q.add(Q1); q.add(Q2);
  tabs = [Q2];
  q.tabsClosed([Q1]);
  assert.equal(q.has(Q1), false);
  assert.equal(q.has(Q2), true);
  assert.equal(createNewQueries(state, () => tabs).has(Q1), false);
});

test("a tab moved to another group, or a second tab left open, keeps the query", () => {
  const q = createNewQueries(memento(), () => [Q1]);
  q.add(Q1);
  q.tabsClosed([Q1]);
  assert.equal(q.has(Q1), true);
});

test("a tab closed while the extension was not running is forgotten at the next start", () => {
  const state = memento();
  createNewQueries(state, () => []).add(Q1);
  assert.equal(createNewQueries(state, () => [Q2]).has(Q1), false);
});
