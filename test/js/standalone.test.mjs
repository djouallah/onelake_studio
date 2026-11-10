// The command line with VS Code closed: where its files are, reading VS Code's settings, what it keeps,
// and the session it asks MSAL for, with MSAL and DPAPI faked. test/e2e/run-standalone.mjs runs the real
// thing from a vsix, on Windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { pathsOf, parseSettings, keptIn } = require("../../core/home.js");
const { createMsalSession, scopesFor, CLIENT_ID } = require("../../core/msalsession.js");
const { createTokenStore, dpapiProtect, dpapiUnprotect } = require("../../core/tokenstore.js");

const temp = () => mkdtemp(join(tmpdir(), "standalone-"));

test("its files are VS Code's for this extension, Insiders' under Insiders", () => {
  const env = { APPDATA: "C:/AppData" };
  const code = pathsOf("C:/Users/u/.vscode/extensions/djouallah.onelake-studio-0.2.10", env);
  assert.match(code.home.replaceAll("\\", "/"), /Code\/User\/globalStorage\/djouallah\.onelake-studio$/);
  assert.match(code.settingsFile.replaceAll("\\", "/"), /Code\/User\/settings\.json$/);
  const insiders = pathsOf("C:/Users/u/.vscode-insiders/extensions/x", env);
  assert.match(insiders.home.replaceAll("\\", "/"), /Code - Insiders\/User\/globalStorage/);
});

test("with no VS Code, the desktop app keeps its files in a folder of its own", () => {
  const p = pathsOf("C:/Users/u/AppData/Local/OneLake Studio/app", { APPDATA: "C:/Roaming", LOCALAPPDATA: "C:/Local" }, () => false);
  assert.match(p.home.replaceAll("\\", "/"), /^C:\/Local\/OneLake Studio\/data$/);
  const shared = pathsOf("C:/Users/u/AppData/Local/OneLake Studio/app", { APPDATA: "C:/Roaming", LOCALAPPDATA: "C:/Local" }, () => true);
  assert.match(shared.home.replaceAll("\\", "/"), /Code\/User\/globalStorage\/djouallah\.onelake-studio$/, "and VS Code's, where it has some");
});

test("ONELAKE_STUDIO_HOME keeps it all somewhere else", () => {
  const p = pathsOf("anywhere", { ONELAKE_STUDIO_HOME: "/tmp/h" });
  assert.equal(p.home, "/tmp/h");
  assert.equal(p.settingsFile.replaceAll("\\", "/"), "/tmp/h/settings.json");
});

test("VS Code's settings: comments and trailing commas go, and text in a string stays", () => {
  const s = parseSettings(`{
    // a comment
    "onelakeStudio.tenantId": "a//b", /* another */
    "http.proxy": "http://p:1/,}",
    "list": [1, 2,],
  }`);
  assert.equal(s["onelakeStudio.tenantId"], "a//b");
  assert.equal(s["http.proxy"], "http://p:1/,}");
  assert.deepEqual(s.list, [1, 2]);
});

test("settings that can't be read are none, not a failure", () => {
  assert.deepEqual(parseSettings("{ not json"), {});
  assert.deepEqual(parseSettings("[1]"), {});
});

test("what is kept outlives the process, and a missing file is nothing kept", async () => {
  const dir = await temp();
  const file = join(dir, "kept.json");
  const a = keptIn(file);
  assert.equal(a.get("k", "fallback"), "fallback");
  await a.update("k", { x: 1 });
  await a.store("s", "secret");
  const b = keptIn(file);
  assert.deepEqual(b.get("k"), { x: 1 });
  assert.equal(b.get("s"), "secret");
  await b.update("k", undefined);
  assert.equal(keptIn(file).get("k", "gone"), "gone");
  await rm(dir, { recursive: true, force: true });
});

test("this client asks for each resource's .default, and MSAL adds offline_access itself", () => {
  assert.deepEqual(scopesFor(["https://storage.azure.com/user_impersonation", "offline_access"]), ["https://storage.azure.com/.default"]);
  assert.deepEqual(scopesFor(["https://api.fabric.microsoft.com/.default", "offline_access"]), ["https://api.fabric.microsoft.com/.default"]);
});

// MSAL, as much of it as a session asks of.
function fakeMsal({ accounts = [], silent, interactive } = {}) {
  const made = [];
  const removed = [];
  class PublicClientApplication {
    constructor(config) { made.push(config); }
    getTokenCache() {
      return { getAllAccounts: async () => accounts, removeAccount: async a => { removed.push(a.homeAccountId); } };
    }
    acquireTokenSilent(r) { return silent(r); }
    acquireTokenInteractive(r) { return interactive(r); }
  }
  return { made, removed, library: () => ({ PublicClientApplication }) };
}
const ALICE = { homeAccountId: "oid.tid", username: "a@contoso.com" };
const answer = (token, account = ALICE) => ({ accessToken: token, account });
const STORE = { read: async () => null, write: async () => {}, clear: async () => {} };
const STORAGE = ["https://storage.azure.com/user_impersonation", "offline_access"];

