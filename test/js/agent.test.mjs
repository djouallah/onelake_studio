// agent.js: the command line's SQL rewrites and answers, which need no engine, called directly.
// What an agent's shell sees of them, the process and its exit code, is cli.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fakeOneLake, richAgent, stubVendor, APP_DIR } from "./agent-fixtures.mjs";

const require = createRequire(import.meta.url);
const { EXIT } = require("../../cli/bridge.js");

test("models and items --fresh: every workspace read now, and one that fails is a note", async () => {
  const { createAgent } = require("../../cli/agent.js");
  const onelake = {
    workspaces: async () => ["b ws", "a ws", "broken"],
    models: async w => {
      if (w === "broken") throw Object.assign(new Error("Unauthorized"), { status: 401 });
      return w === "a ws" ? [{ name: "Sales", description: "the sales model" }, { name: "Ops", description: "" }]
                          : [{ name: "Energy", description: "" }];
    },
    items: async w => (w === "broken" ? [] : [{ name: `${w[0]}.Lakehouse`, kind: "Lakehouse" }, { name: "dw.Warehouse", kind: "Warehouse" }]),
  };
  const agent = createAgent({ onelake, modelPath: () => "/nowhere/x.bim" });
  const fresh = { fresh: true };

  let r = await agent.run({ args: ["models"], opts: fresh });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /3 semantic model\(s\) in 2 workspace\(s\); 1 could not be read$/);
  assert.match(r.err, /broken: not listed/);
  assert.match(r.err, /sign in to Fabric/);
  assert.doesNotMatch(r.err, /from the cache/, "read now, not off disk");

  r = await agent.run({ args: ["models", "b ws"], opts: fresh });
  assert.match(r.out, /1 semantic model\(s\) in 1 workspace\(s\)$/);

  r = await agent.run({ args: ["items"], opts: fresh });
  assert.match(r.out, /4 item\(s\): 2 Lakehouse, 2 Warehouse$/);
});

test("models and items: every cached workspace, counted, and nothing fetched", async () => {
  const { createAgent } = require("../../cli/agent.js");
  const onelake = fakeOneLake();
  const agent = createAgent({ onelake, modelPath: () => "/nowhere/x.bim" });

  let r = await agent.run({ args: ["models"] });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\| a ws \| Ops \|[\s\S]*\| a ws \| Sales \|[\s\S]*\| b ws \| Energy \|/, "sorted by workspace, then name");
  assert.match(r.out, /3 semantic model\(s\) in 2 workspace\(s\); 1 workspace\(s\) not cached$/);
  assert.match(r.err, /not cached yet, so not counted: unseen/);
  assert.match(r.err, /as of 3 h ago/);

  r = await agent.run({ args: ["items"] });
  assert.match(r.out, /3 item\(s\): 2 Lakehouse, 1 Warehouse; 1 workspace\(s\) not cached$/);

  r = await agent.run({ args: ["models"], opts: { csv: true } });
  assert.equal(r.out.split("\n")[0], "workspace,semantic_model,downloaded,staging,tables,measures,description");

  assert.deepEqual(onelake.calls, [], "no OneLake or Fabric call without --fresh");
});

