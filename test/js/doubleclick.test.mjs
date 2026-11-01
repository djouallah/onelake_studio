// doubleclick.js: VS Code runs a tree item's command for each click of a double click, and it counts as one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { firstClicks } = require("../../src/doubleclick.js");

function clicks() {
  let t = 1000;
  const click = firstClicks(500, () => t);
  return { click, wait: ms => { t += ms; } };
}

test("one click counts", () => {
  assert.equal(clicks().click("a"), true);
});

test("a click with no item counts, as a command with no node gets", () => {
  assert.equal(clicks().click(undefined), true);
});

test("two clicks on one item, close together, are one", () => {
  const { click, wait } = clicks();
  click("a");
  wait(200);
  assert.equal(click("a"), false);
});

test("a third close behind is still the same click", () => {
  const { click, wait } = clicks();
  click("a");
  wait(200);
  click("a");
  wait(200);
  assert.equal(click("a"), false);
});

test("two clicks far apart are two", () => {
  const { click, wait } = clicks();
  click("a");
  wait(501);
  assert.equal(click("a"), true);
});

test("two clicks on two items are two", () => {
  const { click, wait } = clicks();
  click("a");
  wait(100);
  assert.equal(click("b"), true);
});