function session(fake, over = {}) {
  return createMsalSession({ tenant: () => "", store: STORE, msal: fake.library, openBrowser: async () => {}, ...over });
}

test("signs in as the Azure CLI's public client, at the tenant the setting names", async () => {
  const fake = fakeMsal({ accounts: [ALICE], silent: async () => answer("t") });
  await session(fake).session(STORAGE);
  assert.equal(fake.made[0].auth.clientId, CLIENT_ID);
  assert.match(fake.made[0].auth.authority, /\/organizations$/);
  await session(fake, { tenant: () => "my-tenant" }).session(STORAGE);
  assert.match(fake.made[1].auth.authority, /\/my-tenant$/);
});

test("a session is what signin.js gets from VS Code: the token, and homeAccountId as the account's id", async () => {
  const fake = fakeMsal({ accounts: [ALICE], silent: async () => answer("t") });
  assert.deepEqual(await session(fake).session(STORAGE), { accessToken: "t", account: { id: "oid.tid", label: "a@contoso.com" } });
});

test("with nobody signed in, no sign-in is asked for unless createIfNone says so", async () => {
  let asked = 0;
  const fake = fakeMsal({ interactive: async () => { asked++; return answer("new"); } });
  assert.equal(await session(fake).session(STORAGE), null);
  assert.equal(asked, 0);
  assert.equal((await session(fake).session(STORAGE, { createIfNone: true })).accessToken, "new");
  assert.equal(asked, 1);
});

test("a token that can't be refreshed is no session; no answer is not, since it says nothing", async () => {
  const refused = fakeMsal({ accounts: [ALICE], silent: async () => { throw Object.assign(new Error("AADSTS70008 expired"), { errorCode: "invalid_grant" }); } });
  assert.equal(await session(refused).session(STORAGE), null);
  const noAnswer = fakeMsal({ accounts: [ALICE], silent: async () => { throw Object.assign(new Error("fetch failed"), { errorCode: "network_error" }); } });
  await assert.rejects(session(noAnswer).session(STORAGE), /fetch failed/);
});

test("the Fabric API's token is asked for the same account, not whichever is first", async () => {
  const bob = { homeAccountId: "bob", username: "b@contoso.com" };
  let used;
  const fake = fakeMsal({ accounts: [bob, ALICE], silent: async r => { used = r.account; return answer("t", r.account); } });
  await session(fake).session(["https://api.fabric.microsoft.com/.default", "offline_access"], { account: { id: "oid.tid", label: "a@contoso.com" } });
  assert.equal(used, ALICE);
});

test("one account at a time: the one just signed in as", async () => {
  const bob = { homeAccountId: "bob", username: "b@contoso.com" };
  const fake = fakeMsal({ accounts: [bob, ALICE] });
  await session(fake).keepOnly("oid.tid");
  assert.deepEqual(fake.removed, ["bob"]);
});

test("the token cache: encrypted on disk, read once, and what can't be read is no sign-in", async () => {
  const dir = await temp();
  const file = join(dir, "cache.bin");
  let reads = 0;
  const store = () => createTokenStore(file, { protect: async t => `sealed:${t}`, unprotect: async s => { reads++; return s.replace("sealed:", ""); } });
  const a = store();
  assert.equal(await a.read(), null);
  await a.write("tokens");
  assert.equal(await readFile(file, "utf8"), "sealed:tokens");
  const b = store();
  assert.equal(await b.read(), "tokens");
  await b.read();
  assert.equal(reads, 1);
  await writeFile(file, "from another machine");
  const broken = createTokenStore(file, { unprotect: async () => { throw new Error("no"); } });
  assert.equal(await broken.read(), null);
  await b.clear();
  assert.equal(await createTokenStore(file, { unprotect: async s => s }).read(), null);
  await rm(dir, { recursive: true, force: true });
});

test("real DPAPI, where there is one: what goes in comes out, and isn't readable on disk", { skip: process.platform !== "win32" }, async () => {
  const sealed = await dpapiProtect("the refresh token");
  assert.equal(sealed.includes("refresh"), false);
  assert.notEqual(Buffer.from(sealed, "base64").toString("utf8").includes("refresh"), true);
  assert.equal(await dpapiUnprotect(sealed), "the refresh token");
});
