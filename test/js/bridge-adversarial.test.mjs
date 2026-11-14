// The command line's pipe, sent what the command line never sends: whatever arrives is checked without a throw,
// a line that is too long or never ends is hung up on, and on Linux and macOS a socket in a folder that is not
// this user's own is not used at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import net from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eachSeed } from "./fuzz.mjs";

const require = createRequire(import.meta.url);
const { serveBridge, askBridge, checkRequest, COMMANDS, MAX_REQUEST, bridgePath, socketFolder } = require("../../cli/bridge.js");

const WINDOWS = process.platform === "win32";
const pathFor = name => (WINDOWS ? `\\\\.\\pipe\\onelake-studio-adv-${process.pid}-${name}` : join(tmpdir(), `onelake-studio-adv-${process.pid}-${name}.sock`));
const sleep = ms => new Promise(r => setTimeout(r, ms));

test("a request that is anything at all is checked without a throw, and only a known command passes", () => {
  for (const request of [null, undefined, 0, "", "ls", [], {}, { args: null }, { args: "ls" }, { args: [] }, { args: [null] }, { args: [{}] },
                         { args: ["ls"], opts: null }, { args: ["ls"], opts: "json" }, { args: ["ls"], opts: 5 },
                         { args: ["__proto__"] }, { args: ["constructor"] }, { args: ["toString"] }, { args: ["hasOwnProperty", "x"] }]) {
    let said;
    assert.doesNotThrow(() => { said = checkRequest(request); }, JSON.stringify(request));
    if (!(request && Array.isArray(request.args) && request.args[0] === "ls")) assert.equal(typeof said, "string", `${JSON.stringify(request)} is no command`);
  }
  assert.equal(checkRequest({ args: ["ls"], opts: null }), null, "no options is no options");
  assert.match(checkRequest({ args: ["__proto__"] }), /unknown command/);
});

test("fuzz: no request passes the check unless its command, its arguments and its options are ones the command takes", () => {
  const names = [...Object.keys(COMMANDS), "__proto__", "constructor", "", "LS", "sql ", "drop"];
  const values = ["", "x", "ws", "a b", "-", "--json", 0, 1, -1, 1.5, "5", null, true, false, [], {}, "directlake", "DirectQuery", "nope"];
  const flags = ["fresh", "csv", "json", "limit", "showSql", "downloaded", "workspace", "name", "open", "mode", "__proto__", "other"];
  eachSeed(r => {
    const args = [r.pick(names), ...Array.from({ length: r.int(5) }, () => r.pick(values))];
    const opts = Object.fromEntries(Array.from({ length: r.int(4) }, () => [r.pick(flags), r.pick(values)]));
    let said;
    try { said = checkRequest({ args, opts }); }
    catch (e) { assert.fail(`checkRequest threw on ${JSON.stringify({ args, opts })}: ${e.stack}`); }
    assert.ok(said === null || typeof said === "string");
    if (said !== null) return;
    const c = COMMANDS[String(args[0])];
    assert.ok(c && Object.hasOwn(COMMANDS, String(args[0])), `${JSON.stringify(args)} passed with no such command`);
    const rest = args.slice(1).map(String);
    assert.ok(rest.length >= (c.min || 0) && rest.length <= c.max, `${JSON.stringify(args)} passed with ${rest.length} arguments`);
    assert.ok(!rest.includes(""), "an empty argument passed");
    for (const [k, v] of Object.entries(opts)) {
      if (v == null || v === false) continue;
      if (["fresh", "csv", "json", "limit", "showSql", "downloaded", "workspace", "name", "open", "mode"].includes(k)) {
        assert.ok(c.flags.includes(k), `${k} passed on ${args[0]}, which doesn't take it`);
      }
    }
    if (opts.limit != null) assert.ok(Number.isInteger(Number(opts.limit)) && Number(opts.limit) > 0, `--limit ${JSON.stringify(opts.limit)} passed`);
  }, 5000);
});

