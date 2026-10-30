// The command line as an agent meets it: the real bin/cli.mjs in a process of its own, its real
// exit code and its two real streams, over a real pipe to a bridge served here.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { serveBridge } = require("../../src/bridge.js");

export const CLI = fileURLToPath(new URL("../../bin/cli.mjs", import.meta.url));

let seq = 0;
export const bridgeName = () => (process.platform === "win32"
  ? `\\\\.\\pipe\\onelake-cli-test-${process.pid}-${seq++}`
  : join(tmpdir(), `onelake-cli-test-${process.pid}-${seq++}.sock`));

// Asynchronous, always: the bridge is served by this very process, so spawnSync would wait for
// a child that is waiting for us.
export function run(argv, { path = bridgeName(), stdin = "", keepStdin = false, closeStdout = false,
                            onSpawn = null, limitMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", CLI, ...argv], {
      env: { ...process.env, ONELAKE_STUDIO_BRIDGE: path }, stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [], err = [];
    child.stdout.on("data", c => out.push(c));
    child.stderr.on("data", c => err.push(c));
    child.stdout.on("error", () => {});
    child.stdin.on("error", () => {});
    if (closeStdout) child.stdout.destroy();
    if (!keepStdin) child.stdin.end(stdin);
    const guard = setTimeout(() => {
      child.kill();
      reject(new Error(`cli ${argv.join(" ")} still running after ${limitMs} ms`));
    }, limitMs);
    child.on("error", e => { clearTimeout(guard); reject(e); });
    child.on("close", (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    if (onSpawn) onSpawn(child);
  });
}

/** Serve `handle(request, ctx)` for the length of `fn({ cli, path })`. */
export async function withBridge(handle, fn) {
  const path = bridgeName();
  let bridge;
  // The log line is said once the pipe is listening: no sleeping and hoping.
  await new Promise(resolve => { bridge = serveBridge({ path, handle, log: resolve }); });
  try {
    return await fn({ cli: (argv, o = {}) => run(argv, { ...o, path }), path });
  } finally { bridge.dispose(); }
}

// An agent, behind the bridge the extension serves it on.
export const withAgent = (agent, fn) => withBridge((req, ctx) => agent.run(req, ctx), fn);

// The command line's CSV, as rows of strings.
export function csvRows(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); cell = ""; rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}
