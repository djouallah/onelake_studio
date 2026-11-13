// The command line with VS Code closed, from a real vsix, on Windows: its bundle, its own engine server
// and DuckDB's extensions, and Excel's endpoint on a model file. Nothing stands in but the sign-in: a
// browser can't be driven here, so an account already known is what it runs on, and its reads are the
// ones that need no connection.
//
//   node test/e2e/run-standalone.mjs <the vsix, unpacked>/extension
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { createCatalogFile, catalogFileOf } = require("../../core/onelake/catalogfile.js");

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

// By GUIDs, as Fabric defines a model.
const BIM = {
  compatibilityLevel: 1604,
  model: {
    defaultMode: "directLake",
    expressions: [{ name: "DatabaseQuery", kind: "m", expression: 'let Source = AzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222") in Source' }],
    tables: [{
      name: "fct_sales",
      partitions: [{ name: "fct_sales", mode: "directLake", source: { type: "entity", entityName: "fct_sales", schemaName: "dbo", expressionSource: "DatabaseQuery" } }],
      columns: [{ name: "amount", dataType: "double", sourceColumn: "amount" }],
      measures: [{ name: "Total Sales", expression: "SUM ( fct_sales[amount] )" }],
    }],
  },
};

const discover = (url, type, catalog) => fetch(url, {
  method: "POST",
  headers: { "Content-Type": "text/xml" },
  body: `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><Discover xmlns="urn:schemas-microsoft-com:xml-analysis"><RequestType>${type}</RequestType><Restrictions/><Properties><PropertyList><Catalog>${catalog}</Catalog></PropertyList></Properties></Discover></soap:Body></soap:Envelope>`,
});

let server = null;
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

  await step("serve signed out is refused, exit 3", async () => {
    const file = join(home, "sales.bim");
    await writeFile(file, JSON.stringify(BIM));
    const r = await run(["serve", file]);
    assert.equal(r.code, 3, said(r));
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

  await step("a workspace it can't name, with no connection, is asked for", async () => {
    const r = await run(["serve", join(home, "sales.bim")]);
    assert.equal(r.code, 1, said(r));
    assert.match(r.stderr, /--workspace/, said(r));
  });

  // What opening a model while signed in leaves in the catalog: the names behind its GUIDs.
  {
    const file = catalogFileOf(join(home, "engine-server"), "e2eaccount|");
    createCatalogFile({ file }).close();
    const db = new DatabaseSync(file);
    db.prepare("INSERT OR REPLACE INTO item_name VALUES (?, ?, ?, ?, ?, ?)")
      .run("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", Date.now(), "shop", "data.Lakehouse", null);
    db.close();
  }

  await step("serve names a model from what's kept, with no connection, and answers Excel's questions", async () => {
    const file = join(home, "sales.bim");
    server = spawn(process.execPath, ["--no-warnings", cli, "serve", file, "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    server.stderr.setEncoding("utf8").on("data", d => { stderr += d; });
    const line = await new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`serve said nothing in 180s\n${stderr}`)), 180_000);
      server.stdout.setEncoding("utf8").on("data", d => {
        out += d;
        const nl = out.indexOf("\n");
        if (nl >= 0) { clearTimeout(timer); resolve(out.slice(0, nl)); }
      });
      server.on("close", code => { clearTimeout(timer); reject(new Error(`serve exited ${code}\n${out}\n${stderr}`)); });
    });
    const served = JSON.parse(line);
    assert.equal(served.ok, true, line);
    assert.equal(served.catalog, "shop.sales_semanticmodel");
    assert.equal(served.measures, 1);

    const ping = await fetch(served.url);
    assert.equal(ping.status, 200);
    assert.equal(await ping.text(), "onelake-studio-xmla");

    const refused = await fetch(served.url.replace(/[^/]+\/$/, "wrong/"));
    assert.equal(refused.status, 404, "a request without the token is refused");

    const measures = await (await discover(served.url, "MDSCHEMA_MEASURES", served.catalog)).text();
    assert.match(measures, /Total Sales/, measures.slice(0, 500));
  });

  server.removeAllListeners("close");
  server.kill();
  server = null;

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
  if (server) { server.removeAllListeners("close"); server.kill(); }
  await rm(home, { recursive: true, force: true }).catch(() => {});
}
// The engine's server waits a minute for another client; a run has nothing more for it.
process.exit(0);