test("the pipe: a line that is not JSON is an answer, one too long or never finished is hung up on, and it goes on serving", async () => {
  const path = pathFor("lines");
  let handled = 0;
  const bridge = serveBridge({ path, handle: async r => { handled++; return { out: JSON.stringify(r), err: "", code: 0 } ; } });
  const raw = text => new Promise(resolve => {
    const sock = net.connect(path);
    let got = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => { for (const piece of [].concat(text)) sock.write(piece); });
    sock.on("data", c => { got += c; });
    sock.on("error", () => {});
    sock.on("close", () => resolve(got));
    setTimeout(() => sock.destroy(), 15_000);
  });
  try {
    await sleep(100);
    const bad = JSON.parse(await raw("this is not json\n"));
    assert.equal(bad.code, 1, "a failure, said");
    assert.match(bad.err, /^error: /);
    assert.equal(handled, 0);
    assert.equal(JSON.parse(await raw("null\n")).out, "null", "the handler is given what arrived, and decides");
    // Past the limit with no end of line: nothing comes back, and the connection is closed.
    const piece = "x".repeat(256 * 1024);
    assert.equal(await raw(Array(Math.ceil(MAX_REQUEST / piece.length) + 2).fill(piece)), "");
    // Still serving.
    assert.deepEqual(await askBridge({ args: ["ls"] }, path), { out: '{"args":["ls"]}', err: "", code: 0 });
  } finally { bridge.dispose(); }
});

test("the pipe: a client that goes away tells the handler, and a second server on the same name does not take it", async () => {
  const path = pathFor("gone");
  let aborted = false, release;
  const held = new Promise(r => { release = r; });
  const first = serveBridge({ path, handle: async (_r, { signal }) => { signal.addEventListener("abort", () => { aborted = true; release(); }); await held; return { out: "late", err: "", code: 0 }; } });
  const said = [];
  let second;
  try {
    await sleep(100);
    second = serveBridge({ path, log: m => said.push(m), handle: async () => ({ out: "the second", err: "", code: 0 }) });
    const sock = net.connect(path);
    await new Promise(r => sock.once("connect", r));
    sock.write(`${JSON.stringify({ args: ["sql", "SELECT 1"] })}\n`);
    await sleep(200);
    sock.destroy();
    await Promise.race([held, sleep(5000)]);
    assert.equal(aborted, true, "what it asked for is stopped");
    assert.ok(!said.some(m => /serving the command line/.test(m)), "the second waits its turn");
  } finally { first.dispose(); if (second) second.dispose(); }
});

test("on Linux and macOS the socket is in a folder of this user's own, and one that isn't is not used", { skip: WINDOWS && "a pipe is in no folder" }, async t => {
  const was = process.env.ONELAKE_STUDIO_BRIDGE;
  delete process.env.ONELAKE_STUDIO_BRIDGE;
  t.after(() => { if (was !== undefined) process.env.ONELAKE_STUDIO_BRIDGE = was; });
  const own = bridgePath();
  assert.notEqual(dirname(own), tmpdir(), "not in the temp folder itself, which everyone writes to");
  assert.equal(dirname(dirname(own)), tmpdir());

  const base = mkdtempSync(join(tmpdir(), "bridge-folder-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  // Not there yet: made closed to everyone else by the server, and nothing to object to for a client.
  const fresh = join(base, "fresh", "bridge.sock");
  assert.equal(socketFolder(fresh), null, "a client finds no socket, which is its own error to say");
  assert.equal(socketFolder(fresh, { make: true }), null);
  assert.equal(statSync(dirname(fresh)).mode & 0o777, 0o700);
  // One somebody left open: a client refuses it, and the server closes it before it listens there.
  const open = join(base, "open", "bridge.sock");
  mkdirSync(dirname(open), { mode: 0o755 });
  chmodSync(dirname(open), 0o777);
  assert.match(socketFolder(open), /is open to other users/);
  await assert.rejects(askBridge({ args: ["ls"] }, open), e => e.code === "NO_EXTENSION" && /not safe to use/.test(e.message));
  assert.equal(socketFolder(open, { make: true }), null);
  assert.equal(statSync(dirname(open)).mode & 0o777, 0o700);
  // A file where the folder should be.
  const file = join(base, "file", "bridge.sock");
  writeFileSync(dirname(file), "not a folder");
  assert.match(socketFolder(file), /is not a folder/);
  assert.match(socketFolder(file, { make: true }), /is not a folder/);
});
