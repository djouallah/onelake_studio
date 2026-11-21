// The command line with VS Code closed, from a real vsix, on Windows: its bundle, its own engine server
// and DuckDB's extensions. Nothing stands in but the sign-in: a
// browser can't be driven here, so an account already known is what it runs on, and its reads are the
// ones that need no connection.
//
//   node test/e2e/run-standalone.mjs <the vsix, unpacked>/extension
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const extension = process.argv[2];
assert.ok(existsSync(join(extension, "dist", "standalone.js")), "no dist/standalone.js in the vsix");
const cli = join(extension, "cli", "cli.mjs");
const home = await mkdtemp(join(tmpdir(), "onelake-standalone-"));
const env = { ...process.env, ONELAKE_STUDIO_HOME: home, ONELAKE_STUDIO_BRIDGE: `\\\\.\\pipe\\onelake-nobody-${process.pid}` };

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", d => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", d => { stderr += d; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

const step = async (what, fn) => { await fn(); console.log(`ok - ${what}`); };
const said = r => `exit ${r.code}\n${r.stdout}\n${r.stderr}`;

try {
  await step("--version answers", async () => {
    const r = await run(["--version"]);
    assert.equal(r.code, 0, said(r));
  });

  await step("signed out it says how to sign in, exit 3, and opens no browser", async () => {
    const r = await run(["ls"]);
    assert.equal(r.code, 3, said(r));
    assert.match(r.stderr, /signin/, said(r));
  });

  await step("status answers signed out", async () => {
    const r = await run(["status", "--json"]);
    assert.equal(r.code, 0, said(r));
    assert.equal(JSON.parse(r.stdout).ok, true);
  });

  await step("export says it needs VS Code", async () => {
    const r = await run(["export", "shop", "m"]);
    assert.equal(r.code, 3, said(r));
    assert.match(r.stderr, /VS Code/, said(r));
  });

  // What a sign-in leaves behind, for the account's cache: no token, as offline has none to refresh.
  await writeFile(join(home, "standalone-state.json"), JSON.stringify({ "onelakeStudio.lastAccount": { key: "e2eaccount", queries: "e2e", tenant: "" } }));

  await step("sql runs on the real engine, in a server of its own", async () => {
    const r = await run(["sql", "SELECT 42 AS n", "--csv"]);
    assert.equal(r.code, 0, said(r));
    assert.match(r.stdout, /\b42\b/, said(r));
  });

  await step("a second statement joins that server", async () => {
    const r = await run(["sql", "SELECT 43 AS n", "--csv"]);
    assert.equal(r.code, 0, said(r));
    assert.match(r.stdout, /\b43\b/, said(r));
  });

  await step("signout forgets the sign-in and keeps what is cached, as Sign Out does in VS Code", async () => {
    const r = await run(["signout"]);
    assert.equal(r.code, 0, said(r));
    const listed = await run(["ls"]);
    assert.equal(listed.code, 4, said(listed));
    assert.match(listed.stderr, /not signed in/, said(listed));
    const read = await run(["sql", "SELECT 44 AS n", "--csv"]);
    assert.equal(read.code, 0, said(read));
    assert.ok(read.stdout.includes("44"), said(read));
  });
  console.log("all passed");
} finally {
  await rm(home, { recursive: true, force: true }).catch(() => {});
}
// The engine's server waits a minute for another client; a run has nothing more for it.
process.exit(0);