test("a listing or metadata not cached says so; --fresh is what reads it", async () => {
  const { createAgent } = require("../../cli/agent.js");
  const onelake = fakeOneLake();
  const agent = createAgent({ onelake, modelPath: () => "/nowhere/x.bim" });

  let r = await agent.run({ args: ["ls", "unseen"] });
  assert.equal(r.code, EXIT.NOT_CACHED);
  assert.match(r.err, /not cached yet — expand unseen in the OneLake Studio tree, or add --fresh/);

  r = await agent.run({ args: ["ls", "a ws", "a"] });
  assert.equal(r.code, EXIT.NOT_CACHED);
  assert.match(r.err, /a ws\/a\.Lakehouse's tables is not cached yet/);

  r = await agent.run({ args: ["table", "a ws", "a", "dbo.x"] });
  assert.equal(r.code, EXIT.NOT_CACHED);
  assert.match(r.err, /dbo\.x's metadata is not cached yet/);

  r = await agent.run({ args: ["model", "a ws", "Sales"] });
  assert.equal(r.code, EXIT.NOT_CACHED);
  assert.match(r.err, /a ws\/Sales is not downloaded yet — open it in the OneLake Studio tree, or add --fresh/);
  assert.deepEqual(onelake.calls, []);

  r = await agent.run({ args: ["ls"], opts: { fresh: true } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\| x \|/, "what OneLake answered");
  assert.deepEqual(onelake.calls, [["workspaces"]], "--fresh asks OneLake");
});

test("free from the cache: table sizes, more table fields, files, find, model counts", async () => {
  const { agent, calls, close } = await richAgent();
  try {
    let r = await agent.run({ args: ["ls", "ws", "data"] });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\| customers \| ws\.data\.dbo\.customers \| 1,200 \| 2\.5 MB \| 3 \| 2026-10-01 08:30 \|/);
    assert.match(r.out, /\| orders \| ws\.data\.dbo\.orders \| — \| — \| — \| — \|/);
    assert.match(r.out, /2 table\(s\), 1 with metadata cached/);

    r = await agent.run({ args: ["table", "ws", "data", "customers"] });
    assert.equal(r.code, 0, r.err);   // a bare name: found in the schema-less listing, not guessed as dbo
    assert.match(r.out, /\| compression \| zstd \|/);
    assert.match(r.out, /\| snapshots \| 4 \|/);
    assert.match(r.out, /\| Iceberg format \| v2 \|/);

    r = await agent.run({ args: ["files", "ws", "data", "Files/raw"] });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\| 2026 \| 'ws\.data\/Files\/raw\/2026' \| folder \|/);
    assert.match(r.out, /1 file\(s\), 1 folder\(s\), 1\.0 MB in Files\/raw/);
    r = await agent.run({ args: ["files", "ws", "dw"] });
    assert.match(r.err, /has no Files area/);
    r = await agent.run({ args: ["files", "ws", "data", "other"] });
    assert.match(r.err, /Files\/other is not cached yet/);

    r = await agent.run({ args: ["find", "custom"] });
    assert.equal(r.code, 0, r.err);
    for (const re of [/\| table \| ws\/data\.Lakehouse \| customers \|/, /\| column \| ws\/data\.Lakehouse customers \| customer_id \(long\) \|/,
                      /\| model table \| ws\/Sales \| dim_customer \|/, /\| measure \| ws\/Sales \| \[Customer Count\] in fct_sales \|/]) {
      assert.match(r.out, re);
    }

    r = await agent.run({ args: ["models"] });
    assert.match(r.out, /\| ws \| Sales \| downloaded \|  \| 2 \| 2 \|/);
    assert.match(r.out, /\| ws \| Ops \|  \|  \|  \|/);

    assert.deepEqual(calls, [], "nothing fetched");
  } finally { await close(); }
});

// export hands Explore's own export the model file, as Explore's button does; the dax-sql and
// YAML modules it loads stand in as stubs (CI's test job has no vendor/).
test("export: a model file in Files/, or a semantic model's local copy", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const vendorDir = await mkdtemp(join(tmpdir(), "agent-vendor-"));
  try {
    await stubVendor(vendorDir);
    const { createAgent } = require("../../cli/agent.js");
    const onelake = fakeOneLake();
    onelake.readBytes = async (ws, path) => new TextEncoder().encode(`model at ${ws}/${path}`);
    onelake.cached.models = async ws => ws === "a ws" ? { value: [{ id: "m1", name: "Sales" }, { id: "m2", name: "Ops" }], at: Date.now() } : null;
    // Sales is downloaded (its local copy); Ops is not.
    await writeFile(join(vendorDir, "Sales.yaml"), "the Sales model");
    const exported = [];
    const agent = createAgent({
      onelake, modelPath: (ws, model) => join(vendorDir, `${model}.yaml`),
      appDir: APP_DIR,
      vendorDir, daxSqlPin: "pin", yamlPin: "yaml",
      exportApp: async x => { exported.push(x); return `Published to Fabric: ${x.name}`; },
    });

    let r = await agent.run({ args: ["export", "a ws", "a", "Files/models/sales-2.yaml"] });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "Published to Fabric: sales_2");
    assert.deepEqual(exported.pop(), { file: "sales-2.yaml", name: "sales_2", text: "model at a ws/a.Lakehouse/Files/models/sales-2.yaml",
                                       state: null, workspace: "a ws", path: "a.Lakehouse/Files/models/sales-2.yaml" });

    r = await agent.run({ args: ["export", "a ws", "sales"] });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(exported.pop(), { file: "Sales.yaml", name: "Sales", text: "the Sales model", state: null,
                                       model: { workspace: "a ws", name: "Sales" } });

    // export takes no --mode: what the app runs on is what the model is.
    r = await agent.run({ args: ["export", "a ws", "sales"], opts: { mode: "directlake" } });
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.err, /--mode is not an option of export/);
    r = await agent.run({ args: ["semanticmodel", "a ws", "a", "Files/x.yaml"], opts: { mode: "client" } });
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.err, /--mode takes directlake or directquery, not "client"/);
    r = await agent.run({ args: ["ls"], opts: { mode: "client" } });
    assert.match(r.err, /--mode is not an option of ls/);

    r = await agent.run({ args: ["export", "a ws", "Ops"] });
    assert.equal(r.code, EXIT.NOT_CACHED);
    assert.match(r.err, /a ws\/Ops is not downloaded yet — open it in the OneLake Studio tree/);

    r = await agent.run({ args: ["export", "a ws", "dw", "Files/x.bim"] });
    assert.match(r.err, /dw\.Warehouse has no Files area/);
    assert.equal(exported.length, 0);

    r = await createAgent({ onelake, modelPath: () => "" }).run({ args: ["export", "a ws", "Sales"] });
    assert.match(r.err, /Export to Fabric is not available here/);
  } finally {
    await rm(vendorDir, { recursive: true, force: true });
  }
});

