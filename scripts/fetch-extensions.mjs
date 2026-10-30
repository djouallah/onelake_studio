// =============================================================================
// fetch-extensions.mjs — DuckDB's extensions, inside the vsix
// =============================================================================
// Usage: node scripts/fetch-extensions.mjs <vscode-target>      e.g. win32-x64
//
// The engine needs iceberg, azure and httpfs to read a single table, and on first use
// DuckDB downloads them from extensions.duckdb.org. Offline, or behind a proxy DuckDB
// cannot get through, that first open simply failed. So each platform's vsix carries its
// platform's binaries in duckdb-extensions/, and engine-host.js LOADs them by
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
import { fetchRetry } from "./fetch-retry.mjs";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");   // the extension root
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
  // SQLite files under Files/: the host copies one to the engine's temp directory and
  // ATTACHes it read-only.
  { name: "sqlite_scanner", repo: "https://extensions.duckdb.org", required: false },
  // Not h3 or zipfs: they are COMMUNITY extensions, and a LOAD by path verifies against the
  // core signing keys only (DuckDB 2.0 refuses them as unsigned). They keep downloading
  // from the community repository on first use, signature checked as before.
  //
  // cache_httpfs, the disk cache, is OUR build of it (djouallah/duck-read-cache-fs, branch
  // fix/windows-long-path-xattr): the released one caches nothing on disk on Windows. It is
  // unsigned, and engine-host.js allows that for it. Back to the community build once the
  // fix is released upstream.
  { name: "cache_httpfs", required: false,
    url: (duckdb, platform) => `https://github.com/djouallah/duck-read-cache-fs/releases/download/onelake-${duckdb}-1/cache_httpfs.${platform}.duckdb_extension` },
];

const target = process.argv[2];
const platform = PLATFORM[target];
if (!platform) {
  console.error(`usage: node scripts/fetch-extensions.mjs <${Object.keys(PLATFORM).join("|")}>`);
  process.exit(2);
}

// "2.0.0-r.1" -> "v2.0.0"
const apiVersion = JSON.parse(
  await readFile(join(here, "node_modules", "@duckdb", "node-api", "package.json"), "utf8")).version;
const duckdb = `v${apiVersion.replace(/-.*$/, "")}`;

// A tree fetched for this DuckDB, this platform and this list is reused as it is: a restored CI
// cache costs no network. Anything else is fetched again from scratch.
const STAMP = join(OUT, ".stamp.json");
const want = JSON.stringify({ duckdb, platform, extensions: EXTENSIONS.map(e => (e.url ? e.url(duckdb, platform) : `${e.repo}/${e.name}`)) });
if (await readFile(STAMP, "utf8").catch(() => "") === want) {
  console.log(`duckdb-extensions/ already holds DuckDB ${duckdb}'s extensions for ${platform} — nothing to fetch`);
  process.exit(0);
}
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

let bytes = 0;
for (const ext of EXTENSIONS) {
  // A repository serves gzipped binaries; a release asset (ext.url) is the binary itself.
  const url = ext.url ? ext.url(duckdb, platform) : `${ext.repo}/${duckdb}/${platform}/${ext.name}.duckdb_extension.gz`;
  // Only a 404 means there is no build for this platform. Any other failure stops the build,
  // so a vsix never ships without an optional extension because of a network hiccup.
  const got = await fetchRetry(url, { missingOk: true });
  if (!got) {
    if (ext.required) throw new Error(`${ext.name} for ${platform} (${duckdb}): HTTP 404 from ${url}`);
    console.log(`  skip  ${ext.name} — no ${platform} build (404)`);
    continue;
  }
  const bin = ext.url ? got : gunzipSync(got);
  await writeFile(join(OUT, `${ext.name}.duckdb_extension`), bin);
  bytes += bin.length;
  console.log(`  got   ${ext.name} (${(bin.length / 1e6).toFixed(1)}MB)`);
}
await writeFile(STAMP, want);
console.log(`bundled DuckDB ${duckdb} extensions for ${platform}: ${(bytes / 1e6).toFixed(1)}MB`);
