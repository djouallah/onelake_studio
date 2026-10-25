// =============================================================================
// fetch-extensions.mjs — DuckDB's extensions, inside the vsix
// =============================================================================
// Usage: node fetch-extensions.mjs <vscode-target>      e.g. win32-x64
//
// The engine needs iceberg, azure and httpfs to read a single table, and on first use
// DuckDB downloads them from extensions.duckdb.org. Offline, or behind a proxy DuckDB
// cannot get through, that first open simply failed. So each platform's vsix carries its
// platform's binaries in extension/duckdb-extensions/, and engine-host.js LOADs them by
// path before it ever thinks of downloading. They are the signed binaries DuckDB itself
// would have installed; DuckDB checks the signature at LOAD either way.
//
// The DuckDB version is read from the installed @duckdb/node-api — the same rule
// fetch-binding.mjs follows — so a dependency bump moves these with it. Required ones fail
// the package; an optional one with no build for a platform is skipped and logged.
// =============================================================================
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "duckdb-extensions");

const PLATFORM = {
  "win32-x64": "windows_amd64", "win32-arm64": "windows_arm64",
  "darwin-x64": "osx_amd64", "darwin-arm64": "osx_arm64",
  "linux-x64": "linux_amd64", "linux-arm64": "linux_arm64",
};
const EXTENSIONS = [
  { name: "iceberg", repo: "https://extensions.duckdb.org", required: true },
  { name: "azure", repo: "https://extensions.duckdb.org", required: true },
  { name: "httpfs", repo: "https://extensions.duckdb.org", required: true },
  { name: "avro", repo: "https://extensions.duckdb.org", required: true },
  { name: "excel", repo: "https://extensions.duckdb.org", required: false },
  // Not h3 or zipfs: they are COMMUNITY extensions, and a LOAD by path verifies against the
  // core signing keys only (DuckDB 2.0 refuses them as unsigned). They keep downloading
  // from the community repository on first use, signature checked as before.
];

const target = process.argv[2];
const platform = PLATFORM[target];
if (!platform) {
  console.error(`usage: node fetch-extensions.mjs <${Object.keys(PLATFORM).join("|")}>`);
  process.exit(2);
}

// "2.0.0-r.1" -> "v2.0.0"
const apiVersion = JSON.parse(
  await readFile(join(here, "node_modules", "@duckdb", "node-api", "package.json"), "utf8")).version;
const duckdb = `v${apiVersion.replace(/-.*$/, "")}`;

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url).catch(e => ({ ok: false, status: 0, statusText: e.message }));
    if (r.ok) return Buffer.from(await r.arrayBuffer());
    if (r.status === 404 || attempt >= 3) return { missing: r.status === 404, status: r.status };
    await new Promise(res => setTimeout(res, 1000 * attempt));
  }
}

let bytes = 0;
for (const ext of EXTENSIONS) {
  const url = `${ext.repo}/${duckdb}/${platform}/${ext.name}.duckdb_extension.gz`;
  const got = await get(url);
  if (!Buffer.isBuffer(got)) {
    if (ext.required) throw new Error(`${ext.name} for ${platform} (${duckdb}): HTTP ${got.status} from ${url}`);
    console.log(`  skip  ${ext.name} — no ${platform} build (${got.status})`);
    continue;
  }
  const bin = gunzipSync(got);
  await writeFile(join(OUT, `${ext.name}.duckdb_extension`), bin);
  bytes += bin.length;
  console.log(`  got   ${ext.name} (${(bin.length / 1e6).toFixed(1)}MB)`);
}
console.log(`bundled DuckDB ${duckdb} extensions for ${platform}: ${(bytes / 1e6).toFixed(1)}MB`);
