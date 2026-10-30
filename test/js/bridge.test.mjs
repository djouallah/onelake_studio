// bridge.js: cli.mjs rings, the running extension answers. A real pipe/socket, a fake answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { serveBridge, askBridge } = require("../../src/bridge.js");

const path = process.platform === "win32"
  ? `\\\\.\\pipe\\onelake-studio-test-${process.pid}`
  : join(tmpdir(), `onelake-studio-test-${process.pid}.sock`);

test("a request crosses to the extension and its answer comes back", async () => {
  const seen = [];
  const bridge = serveBridge({ path, handle: async r => { seen.push(r); return { out: "| a |", err: "", code: 0 }; } });
  try {
    await new Promise(r => setTimeout(r, 100));
    const reply = await askBridge({ args: ["ls", "ws"], opts: { fresh: true } }, path);
    assert.deepEqual(reply, { out: "| a |", err: "", code: 0 });
    assert.deepEqual(seen, [{ args: ["ls", "ws"], opts: { fresh: true } }]);
  } finally { bridge.dispose(); }
});

test("with no extension listening, the command line says so", async () => {
  await assert.rejects(askBridge({ args: ["ls"] }, path + "-nobody"), e => e.code === "NO_EXTENSION");
});
