// bin/cli.mjs, the process: what an agent's shell sees. Nothing here calls agent.run itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import net from "node:net";
import { run, withBridge, withAgent, bridgeName } from "./cli-harness.mjs";
import { richAgent } from "./agent-fixtures.mjs";

const require = createRequire(import.meta.url);
const { EXIT, MAX_REQUEST } = require("../../src/bridge.js");

const NOBODY = { path: bridgeName() };   // no extension listening

test("help and version need no VS Code, and exit 0", async () => {
  for (const argv of [[], ["help"], ["--help"], ["-h"]]) {
    const r = await run(argv, NOBODY);
    assert.equal(r.code, 0, argv.join(" "));
    assert.match(r.stdout, /ls <ws> <item>/);
    assert.match(r.stdout, /exit codes:/);
    assert.equal(r.stderr, "");
  }
  for (const argv of [["ls", "--help"], ["help", "ls"]]) {
    const r = await run(argv, NOBODY);
    assert.equal(r.code, 0, argv.join(" "));
    assert.match(r.stdout, /ls <ws> <item>/);
    assert.doesNotMatch(r.stdout, /export <ws>/, "that command's lines, not all of them");
  }
  let r = await run(["--version"], NOBODY);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^onelake-studio \d+\.\d+\.\d+\n$/);
  r = await run(["--version", "--json"], NOBODY);
  assert.equal(JSON.parse(r.stdout).ok, true);
});

// A wrong call is known before anything is sent: exit 2, whether or not VS Code is open.
const WRONG = [
  [["nosuch"], /unknown command: nosuch/],
  [["__proto__"], /unknown command/],
  [["constructor"], /unknown command/],
  [["--nosuch"], /unknown option: --nosuch/],
  [["-x"], /unknown option: -x/],
  [["ls", "--json-ish"], /unknown option/],
  [["ls", "--limit"], /--limit needs a value/],
  [["ls", "--limit", "abc"], /--limit takes a positive whole number/],
  [["ls", "--limit", "0"], /--limit takes/],
  [["ls", "--limit", "-1"], /--limit takes/],
  [["ls", "--limit", "1.5"], /--limit takes/],
  [["ls", "--timeout", "soon"], /--timeout takes seconds/],
  [["ls", "--timeout"], /--timeout needs a value/],
  [["ls", "a", "b", "c"], /usage: ls/],
  [["ls", ""], /usage: ls/],
  [["models", "a", "b"], /usage: models/],
  [["files", "a"], /usage: files/],
  [["find"], /usage: find/],
  [["table", "a", "b"], /usage: table/],
  [["model", "a"], /usage: model/],
  [["sql"], /usage: sql/],
  [["sql", "SELECT", "AGG(Archive", "Files)"], /sql got 3 arguments, so the shell split the query\. Send it on stdin: sql -/],
  [["sql", "SELECT 1", "--in", "noslash"], /--in takes <ws>\/<item>/],
  [["sql", "SELECT 1", "--in", "a/b/c"], /--in takes <ws>\/<item>/],
  [["sql", "SELECT 1", "--fresh"], /--fresh is not an option of sql/],
  [["ls", "--downloaded"], /--downloaded is not an option of ls/],
  [["model", "a", "b", "--csv"], /--csv is not an option of model/],
  [["export", "a"], /usage: export/],
  [["export", "a", "b", "--csv"], /--csv is not an option of export/],
];
test("a wrong call exits 2, says why on stderr, and sends nothing", async () => {
  for (const [argv, why] of WRONG) {
    const r = await run(argv, NOBODY);
    const where = JSON.stringify(argv);
    assert.equal(r.code, EXIT.USAGE, `${where}: ${r.stderr}`);
    assert.equal(r.stdout, "", where);
    assert.match(r.stderr, why, where);
    assert.doesNotMatch(r.stderr, /^\s+at /m, `${where}: a stack trace`);
  }
});

test("a wrong call under --json is the failure envelope, with stderr empty", async () => {
  const r = await run(["nosuch", "--json"], NOBODY);
  assert.equal(r.code, EXIT.USAGE);
  assert.equal(r.stderr, "");
  const body = JSON.parse(r.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "USAGE");

  const both = await run(["ls", "--csv", "--json"], NOBODY);
  assert.equal(both.code, EXIT.USAGE);
  assert.match(JSON.parse(both.stdout).error.message, /--csv or --json, not both/);
});

