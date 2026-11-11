// A Fabric app on a local Rayfin backend (rayfin-local), for the tests that open one (run-fabric-local.mjs,
// run-fabric-app.mjs): its project as an export's local copy lays it out (rayfin/: rayfin.yml and the function;
// the site, built as it is uploaded), served by rayfin-local, which runs the function with the real
// @microsoft/fabric-user-data-functions and answers the page's SDK as Fabric's backend does.
// Nothing of the product is stood in for or written over: the page signs in with its own sign-in and asks its
// own function. What the tests add is beside the product: a page of their own in the site (`extra`), a local user.
import { spawn, execSync, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

const require = createRequire(import.meta.url);
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const { PINS, WEBAPP } = require("../../core/vendored.js");
const { appFiles, buildDist, vendorFiles } = require("../../fabric_app/export/exportapp.js");

export const RAYFIN_LOCAL = process.env.RAYFIN_LOCAL || "rayfin-local";
export const CHROME = process.env.CHROME_PATH ||
  (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
// The version the site's packages are: rayfin-local reads a project with the project's own @microsoft/rayfin-core.
export const SDK = WEBAPP.rayfinClient.split("@").pop();
const npm = (what, cwd) => execSync(`npm ${what} --no-audit --no-fund --loglevel=error`, { cwd, stdio: ["ignore", "ignore", "inherit"] });

/**
 * The app served: { ready (rayfin-local's ready event: appUrl, embedUrl, features), said (its last lines), stop(ok) }.
 * `plan`, `model`, `report`: an export's (exportapp.js appFiles); `engine`: duckdb or semanticModel;
 * `env`: the function's secrets and rayfin-local's tokens; `extra`: path -> text, files put in the site beside its own;
 * `user`: { name, password }, a user of the local backend's own.
 */
export async function serveApp(name, { plan, model, report = null, engine, env = {}, extra = {}, user = null }) {
  const files = await appFiles({ plan, state: null, model, kept: report ? Buffer.from(JSON.stringify(report)) : null,
                                 fabricAppDir: join(root, "fabric_app"), appDir: join(root, "page"), daxSqlDir: join(root, "vendor", "npm", PINS.daxSql) });
  const project = await mkdtemp(join(tmpdir(), "fabric-local-"));
  const put = async (path, bytes) => { const to = join(project, path); await mkdir(dirname(to), { recursive: true }); await writeFile(to, bytes); };
  for (const [path, bytes] of files) if (path.startsWith("rayfin/")) await put(path, bytes);
  // The site's rayfin.config.json is the backend's to answer: where it is, and its key.
  for (const [path, bytes] of buildDist(files, {}, await vendorFiles(join(root, "vendor", "webapp"), engine))) {
    if (path !== "rayfin.config.json") await put(join("dist", path), bytes);
  }
  for (const [path, text] of Object.entries(extra)) await put(join("dist", path), text);
  // The export's local copy has no package.json of its own.
  await put("package.json", JSON.stringify({ name: plan.name, private: true, type: "module", dependencies: { "@microsoft/rayfin-core": SDK } }, null, 2));
  console.log(`${name}: the project is ${project} (Rayfin ${SDK})`);
  npm("install", project);
  npm("ci", join(project, "rayfin", "functions"));
  if (user) execFileSync(RAYFIN_LOCAL, ["users", "add", user.name, "--password", user.password, "-C", project], { stdio: ["ignore", "ignore", "inherit"] });

  const said = [];
  const server = spawn(RAYFIN_LOCAL, ["serve", "--static", "--reuse-build", "--json", "--sign-in-as", "developer", "-C", project],
    { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const stop = async ok => {
    if (!ok) for (const line of said.slice(-40)) console.log(`  ${String(line).trimEnd().slice(0, 400)}`);
    if (server.exitCode == null) {
      server.stdin.end();   // rayfin-local stops when its stdin closes
      await new Promise(r => { server.on("exit", r); setTimeout(() => { server.kill(); r(); }, 15_000); });
    }
    if (ok) await rm(project, { recursive: true, force: true }).catch(() => {});
  };
  server.stderr.on("data", d => said.push(String(d)));
  try {
    const ready = await new Promise((resolve, reject) => {
      createInterface({ input: server.stdout }).on("line", line => {
        let e; try { e = JSON.parse(line); } catch { return; }
        if (e.type === "log") said.push(`[${e.source}] ${e.line}`);
        else if (e.type !== "ready") said.push(`${e.type}: ${JSON.stringify(e).slice(0, 300)}`);
        if (e.type === "ready") resolve(e);
        if (e.type === "error" && e.fatal) reject(new Error(`rayfin-local: ${e.code} ${e.message} ${e.hint ?? ""}`));
      });
      server.on("exit", c => reject(new Error(`rayfin-local stopped (${c}) before it was ready`)));
      setTimeout(() => reject(new Error("rayfin-local was not ready in 4 minutes")), 240_000);
    });
    console.log(`${name}: rayfin-local serves ${ready.appUrl}, functions ${ready.features.functions.names.join(", ") || "none"}, ` +
      `connectors ${ready.features.connectors.map(c => `${c.name} (${c.type})`).join(", ") || "none"}, SDK ${ready.sdk.version} ${ready.sdk.supported ? "supported" : "NOT supported"}`);
    return { ready, said, project, stop };
  } catch (e) {
    await stop(false);
    throw e;
  }
}

/** A table of the lakehouse, as its Iceberg catalog says it: { columns: [{ name, type }], rows, bytes }. */
export async function tableOf(ws, lh, table, token) {
  const endpoint = "https://onelake.table.fabric.microsoft.com/iceberg";
  const get = async url => {
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`the catalog: HTTP ${r.status} for ${url}`);
    return r.json();
  };
  const config = await get(`${endpoint}/v1/config?warehouse=${encodeURIComponent(`${ws}/${lh}`)}`);
  const prefix = config.overrides?.prefix ?? config.defaults?.prefix;
  const [ns, name] = table.split(".");
  const m = (await get(`${endpoint}/v1/${prefix}/namespaces/${ns}/tables/${name}`)).metadata;
  const schema = (m.schemas ?? []).find(s => s["schema-id"] === m["current-schema-id"]) ?? m.schema;
  const current = (m.snapshots ?? []).find(s => s["snapshot-id"] === m["current-snapshot-id"]);
  return { columns: schema.fields.map(f => ({ name: f.name, type: typeof f.type === "string" ? f.type : f.type.type })),
           rows: Number(current?.summary?.["total-records"] ?? NaN), bytes: Number(current?.summary?.["total-files-size"] ?? NaN) };
}
