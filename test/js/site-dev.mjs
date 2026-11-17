// The Fabric app's page as an export's project holds it, served by the project's own Vite, for the tests that
// run its storage scripts in a browser with no backend (run-split.mjs, run-store-heal.mjs): the project a
// client-side export writes (exportapp.js appFiles, with the site's files npm has not), its page's packages
// installed from its own lock file, and Vite's dev server started in site/, as Fabricator's preview starts it.
// A test's own page goes beside index.html (`extra`), and imports the page's scripts (./src/storage/…) and
// packages (@duckdb/duckdb-wasm) as the page does.
// Needs vendor/ (scripts/vendor.mjs), npm and the registry.
import { spawn, execSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const { PINS } = require("../../core/vendored.js");
const { appFiles, setStatic, staticFiles, PAGE } = require("../../fabric_app/export/exportapp.js");

const NOBODY = "00000000-0000-0000-0000-000000000000";

/**
 * The page served: { base (its URL, ending in /), said (Vite's lines), stop() }.
 * `extra`: path -> text, files put in site/ beside index.html; `port`: Vite's.
 */
export async function siteDev({ extra = {}, port }) {
  const project = await mkdtemp(join(tmpdir(), "site-dev-"));
  const put = async (path, bytes) => { const to = join(project, path); await mkdir(dirname(to), { recursive: true }); await writeFile(to, bytes); };
  // Rayfin's agent files are no part of the page: one stands in for what scripts/function-bundle.mjs makes.
  await put("agent-files.json", JSON.stringify({ ".agents/skills/rayfin/SKILL.md": "# rayfin\n" }));
  const files = await appFiles({
    plan: { name: "site-dev", title: "site-dev", modelPath: "", workspace: NOBODY, lakehouse: NOBODY, catalogUrl: "", tables: [] },
    state: null, model: {}, fabricAppDir: join(root, "fabric_app"), appDir: join(root, "page"),
    daxSqlDir: join(root, "vendor", "npm", PINS.daxSql), agentFiles: join(project, "agent-files.json") });
  setStatic(files, await staticFiles(join(root, "vendor", "webapp")));
  for (const [path, bytes] of files) await put(path, bytes);
  for (const [path, text] of Object.entries(extra)) await put(PAGE + path, text);
  console.log(`the project: ${project}`);
  execSync("npm ci --no-audit --no-fund --loglevel=error --workspace site", { cwd: project, stdio: ["ignore", "ignore", "inherit"] });

  const said = [];
  const vite = spawn(process.execPath, [join(project, "node_modules", "vite", "bin", "vite.js"), "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    { cwd: join(project, "site"), stdio: ["ignore", "pipe", "pipe"] });
  vite.stdout.on("data", d => said.push(String(d)));
  vite.stderr.on("data", d => said.push(String(d)));
  const stop = async ok => {
    vite.kill();
    if (!ok) console.log(said.join("").slice(-3000));
    await rm(project, { recursive: true, force: true }).catch(() => {});
  };
  const base = `http://127.0.0.1:${port}/`;
  const started = Date.now();
  for (;;) {
    if (await fetch(base).catch(() => null)) break;
    if (vite.exitCode != null || Date.now() - started > 60_000) {
      await stop(false);
      throw new Error("Vite did not start");
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return { base, said, stop };
}

// What a test's page starts with: DuckDB-WASM and the page's own files, each named as the page's data.js names
// them. A worker made from a blob reads no relative URL: each in full.
export const ENGINE_FILES = `
import * as duckdb from "@duckdb/duckdb-wasm";
import WASM_URL from "@duckdb/duckdb-wasm/dist/duckdb-base.wasm?url";
import WORKER_URL from "@duckdb/duckdb-wasm/dist/duckdb-browser-base.worker.js?url";
import BLOCKCACHE_URL from "./src/storage/blockcache.js?url";
import { siteUrl } from "./src/site.js";

const WASM = siteUrl(WASM_URL), WORKER = siteUrl(WORKER_URL), BLOCKCACHE = siteUrl(BLOCKCACHE_URL);
const EXT_REPO = siteUrl("duckdb-ext");
`;

export const TEST_HTML = '<!doctype html><meta charset="utf-8"><body><script type="module" src="./test.js"></script>';
