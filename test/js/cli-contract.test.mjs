// The command line's contract, over every command in every format it takes, through the real
// process: the same invariants on every answer, so a command added later has them or fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { withAgent, csvRows } from "./cli-harness.mjs";
import { richAgent, fakeOneLake, APP_DIR } from "./agent-fixtures.mjs";

const require = createRequire(import.meta.url);
const { EXIT, exitName, COMMANDS } = require("../../src/bridge.js");
const { createAgent } = require("../../src/agent.js");
const { modelFileName } = require("../../src/fabric.js");
const { ALL_TABLES_COUNTED } = require("../../src/sql.js");

// What a query answers, without an engine: `numRows` may be more than the rows that came back.
const fakeEngine = (rows = [{ a: 1, b: "x,y" }, { a: 2, b: null }], numRows = rows.length) => ({
  agentQuery: async () => ({ fields: [{ name: "a", type: "BIGINT" }, { name: "b", type: "VARCHAR" }], rows, numRows }),
});

const FORMATS = { markdown: [], csv: ["--csv"], json: ["--json"] };
// `ls <ws>` is the one answer of two tables, so the one that takes no --csv (asserted below).
const takes = (argv, format) => format === "markdown" ||
  (COMMANDS[argv[0]].flags.includes(format) && !(format === "csv" && argv[0] === "ls" && argv.length === 2));

const ANSWERED = [
  ["ls"], ["ls", "ws", "data"], ["models"], ["models", "ws"], ["items"], ["items", "ws"],
  ["files", "ws", "data", "Files/raw"], ["files", "ws", "data", "Files/empty"],
  ["find", "custom"], ["find", "no such name"], ["table", "ws", "data", "customers"],
  ["sql", "SELECT 1"], ["export", "ws", "Sales"],
];
const NOT_ANSWERED = [
  [["ls", "unseen"], EXIT.NOT_CACHED],
  [["ls", "unseen", "x"], EXIT.NOT_CACHED],
  [["ls", "ws", "nope"], EXIT.FAILED],
  [["models", "unseen"], EXIT.NOT_CACHED],
  [["items", "unseen"], EXIT.NOT_CACHED],
  [["files", "ws", "data", "other"], EXIT.NOT_CACHED],
  [["files", "ws", "dw"], EXIT.FAILED],
  [["files", "ws", "nope"], EXIT.FAILED],
  [["table", "ws", "data", "orders"], EXIT.NOT_CACHED],
  [["table", "ws", "nope", "x"], EXIT.FAILED],
  [["model", "ws", "Ops"], EXIT.NOT_CACHED],
  [["export", "ws", "Ops"], EXIT.NOT_CACHED],
  [["export", "ws", "nope"], EXIT.FAILED],
];

