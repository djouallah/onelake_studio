// signin.js: when the account provider is asked, what a Sign Out stops, whose cache a session
// means, and which audience the Fabric API's token is in. The provider is faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createSignIn, SCOPES } = require("../../core/signin.js");

const STORAGE = "https://storage.azure.com/user_impersonation";
const FABRIC = "https://api.fabric.microsoft.com/.default";
const POWERBI = "https://analysis.windows.net/powerbi/api/.default";

const account = { id: "id-1", label: "a@contoso.com" };

function memory() {
  const kept = new Map();
  return { get: (k, d) => (kept.has(k) ? kept.get(k) : d), update: async (k, v) => { kept.set(k, v); }, kept };
}

function setup({ session, tenant = "", noInternet = false, state = memory() } = {}) {
  const asked = [];
  const lines = [];
  const signIn = createSignIn({
    session: async (scopes, options) => {
      asked.push({ scopes, options });
      return session ? session(scopes, options) : { accessToken: `token-${asked.length}`, account };
    },
    memento: () => state,
    tenant: () => tenant,
    connectivity: { noInternet: () => noInternet },
    log: line => lines.push(line),
  });
  return { signIn, asked, lines, state };
}

test("sign-in asks for the storage scope and offline_access, with its options as they came", async () => {
  const { signIn, asked } = setup();
  await signIn.getToken({ createIfNone: true, clearSessionPreference: true });
  assert.deepEqual(asked[0].scopes, SCOPES);
  assert.ok(SCOPES.includes(STORAGE) && SCOPES.includes("offline_access"));
  assert.deepEqual(asked[0].options, { createIfNone: true, clearSessionPreference: true });
});

test("after a Sign Out nothing asks the provider, until a sign-in does", async () => {
  const { signIn, asked } = setup();
  await signIn.markSignedOut();
  assert.equal(signIn.signedOutByChoice(), true);
  assert.equal(await signIn.getSession({ createIfNone: false }), null);
  assert.equal(asked.length, 0);
  assert.ok(await signIn.getSession({ createIfNone: true }));
  assert.equal(asked.length, 1);
  assert.equal(signIn.signedOutByChoice(), false);
});

test("a failed sign-in is kept for the message, and is not a cancel", async () => {
  const { signIn, lines } = setup({ session: () => { throw new Error("wrong tenant"); } });
  assert.equal(await signIn.getToken({ createIfNone: true }), null);
  assert.equal(signIn.lastAuthError().message, "wrong tenant");
  assert.match(lines[0], /sign-in failed: wrong tenant/);
});

test("the account's key is a hash per account and tenant, saying nothing about who it is", () => {
  const { signIn } = setup();
  const key = signIn.accountKey({ account });
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.equal(signIn.accountKey({ account }), key);
  assert.notEqual(setup({ tenant: "t" }).signIn.accountKey({ account }), key);
  assert.equal(signIn.accountKey(null), null);
});

test("saved queries' account is readable, and safe as a folder's name", () => {
  assert.equal(setup().signIn.queryAccountOf({ account }), "a@contoso.com");
  assert.equal(setup({ tenant: "a/b" }).signIn.queryAccountOf({ account }), "a@contoso.com (a_b)");
  assert.equal(setup().signIn.queryAccountOf(null), null);
});

test("the account last signed in is known only in the tenant it was in", () => {
  const state = memory();
  setup({ state }).signIn.rememberAccount({ account });
  assert.equal(setup({ state }).signIn.knownAccount().queries, "a@contoso.com");
  assert.equal(setup({ state, tenant: "other" }).signIn.knownAccount(), null);
});

test("a burst shares one question to the provider, and fresh goes past what is held", async () => {
  const { signIn, asked } = setup();
  const [a, b] = await Promise.all([signIn.hostToken(), signIn.hostToken()]);
  assert.equal(a, b);
  assert.equal(await signIn.hostToken(), a);
  assert.equal(asked.length, 1);
  assert.notEqual(await signIn.hostToken({ fresh: true }), a);
  assert.equal(asked.length, 2);
});

test("with no internet the token held is the answer, and the provider isn't asked", async () => {
  const state = memory();
  let noInternet = false;
  const asked = [];
  const signIn = createSignIn({
    session: async scopes => { asked.push(scopes); return { accessToken: "held", account }; },
    memento: () => state, tenant: () => "", log: () => {},
    connectivity: { noInternet: () => noInternet },
  });
  await signIn.hostToken();
  noInternet = true;
  assert.equal(await signIn.hostToken({ fresh: true }), "held");
  assert.equal(asked.length, 1);
});

test("the Fabric API's token is for the storage session's account, in the audience that answers", async () => {
  const { signIn, asked } = setup({
    session: scopes => {
      if (scopes.includes(FABRIC)) throw new Error("not for this resource");
      return { accessToken: scopes.includes(POWERBI) ? "powerbi" : "storage", account };
    },
  });
  assert.equal(await signIn.fabricToken(), "powerbi");
  const fabricAsks = asked.filter(a => !a.scopes.includes(STORAGE));
  assert.deepEqual(fabricAsks.map(a => a.scopes[0]), [FABRIC, POWERBI]);
  for (const a of fabricAsks) assert.equal(a.options.account, account);
  // The one that answered is remembered: the next read doesn't try the other first.
  asked.length = 0;
  assert.equal(await signIn.fabricToken({ fresh: true }), "powerbi");
  assert.deepEqual(asked.filter(a => !a.scopes.includes(STORAGE)).map(a => a.scopes[0]), [POWERBI]);
});

test("no asks the Fabric API's other audience after a cancel", async () => {
  const { signIn, asked } = setup({
    session: scopes => {
      if (scopes.includes(FABRIC)) throw new Error("User did not consent");
      return { accessToken: "storage", account };
    },
  });
  assert.equal(await signIn.fabricToken({ createIfNone: true }), null);
  assert.equal(asked.filter(a => a.scopes.includes(POWERBI)).length, 0);
});

test("Export's token is only ever the Fabric API's own audience", async () => {
  const { signIn, asked } = setup();
  assert.ok(await signIn.appToken({ createIfNone: true }));
  const last = asked.at(-1);
  assert.deepEqual(last.scopes, [FABRIC, "offline_access"]);
  assert.equal(last.options.createIfNone, true);
});

test("forgetting the token asks again", async () => {
  const { signIn, asked } = setup();
  await signIn.hostToken();
  signIn.forgetToken();
  await signIn.hostToken();
  assert.equal(asked.length, 2);
});