test("what looks like an option but is not one reaches the command", async () => {
  const seen = [];
  await withBridge(async req => { seen.push(req); return { out: "ok", err: "", code: 0 }; }, async ({ cli }) => {
    for (const argv of [["sql", "-- why\nSELECT 1"], ["sql", "--", "--nosuch"], ["find", "--", "-x"], ["sql", "-1"]]) {
      const r = await cli(argv);
      assert.equal(r.code, 0, `${JSON.stringify(argv)}: ${r.stderr}`);
    }
  });
  assert.deepEqual(seen.map(s => s.args), [["sql", "-- why\nSELECT 1"], ["sql", "--nosuch"], ["find", "-x"], ["sql", "-1"]]);
  assert.ok(seen.every(s => !("timeout" in s.opts)), "--timeout is the client's own");
});

test("arguments cross intact: spaces, quotes, pipes, newlines, other alphabets", async () => {
  const names = ["my ws", `it's "quoted"`, "a|b", "line\nbreak", "données été 日本語", "tab\there", "$HOME %PATH%", "back\\slash"];
  const seen = [];
  await withBridge(async req => { seen.push(req.args[1]); return { out: req.args[1], err: "", code: 0 }; }, async ({ cli }) => {
    for (const name of names) {
      const r = await cli(["find", name]);
      assert.equal(r.stdout, `${name}\n`, "and back, as UTF-8");
    }
  });
  assert.deepEqual(seen, names);
});

test("the answer's code is the process's code, stdout and stderr kept apart", async () => {
  await withBridge(async () => ({ out: "the answer", err: "a note", code: EXIT.NOT_CACHED }), async ({ cli }) => {
    const r = await cli(["ls"]);
    assert.equal(r.code, EXIT.NOT_CACHED);
    assert.equal(r.stdout, "the answer\n");
    assert.equal(r.stderr, "a note\n");
  });
});

test("no extension listening: exit 3, on stderr, or in the envelope", async () => {
  let r = await run(["ls"], NOBODY);
  assert.equal(r.code, EXIT.UNAVAILABLE);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /not running/);
  r = await run(["ls", "--json"], NOBODY);
  assert.equal(r.code, EXIT.UNAVAILABLE);
  assert.equal(r.stderr, "");
  assert.equal(JSON.parse(r.stdout).error.code, "UNAVAILABLE");
});

test("not signed in: exit 3, and a wrong call still says it is wrong", async () => {
  const { agent, close } = await richAgent({ signedIn: () => false });
  try {
    await withAgent(agent, async ({ cli }) => {
      let r = await cli(["ls"]);
      assert.equal(r.code, EXIT.UNAVAILABLE);
      assert.match(r.stderr, /not signed in/);
      r = await cli(["ls", "--json"]);
      assert.equal(JSON.parse(r.stdout).error.code, "UNAVAILABLE");
    });
  } finally { await close(); }
});

// A server that does what a dying extension does, on the real pipe.
async function withServer(onLine, fn) {
  const path = bridgeName();
  const server = net.createServer(sock => {
    sock.on("error", () => {});
    sock.once("data", () => onLine(sock));
  });
  await new Promise(resolve => server.listen(path, resolve));
  try { return await fn(argv => run(argv, { path, limitMs: 30_000 })); }
  finally { server.close(); }
}

test("an extension that goes away mid-answer: exit 3, never a hang", async () => {
  const cases = [
    ["closes", sock => sock.end()],
    ["half an answer", sock => sock.end('{"out":"the ans')],
    ["garbage", sock => sock.end("not json\n")],
    ["reset", sock => sock.destroy()],
  ];
  for (const [what, onLine] of cases) {
    await withServer(onLine, async cli => {
      const r = await cli(["ls"]);
      assert.equal(r.code, EXIT.UNAVAILABLE, `${what}: ${r.stderr}`);
      assert.equal(r.stdout, "", what);
      assert.doesNotMatch(r.stderr, /^\s+at /m, what);
    });
  }
});

test("a reply that cannot be serialised is a failure, not a client left waiting", async () => {
  await withBridge(async () => ({ out: 1n, err: "", code: 0 }), async ({ cli }) => {
    const r = await cli(["ls"], { limitMs: 30_000 });
    assert.equal(r.code, EXIT.FAILED);
    assert.match(r.stderr, /error:/);
  });
});