function checkAnswer(r, format, where) {
  assert.equal(r.code, EXIT.OK, `${where}: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /^\s+at /m, `${where}: a stack trace`);
  if (format === "csv") {
    const rows = csvRows(r.stdout);
    assert.ok(rows.length >= 1, `${where}: a header, even with no rows`);
    assert.ok(rows[0].every(Boolean), `${where}: every column is named: ${rows[0]}`);
    for (const row of rows) assert.equal(row.length, rows[0].length, `${where}: one shape: ${row}`);
    assert.doesNotMatch(r.stdout, /^\|/m, `${where}: Markdown in a CSV`);
    assert.doesNotMatch(r.stdout, /—/, `${where}: a placeholder where a value is missing`);
  } else if (format === "json") {
    assert.equal(r.stderr, "", `${where}: everything is in the envelope, so 2>&1 is safe`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true, where);
    assert.equal(body.command, where.split(" ")[0], where);
    assert.equal(typeof body.complete, "boolean", where);
    assert.equal(typeof body.truncated, "boolean", where);
    assert.ok(Array.isArray(body.notes), where);
    assert.ok(body.cachedAt === null || !Number.isNaN(Date.parse(body.cachedAt)), where);
    const tables = [...(body.columns ? [body] : []), ...Object.values(body.tables || {})];
    assert.ok(tables.length || body.data, `${where}: an answer`);
    for (const t of tables) {
      assert.ok(t.columns.every(c => c.name && c.type), where);
      for (const row of t.rows) assert.equal(row.length, t.columns.length, where);
      assert.ok(t.total >= t.rows.length, where);
      assert.equal(typeof t.truncated, "boolean", where);
    }
  } else {
    assert.ok(r.stdout.trim(), `${where}: an answer`);
  }
}

function checkFailure(r, format, code, where) {
  assert.equal(r.code, code, `${where}: ${r.stderr}${r.stdout}`);
  assert.doesNotMatch(r.stderr, /^\s+at /m, `${where}: a stack trace`);
  if (format === "json") {
    assert.equal(r.stderr, "", where);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false, where);
    assert.equal(body.error.code, exitName(code), where);
    assert.ok(body.error.message, where);
    assert.ok(Array.isArray(body.notes), where);
    assert.equal(!!body.error.retry, code === EXIT.NOT_CACHED, `${where}: not cached says what to retry, and only that`);
  } else {
    assert.equal(r.stdout, "", `${where}: nothing on stdout that could be taken for an answer`);
    assert.ok(r.stderr.trim(), `${where}: says why`);
  }
}

test("every command, every format: an answer holds its shape, and nothing is fetched", async () => {
  const { agent, calls, close } = await richAgent({ engine: fakeEngine(), exportApp: async () => "Published to Fabric: x" });
  try {
    await withAgent(agent, async ({ cli }) => {
      for (const argv of ANSWERED) for (const [format, flag] of Object.entries(FORMATS)) {
        if (!takes(argv, format)) continue;
        checkAnswer(await cli([...argv, ...flag]), format, `${argv.join(" ")} ${format}`);
      }
    });
    assert.deepEqual(calls, [], "no OneLake or Fabric call without --fresh");
  } finally { await close(); }
});

test("every failure, every format: its own code, and no answer on stdout", async () => {
  const { agent, calls, close } = await richAgent({ engine: fakeEngine(), exportApp: async () => "x" });
  try {
    await withAgent(agent, async ({ cli }) => {
      for (const [argv, code] of NOT_ANSWERED) for (const [format, flag] of Object.entries(FORMATS)) {
        if (!takes(argv, format)) continue;
        checkFailure(await cli([...argv, ...flag]), format, code, `${argv.join(" ")} ${format}`);
      }
    });
    assert.deepEqual(calls, [], "no OneLake or Fabric call without --fresh");
  } finally { await close(); }
});

test("a listing's order is the same whatever order the workspaces answer in", async () => {
  const a = await richAgent({ engine: fakeEngine(), exportApp: async () => "x" });
  const b = await richAgent({ engine: fakeEngine(), exportApp: async () => "x", reverse: true });
  try {
    await withAgent(a.agent, ({ cli: one }) => withAgent(b.agent, async ({ cli: other }) => {
      for (const argv of [...ANSWERED, ["ls", "ws"]]) for (const [format, flag] of Object.entries(FORMATS)) {
        if (!takes(argv, format)) continue;
        const [x, y] = [await one([...argv, ...flag]), await other([...argv, ...flag])];
        assert.equal(x.stdout, y.stdout, `${argv.join(" ")} ${format}`);
      }
    }));
  } finally { await a.close(); await b.close(); }
});

test("--csv and --json carry raw values; Markdown reads well", async () => {
  const { agent, close } = await richAgent();
  try {
    await withAgent(agent, async ({ cli }) => {
      let r = await cli(["ls", "ws", "data", "--csv"]);
      assert.deepEqual(csvRows(r.stdout), [
        ["table", "sql_name", "rows", "bytes", "files", "last_write"],
        ["customers", "lakehouse.ws.data.dbo.customers", "1200", "2500000", "3", "2026-10-01T08:30:00.000Z"],
        ["orders", "lakehouse.ws.data.dbo.orders", "", "", "", ""],
      ]);

      r = await cli(["ls", "ws", "data", "--json"]);
      const body = JSON.parse(r.stdout);
      assert.deepEqual(body.rows, [
        ["customers", "lakehouse.ws.data.dbo.customers", 1200, 2500000, 3, "2026-10-01T08:30:00.000Z"],
        ["orders", "lakehouse.ws.data.dbo.orders", null, null, null, null],
      ]);
      assert.deepEqual(body.columns.map(c => c.type), ["text", "text", "integer", "integer", "integer", "timestamp"]);
      assert.equal(body.complete, true);
      assert.match(body.cachedAt, /^\d{4}-\d\d-\d\dT/);

      r = await cli(["ls", "ws", "data"]);
      assert.match(r.stdout, /\| customers \| lakehouse\.ws\.data\.dbo\.customers \| 1,200 \| 2\.5 MB \| 3 \| 2026-10-01 08:30 \|/);
      assert.match(r.stdout, /\| orders \| lakehouse\.ws\.data\.dbo\.orders \| — \| — \| — \| — \|/);

      r = await cli(["models", "ws", "--csv"]);
      assert.deepEqual(csvRows(r.stdout), [
        ["workspace", "semantic_model", "downloaded", "staging", "tables", "measures", "description"],
        ["ws", "Ops", "false", "false", "", "", ""],
        ["ws", "Sales", "true", "false", "2", "2", ""],
      ]);

      r = await cli(["models", "--downloaded", "--csv"]);
      assert.deepEqual(csvRows(r.stdout), [
        ["workspace", "semantic_model", "downloaded", "staging", "tables", "measures", "description"],
        ["ws", "Sales", "true", "false", "2", "2", ""],
      ], "the same columns, and only what is on this machine");
      r = await cli(["models", "--downloaded"]);
      assert.match(r.stdout, /1 downloaded semantic model\(s\) in 1 workspace\(s\)/);

      r = await cli(["files", "ws", "data", "Files/raw", "--csv"]);
      assert.deepEqual(csvRows(r.stdout), [["name", "type", "bytes"], ["2026", "folder", ""], ["a.parquet", "file", "1000000"]]);

      r = await cli(["files", "ws", "data", "Files/empty", "--csv"]);
      assert.deepEqual(csvRows(r.stdout), [["name", "type", "bytes"]], "empty is the header, not a sentence");

      r = await cli(["table", "ws", "data", "customers", "--csv"]);
      assert.deepEqual(csvRows(r.stdout), [["column", "type"], ["customer_id", "long"]]);

      r = await cli(["table", "ws", "data", "customers", "--json"]);
      const t = JSON.parse(r.stdout);
      assert.equal(t.data.rows, 1200);
      assert.equal(t.data.bytes, 2500000);
      assert.equal(t.data.lastWrite, "2026-10-01T08:30:00.000Z");
      assert.deepEqual(t.rows, [["customer_id", "long"]]);
    });
  } finally { await close(); }
});

test("ls <ws> is two tables: --json names them, --csv says it cannot", async () => {
  const { agent, close } = await richAgent();
  try {
    await withAgent(agent, async ({ cli }) => {
      let r = await cli(["ls", "ws", "--json"]);
      const { tables } = JSON.parse(r.stdout);
      assert.deepEqual(tables.items.rows, [["data.Lakehouse", "Lakehouse"], ["dw.Warehouse", "Warehouse"]]);
      assert.deepEqual(tables.models.rows, [["Ops", false, ""], ["Sales", true, ""]]);

      r = await cli(["ls", "ws", "--csv"]);
      assert.equal(r.code, EXIT.USAGE);
      assert.match(r.stderr, /items ws --csv, models ws --csv/);
    });
  } finally { await close(); }
});

test("more rows than shown is always said, and --csv prints all unless told otherwise", async () => {
  const { agent, close } = await richAgent({ tables: 150 });
  try {
    await withAgent(agent, async ({ cli }) => {
      let r = await cli(["ls", "ws", "data"]);
      assert.equal(r.stdout.match(/^\| t\d+ /gm).length, 98, "customers, orders and 98 more");
      assert.match(r.stdout, /first 100 of 152 shown/);

      r = await cli(["ls", "ws", "data", "--limit", "5", "--json"]);
      let body = JSON.parse(r.stdout);
      assert.equal(body.rows.length, 5);
      assert.equal(body.total, 152);
      assert.equal(body.truncated, true);

      r = await cli(["ls", "ws", "data", "--json"]);
      body = JSON.parse(r.stdout);
      assert.equal(body.rows.length, 100);
      assert.equal(body.truncated, true);

      r = await cli(["ls", "ws", "data", "--csv"]);
      assert.equal(csvRows(r.stdout).length, 153, "the header and every row");

      r = await cli(["ls", "ws", "data", "--csv", "--limit", "5"]);
      assert.equal(csvRows(r.stdout).length, 6);
      assert.match(r.stderr, /first 5 of 152/);

      r = await cli(["ls", "ws", "data", "--json", "--limit", "1000"]);
      assert.equal(JSON.parse(r.stdout).truncated, false);
    });
  } finally { await close(); }
});

test("a query past what the engine keeps: --csv fails rather than leave rows out", async () => {
  const rows = [{ a: 1, b: "x" }, { a: 2, b: "y" }, { a: 3, b: "z" }];
  const { agent, close } = await richAgent({ engine: fakeEngine(rows, 1000) });
  try {
    await withAgent(agent, async ({ cli }) => {
      let r = await cli(["sql", "SELECT 1", "--csv"]);
      assert.equal(r.code, EXIT.FAILED);
      assert.equal(r.stdout, "", "no partial CSV to parse");
      assert.match(r.stderr, /1,000 rows.*keeps 3.*--limit/);

      r = await cli(["sql", "SELECT 1", "--csv", "--limit", "9"]);
      assert.equal(r.code, EXIT.FAILED, "9 of 1,000 is more than came back");

      r = await cli(["sql", "SELECT 1", "--csv", "--limit", "2"]);
      assert.equal(r.code, EXIT.OK, r.stderr);
      assert.equal(csvRows(r.stdout).length, 3);
      assert.match(r.stderr, /first 2 of 1000/);

      r = await cli(["sql", "SELECT 1", "--json"]);
      assert.equal(r.code, EXIT.OK);
      const body = JSON.parse(r.stdout);
      assert.equal(body.total, 1000);
      assert.equal(body.rows.length, 3);
      assert.equal(body.truncated, true);

      r = await cli(["sql", "SELECT 1"]);
      assert.match(r.stdout, /1,000 row\(s\), first 3 shown/);
    });
  } finally { await close(); }
});

test("a sweep that misses workspaces still answers, complete: false; a named one fails", async () => {
  const onelake = fakeOneLake();
  const agent = createAgent({ onelake, modelPath: () => "/nowhere/x.yaml", appDir: APP_DIR });
  await withAgent(agent, async ({ cli }) => {
    let r = await cli(["models", "--json"]);
    assert.equal(r.code, EXIT.OK);
    let body = JSON.parse(r.stdout);
    assert.equal(body.complete, false);
    assert.equal(body.total, 3);
    assert.match(body.notes.join("\n"), /not cached yet, so not counted: unseen/);

    r = await cli(["models", "--csv"]);
    assert.equal(r.code, EXIT.OK);
    assert.match(r.stderr, /not counted: unseen/, "a CSV has nowhere else to say so");

    for (const argv of [["models", "unseen"], ["items", "unseen"]]) {
      r = await cli(argv);
      assert.equal(r.code, EXIT.NOT_CACHED, argv.join(" "));
      assert.doesNotMatch(r.stdout, /No semantic models|No lakehouses/, "never an empty answer for a question not asked of anyone");
    }

    r = await cli(["ls", "a ws", "--json"]);
    body = JSON.parse(r.stdout);
    assert.equal(body.complete, true);
  });

  // --fresh, with one workspace refusing: a named one is the answer, a sweep a note.
  const bad = fakeOneLake();
  bad.workspaces = async () => ["ok", "broken"];
  bad.models = async w => { if (w === "broken") throw Object.assign(new Error("Unauthorized"), { status: 401 }); return []; };
  bad.items = async w => { if (w === "broken") throw Object.assign(new Error("Server Error"), { status: 500 }); return []; };
  const fresh = createAgent({ onelake: bad, modelPath: () => "/nowhere/x.yaml", appDir: APP_DIR });
  await withAgent(fresh, async ({ cli }) => {
    let r = await cli(["models", "--fresh", "--json"]);
    assert.equal(r.code, EXIT.OK);
    assert.equal(JSON.parse(r.stdout).complete, false);
    r = await cli(["models", "broken", "--fresh"]);
    assert.equal(r.code, EXIT.UNAVAILABLE, "a 401 is for the user to fix");
    assert.match(r.stderr, /sign in to Fabric/);
    r = await cli(["items", "broken", "--fresh"]);
    assert.equal(r.code, EXIT.FAILED);
    assert.match(r.stderr, /Server Error/);
  });
});

test("find says what it could not search", async () => {
  const onelake = fakeOneLake();
  const agent = createAgent({ onelake, modelPath: () => "/nowhere/x.yaml", appDir: APP_DIR });
  await withAgent(agent, async ({ cli }) => {
    const body = JSON.parse((await cli(["find", "sales", "--json"])).stdout);
    assert.equal(body.complete, false);
    assert.deepEqual(body.rows.map(r => r[2]), ["Sales"]);
    assert.match(body.notes.join("\n"), /not searched.*add --fresh to read them now/);
  });
  const none = createAgent({ onelake: { cached: { workspaces: async () => null } }, modelPath: () => "", appDir: APP_DIR });
  await withAgent(none, async ({ cli }) => {
    const r = await cli(["find", "x", "--json"]);
    assert.equal(r.code, EXIT.NOT_CACHED);
    const { error } = JSON.parse(r.stdout);
    assert.equal(error.retry, "ls --fresh", "no workspace listing: that comes first");
    assert.doesNotMatch(error.message, /add --fresh/);
  });
});

// A cache that fills as OneLake answers, the way the real one does.
function fillingOneLake({ brokenItem = null } = {}) {
  const kept = new Map([["workspaces", ["ws"]], ["items ws", [{ name: "known.Lakehouse", kind: "Lakehouse" }, { name: "new.Lakehouse", kind: "Lakehouse" }]],
                        ["tables known.Lakehouse", [{ schema: "dbo", table: "known_duid" }]]]);
  const calls = [];
  const hit = k => (kept.has(k) ? { value: kept.get(k), at: Date.now() - 180_000 } : null);
  const read = (k, value) => { calls.push(k); kept.set(k, value); return value; };
  return {
    calls,
    workspaces: async () => read("workspaces", ["ws"]),
    items: async w => read(`items ${w}`, kept.get(`items ${w}`)),
    models: async w => read(`models ${w}`, [{ name: "Duid model", description: "" }]),
    tables: async lh => {
      if (lh.item === brokenItem) throw new Error("Server Error");
      return read(`tables ${lh.item}`, [{ schema: "dbo", table: lh.item === "new.Lakehouse" ? "new_duid" : "known_duid" }]);
    },
    cached: {
      workspaces: async () => hit("workspaces"),
      items: async w => hit(`items ${w}`),
      models: async w => hit(`models ${w}`),
      tables: async lh => hit(`tables ${lh.item}`),
      table: async () => ({ value: { schemaFields: [] }, at: Date.now() }),
    },
  };
}

test("find follows its own advice: --fresh reads what the cache lacks, then searches it", async () => {
  const onelake = fillingOneLake();
  const agent = createAgent({ onelake, modelPath: () => "/nowhere/x.yaml", appDir: APP_DIR });
  await withAgent(agent, async ({ cli }) => {
    let body = JSON.parse((await cli(["find", "duid", "--json"])).stdout);
    assert.equal(body.complete, false);
    assert.deepEqual(body.rows.map(r => r[2]), ["dbo.known_duid"]);
    assert.match(body.notes.join("\n"), /--fresh reads OneLake\/Fabric again/);
    assert.deepEqual(onelake.calls, [], "nothing fetched unasked");

    const r = await cli(["find", "duid", "--fresh", "--json"]);
    assert.equal(r.code, EXIT.OK, r.stdout);
    body = JSON.parse(r.stdout);
    assert.equal(body.complete, true, body.notes.join("\n"));
    assert.deepEqual(body.rows.map(x => x[2]).sort(), ["Duid model", "dbo.known_duid", "dbo.new_duid"]);
    assert.deepEqual(body.notes, [], "from OneLake: no \"as of\", and nothing left out");
    assert.equal(body.cachedAt, null);
    assert.ok(onelake.calls.includes("tables new.Lakehouse"), onelake.calls.join("\n"));
  });
});

test("find --fresh: a listing that fails is counted, and the rest are still searched", async () => {
  const onelake = fillingOneLake({ brokenItem: "new.Lakehouse" });
  const agent = createAgent({ onelake, modelPath: () => "/nowhere/x.yaml", appDir: APP_DIR });
  await withAgent(agent, async ({ cli }) => {
    const r = await cli(["find", "duid", "--fresh", "--json"]);
    assert.equal(r.code, EXIT.OK, r.stdout);
    const body = JSON.parse(r.stdout);
    assert.equal(body.complete, false);
    assert.deepEqual(body.rows.map(x => x[2]).sort(), ["Duid model", "dbo.known_duid"]);
    const notes = body.notes.join("\n");
    assert.match(notes, /1 listing\(s\) could not be read\. The first: ws\/new\.Lakehouse's tables: Server Error/);
    assert.match(notes, /not searched, not cached yet: the tables of 1 item\(s\)/);
    assert.doesNotMatch(notes, /add --fresh/, "it was added");
  });
});

test("find says which tables it searched by name only", async () => {
  const { agent, close } = await richAgent();
  try {
    await withAgent(agent, async ({ cli }) => {
      const body = JSON.parse((await cli(["find", "customer_id", "--json"])).stdout);
      assert.equal(body.complete, false);
      assert.match(body.notes.join("\n"), /searched by name only, their columns not read yet: 1 table\(s\)/);
    });
  } finally { await close(); }
});

test("sql keeps NULL and an empty string apart in Markdown and CSV", async () => {
  const { agent, close } = await richAgent({ engine: fakeEngine([{ a: null, b: "" }]) });
  try {
    await withAgent(agent, async ({ cli }) => {
      let r = await cli(["sql", "SELECT 1"]);
      assert.match(r.stdout, /^\| NULL \|  \|$/m);
      r = await cli(["sql", "SELECT 1", "--csv"]);
      assert.equal(r.stdout, 'a,b\n,""\n');
      r = await cli(["sql", "SELECT 1", "--json"]);
      assert.deepEqual(JSON.parse(r.stdout).rows, [[null, ""]]);
    });
  } finally { await close(); }
});

test("SHOW ALL TABLES: Markdown counts each table's columns, --csv and --json have them", async () => {
  const asked = [];
  const engine = { agentQuery: async sql => {
    asked.push(sql);
    return { fields: [{ name: "name", type: "VARCHAR" }], rows: [{ name: "t" }], numRows: 1 };
  } };
  const { agent, close } = await richAgent({ engine });
  try {
    await withAgent(agent, async ({ cli }) => {
      let r = await cli(["sql", "show all tables;"]);
      assert.equal(asked.pop(), ALL_TABLES_COUNTED);
      assert.match(r.stdout, /column names and types: --json, --csv/);

      for (const format of ["--json", "--csv"]) {
        r = await cli(["sql", "SHOW ALL TABLES", format]);
        assert.equal(asked.pop(), "SHOW ALL TABLES", format);
        assert.doesNotMatch(r.stdout, /column names and types/, format);
      }

      r = await cli(["sql", "SELECT * FROM (SHOW ALL TABLES)"]);
      assert.equal(asked.pop(), "SELECT * FROM (SHOW ALL TABLES)", "a query of it asked for what it asked for");
    });
  } finally { await close(); }
});

test("models and items mark what a dataflow made for its staging", async () => {
  const at = Date.now();
  const list = value => ({ value, at });
  const onelake = {
    cached: {
      workspaces: async () => list(["ws"]),
      items: async () => list(["data.Lakehouse", "DataflowsStagingLakehouse.Lakehouse", "StagingLakehouseForDataflows_20261001.Lakehouse",
                               "StagingWarehouseForDataflows_20261001.Warehouse"]
        .map(name => ({ name, kind: name.endsWith("Warehouse") ? "Warehouse" : "Lakehouse" }))),
      models: async () => list([{ name: "Sales", description: "" }, { name: "DataflowsStagingWarehouse", description: "" }]),
    },
  };
  const agent = createAgent({ onelake, modelPath: () => "/nowhere/x.yaml", appDir: APP_DIR });
  await withAgent(agent, async ({ cli }) => {
    let r = JSON.parse((await cli(["models", "--json"])).stdout);
    const models = r.columns.findIndex(c => c.name === "staging");
    assert.equal(r.columns[models].type, "boolean");
    assert.deepEqual(r.rows.map(x => [x[1], x[models]]), [["DataflowsStagingWarehouse", true], ["Sales", false]]);

    r = JSON.parse((await cli(["items", "--json"])).stdout);
    const items = r.columns.findIndex(c => c.name === "staging");
    assert.deepEqual(r.rows.map(x => [x[1], x[items]]), [
      ["DataflowsStagingLakehouse.Lakehouse", true], ["StagingLakehouseForDataflows_20261001.Lakehouse", true],
      ["StagingWarehouseForDataflows_20261001.Warehouse", true], ["data.Lakehouse", false],
    ]);

    const { stdout } = await cli(["models"]);
    assert.match(stdout, /\| DataflowsStagingWarehouse \|  \| staging \|/);
  });
});

test("export: published, declined, failed, each its own code", async () => {
  const declined = message => Object.assign(new Error(message), { declined: true });
  let answer;
  const { agent, close } = await richAgent({ exportApp: async () => answer() });
  try {
    await withAgent(agent, async ({ cli }) => {
      answer = async () => "Published to Fabric: https://x";
      let r = await cli(["export", "ws", "Sales", "--json"]);
      assert.equal(r.code, EXIT.OK);
      assert.equal(JSON.parse(r.stdout).data.message, "Published to Fabric: https://x");

      answer = async () => { throw declined("Export cancelled."); };
      r = await cli(["export", "ws", "Sales"]);
      assert.equal(r.code, EXIT.DECLINED, "a No never reads as a publish");
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /Export cancelled/);
      r = await cli(["export", "ws", "Sales", "--json"]);
      assert.equal(JSON.parse(r.stdout).error.code, "DECLINED");

      answer = async () => { throw new Error("the deploy failed"); };
      r = await cli(["export", "ws", "Sales"]);
      assert.equal(r.code, EXIT.FAILED);
    });
  } finally { await close(); }
});

test("names that would break a table: every format keeps the rows apart", async () => {
  const at = Date.now();
  const names = ["a|b", 'quo"te', "com,ma", "new\nline", "日本語"];
  const list = v => ({ value: v, at });
  const onelake = {
    cached: {
      workspaces: async () => list(names),
      items: async ws => list([{ name: `${ws}.Lakehouse`, kind: "Lakehouse" }]),
      models: async () => list([]),
    },
  };
  const agent = createAgent({ onelake, modelPath: () => "/nowhere/x.yaml", appDir: APP_DIR });
  await withAgent(agent, async ({ cli }) => {
    let r = await cli(["items", "--csv"]);
    const rows = csvRows(r.stdout);
    assert.deepEqual(rows.slice(1).map(x => x[0]).sort(), [...names].sort(), "round trips");

    r = await cli(["items", "--json"]);
    assert.deepEqual(JSON.parse(r.stdout).rows.map(x => x[0]).sort(), [...names].sort());

    r = await cli(["items"]);
    assert.equal(r.stdout.split("\n").filter(l => l.startsWith("|")).length, names.length + 2, "one line a row");
    assert.match(r.stdout, /a\\\|b/, "the pipe is escaped");
  });
});

test("a workspace or model name cannot walk out of the models folder", () => {
  for (const name of ["../../etc/passwd", "..\\..\\windows\\win.ini", "..", ".", "/abs", "C:\\abs", "a/../../b"]) {
    const file = modelFileName(name);
    assert.doesNotMatch(file, /[\\/]/, name);
    assert.ok(!file.startsWith("."), name);
  }
});
