import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { NAME, placeOf, tabTitle } = require("../../src/title.js");

const GUID = "72f988bf-86f1-41af-91ab-2d7cd011db47";

test("offline wins over whoever was signed in", () => {
  assert.equal(placeOf({ offline: true, account: "a@contoso.com", tenant: GUID }), "offline");
  assert.equal(placeOf({ offline: true }), "offline");
});

test("the home tenant is the account's domain", () => {
  assert.equal(placeOf({ offline: false, account: "a@contoso.com", tenant: "" }), "contoso.com");
});

test("the tenant setting is named as it is: a guest's own domain would be the wrong tenant", () => {
  assert.equal(placeOf({ offline: false, account: "a@contoso.com", tenant: GUID }), GUID);
});

test("an account with no domain is shown as it is, and none at all is nothing", () => {
  assert.equal(placeOf({ offline: false, account: "someone", tenant: "" }), "someone");
  assert.equal(placeOf({ offline: false }), "");
});

test("the tab always starts with the product's name", () => {
  assert.equal(tabTitle("offline"), `${NAME}: offline`);
  assert.equal(tabTitle("contoso.com"), `${NAME}: contoso.com`);
  assert.equal(tabTitle(""), NAME);
});