test("a handler that throws is a failure with its message", async () => {
  await withBridge(async () => { throw new Error("boom"); }, async ({ cli }) => {
    const r = await cli(["ls"]);
    assert.equal(r.code, EXIT.FAILED);
    assert.match(r.stderr, /boom/);
  });
});

test("--timeout: exit 6 and the query is told to stop; 0 waits", async () => {
  let stopped;
  const told = new Promise(resolve => { stopped = resolve; });
  await withBridge(async (req, { signal }) => {
    if (req.args[1] === "quick") return { out: "done", err: "", code: 0 };
    signal.addEventListener("abort", () => stopped("aborted"));
    return new Promise(() => {});
  }, async ({ cli }) => {
    let r = await cli(["find", "slow", "--timeout", "0.2"]);
    assert.equal(r.code, EXIT.TIMEOUT, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /no answer in 0\.2s/);
    assert.equal(await told, "aborted");
    r = await cli(["find", "quick", "--timeout", "0"]);
    assert.equal(r.code, 0);
    r = await cli(["find", "slow", "--timeout", "0.2", "--json"]);
    assert.equal(r.code, EXIT.TIMEOUT);
    assert.equal(JSON.parse(r.stdout).error.code, "TIMEOUT");
  });
});

test("a command line that is killed: its query is told to stop", async () => {
  let aborted, started;
  const stop = new Promise(resolve => { aborted = resolve; });
  const begun = new Promise(resolve => { started = resolve; });
  await withBridge(async (req, { signal }) => {
    signal.addEventListener("abort", () => aborted(true));
    started();
    return new Promise(() => {});
  }, async ({ cli }) => {
    let child;
    const done = cli(["find", "slow"], { onSpawn: c => { child = c; } });
    await begun;
    child.kill();
    await done;
    assert.equal(await stop, true);
  });
});

test("sql - reads stdin: quotes survive, nothing on it is a wrong call, a stuck one times out", async () => {
  const sql = `SELECT d."a b", AGG("Total Sales") AS 'x'\nFROM t -- it's a comment\nGROUP BY ALL`;
  const seen = [];
  await withBridge(async req => { seen.push(req.args); return { out: "ok", err: "", code: 0 }; }, async ({ cli }) => {
    let r = await cli(["sql", "-"], { stdin: sql });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(seen.pop(), ["sql", sql]);

    r = await cli(["sql", "-"], { stdin: "  \n" });
    assert.equal(r.code, EXIT.USAGE);
    assert.match(r.stderr, /nothing on stdin/);

    r = await cli(["sql", "-", "--timeout", "0.2"], { keepStdin: true });
    assert.equal(r.code, EXIT.TIMEOUT, r.stderr);
    assert.equal(seen.length, 0, "nothing was asked");
  });
});

test("a request too long to send is a wrong call, said here rather than dropped by the pipe", async () => {
  const r = await run(["sql", "-"], { ...NOBODY, stdin: "x".repeat(MAX_REQUEST) });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.stderr, /too long/);
});

test("a very long answer arrives whole through a pipe", async () => {
  const row = `${"é".repeat(99)}\n`;
  const body = row.repeat(256 * 1024).trimEnd();   // about 50 MB of UTF-8
  await withBridge(async () => ({ out: body, err: "", code: 0 }), async ({ cli }) => {
    const r = await cli(["ls"], { limitMs: 120_000 });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.length, body.length + 1);
    assert.ok(r.stdout === `${body}\n`, "byte for byte");
  });
});

test("a reader that stops reading is not a failure", async () => {
  const body = "x".repeat(4 * 1024 * 1024);
  await withBridge(async () => ({ out: body, err: "", code: 0 }), async ({ cli }) => {
    const r = await cli(["ls"], { closeStdout: true });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /EPIPE|^\s+at /m);
  });
});

test("export says on stderr that it waits, and no timeout cuts a person's answer short", async () => {
  const { agent, close } = await richAgent({ exportApp: async () => { await new Promise(r => setTimeout(r, 300)); return "Published to Fabric: x"; } });
  try {
    await withAgent(agent, async ({ cli }) => {
      const r = await cli(["export", "ws", "Sales"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /confirm it in VS Code/);
      assert.equal(r.stdout, "Published to Fabric: x\n");
    });
  } finally { await close(); }
});