test("report: a model's Report read with the fields a tile can name, and --set writes only one the page can draw", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const vendorDir = await mkdtemp(join(tmpdir(), "agent-vendor-"));
  try {
    await stubVendor(vendorDir);
    // A compiler that compiles any query but one naming the measure "Broken".
    await writeFile(join(vendorDir, "npm/pin/src/index.js"), "export const createViews = 0; export const createCompiler = () => ({ " +
      "compileStatement: t => { if (t.includes('\"Broken\"')) throw new Error('no measure Broken\\nLINE 1'); return { sql: t }; } });");
    await writeFile(join(vendorDir, "npm/pin/formats/tmsl.js"), "export const tmslToModel = b => b;");
    const model = JSON.stringify({ datasets: [], tmsl: { model: {
      tables: [
        { name: "dim_zone", columns: [{ name: "Borough", dataType: "string" }] },
        { name: "fct_trips", columns: [{ name: "fare", dataType: "double" }],
          measures: [{ name: "Total Trips", expression: "COUNT(*)" }, { name: "Broken", expression: "x" }] },
      ],
      relationships: [{ fromTable: "fct_trips", fromColumn: "zone", toTable: "dim_zone", toColumn: "id" }],
    } } });
    await writeFile(join(vendorDir, "Sales.yaml"), model);
    const { createAgent } = require("../../cli/agent.js");
    const onelake = fakeOneLake();
    onelake.readBytes = async () => new TextEncoder().encode(model);
    onelake.cached.models = async ws => ws === "a ws" ? { value: [{ id: "m1", name: "Sales" }], at: Date.now() } : null;
    const kept = new Map(), saved = [];
    const key = m => `${m.workspace}/${m.model}`.toLowerCase();
    const report = {
      load: async m => (kept.has(key(m)) ? { spec: kept.get(key(m)), stamp: 1, from: `/reports/${key(m)}.json` } : { spec: { tiles: [] }, stamp: 0, from: null }),
      save: async m => { saved.push(m); kept.set(key(m), m.spec); return { stamp: 1 }; },
    };
    const agent = createAgent({ onelake, modelPath: (ws, m) => join(vendorDir, `${m}.yaml`), appDir: APP_DIR,
                                vendorDir, daxSqlPin: "pin", yamlPin: "yaml", report });
    const file = ["report", "a ws", "a", "Files/models/nyc-taxi.yaml"];

    let r = await agent.run({ args: file, opts: { json: true } });
    assert.equal(r.code, 0, r.out);
    let body = JSON.parse(r.out);
    assert.equal(body.data.model, "a ws.nyc_taxi_semanticmodel", "named as its Report tab names it: its file's name, in its workspace");
    assert.equal(body.data.kept, null);
    assert.deepEqual(body.data.report, { tiles: [] });
    assert.deepEqual(body.data.fields.map(t => [t.table, t.fields.map(f => f.id)]),
      [["dim_zone", ["dim_zone.Borough"]], ["fct_trips", ["fct_trips.fare", "Total Trips", "Broken"]]]);
    r = await agent.run({ args: file });
    assert.match(r.out, /not written yet/);
    assert.match(r.out, /dim_zone \(dimension\): dim_zone\.Borough \(text\)/);

    // Each problem named, and nothing written.
    const bad = { pages: [{ name: "One", tiles: [
      { kind: "pivot", title: "Trips", pivot: { rows: ["dim_zone.Borugh"], values: ["Total Trips"], mark: "bars" } },
      { kind: "pivot", title: "Broken", pivot: { rows: ["dim_zone.Borough"], values: ["Broken"] } },
      { kind: "pivot", layout: { x: 8, y: 0, w: 6, h: 10 }, pivot: { values: ["Total Trips"], mark: "card" } },
    ] }], theme: { style: "neon" } };
    r = await agent.run({ args: file, opts: { set: JSON.stringify(bad), json: true } });
    assert.equal(r.code, EXIT.FAILED);
    body = JSON.parse(r.out);
    const problems = body.error.problems.join("\n");
    assert.match(problems, /tile 1 "Trips", rows: no field "dim_zone.Borugh" in the model \(near: dim_zone\.Borough\)/);
    assert.match(problems, /tile 1 "Trips": mark is one of auto, .*not "bars"/);
    assert.match(problems, /tile 2 "Broken": its query does not compile: no measure Broken$/m);
    assert.match(problems, /tile 3: layout is whole numbers on 12 columns/);
    assert.match(problems, /theme: style is one of paper, midnight, slate, not "neon"/);
    assert.equal(saved.length, 0);
    r = await agent.run({ args: file, opts: { set: "{ not json" } });
    assert.equal(r.code, EXIT.FAILED);
    assert.match(r.err, /the Report is not JSON/);

    const good = { theme: { style: "midnight" }, filters: [{ field: "dim_zone.Borough", style: "list" }], pages: [{ name: "One", tiles: [
      { kind: "text", text: "# Trips" },
      { kind: "pivot", title: "Trips", layout: { x: 0, y: 0, w: 6, h: 30 }, pivot: { rows: ["dim_zone.Borough"], values: ["Total Trips"], mark: "bar", sort: "desc", top: 5 } },
    ] }] };
    r = await agent.run({ args: file, opts: { set: JSON.stringify(good) } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /a ws\.nyc_taxi_semanticmodel's Report written: 1 page\(s\), 2 tile\(s\).*Kept in \/reports\/a ws\/nyc_taxi\.json/);
    assert.deepEqual(saved.pop(), { workspace: "a ws", model: "nyc_taxi", spec: good, stamp: null });
    r = await agent.run({ args: file, opts: { json: true } });
    assert.deepEqual(JSON.parse(r.out).data.report, good, "read back as written");

    // A semantic model's, by its own name; --set is report's alone.
    r = await agent.run({ args: ["report", "a ws", "sales"], opts: { set: JSON.stringify(good) } });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(saved.pop(), { workspace: "a ws", model: "Sales", spec: good, stamp: null });
    r = await agent.run({ args: ["ls"], opts: { set: "{}" } });
    assert.match(r.err, /--set is not an option of ls/);

    r = await createAgent({ onelake, modelPath: () => "" }).run({ args: ["report", "a ws", "Sales"] });
    assert.match(r.err, /a model's Report is not available here/);
  } finally {
    await rm(vendorDir, { recursive: true, force: true });
  }
});
