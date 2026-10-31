// doubleclick.js: VS Code runs a tree item's command on every click, so a double click is two of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { doubleClicks } = require("../../src/doubleclick.js");

function clicks() {
  let t = 1000;
  const click = doubleClicks(500, () => t);
  return { click, wait: ms => { t += ms; } };
}

test("one click is not a double click", () => {
  assert.equal(clicks().click("a"), false);
});

test("two clicks on one item, close together, are", () => {
  const { click, wait } = clicks();
  click("a");
  wait(200);
  assert.equal(click("a"), true);
});

test("two clicks far apart are not", () => {
  const { click, wait } = clicks();
  click("a");
  wait(501);
  assert.equal(click("a"), false);
});

test("two clicks on two items are not", () => {
  const { click, wait } = clicks();
  click("a");
  wait(100);
  assert.equal(click("b"), false);
});

test("the command run a third time for the double click itself does not fire again", () => {
  const { click, wait } = clicks();
  click("a");
  wait(100);
  assert.equal(click("a"), true);
  wait(10);
  assert.equal(click("a"), false);
});
