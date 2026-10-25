// Static "build": publish site/ to dist/, which GitHub Pages serves. No bundler — the app is
// plain HTML + ES modules — so most of this is a copy. Three things are generated:
//
// 1. dist/npm/ — every third-party package the page runs (cdn.js pins them), with its whole
//    import closure, mirroring jsDelivr's layout. The deployed site then loads no executable
//    code from a third party: no CDN can change what runs on the origin that holds a OneLake
//    token. Each file's own `/npm/…` imports are rewritten to RELATIVE paths, so the copy
//    works under any base path, and jsDelivr's extension-less "+esm" files are saved as
//    "+esm.js", because a static host serves an extension-less file as octet-stream and a
//    module script refuses that.
// 2. dist/duckdb-extensions/ — the DuckDB extensions the engine loads, in the repository
//    layout DuckDB's INSTALL … FROM expects. Signed binaries; DuckDB verifies them either way.
// 3. dist/version.js — the real commit and build time (the UI shows it, because "which build
//    am I running?" must be answerable from the page when a browser serves a stale cache),
//    plus `vendored: true` — and only then is jsDelivr taken out of dist/index.html's
//    Content-Security-Policy. A failed download leaves the build on the CDN, loudly, rather
//    than shipping a page whose policy refuses its own scripts.
//
// Also: dist/README.md, so the landing page reads the docs from this origin instead of
// raw.githubusercontent.com.
import { rm, cp, writeFile, readFile, mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { PINS, VENDOR } from "./site/cdn.js";

const dist = new URL("./dist/", import.meta.url);
const site = new URL("./site/", import.meta.url);
const distPath = p => fileURLToPath(new URL(p, dist));

await rm(dist, { recursive: true, force: true });
await cp(site, dist, { recursive: true });
await cp(new URL("./README.md", import.meta.url), new URL("./README.md", dist));

// --- 1. the npm closure -------------------------------------------------------------------
const JSDELIVR = "https://cdn.jsdelivr.net";
const seen = new Set();
let files = 0, bytes = 0;

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise(res => setTimeout(res, 1000 * attempt));
    }
  }
}

async function save(relPath, buf) {
  const file = distPath(relPath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buf);
  files++; bytes += buf.length;
}

// "/npm/x@1/+esm" -> "npm/x@1/+esm.js"; "/npm/x@1/dist/a.mjs/+esm" -> "npm/x@1/dist/a.mjs/+esm.js"
const localOf = npmPath => npmPath.replace(/^\//, "").replace(/\/\+esm$/, "/+esm.js");

async function esmClosure(npmPath) {
  if (seen.has(npmPath)) return;
  seen.add(npmPath);
  const text = (await get(JSDELIVR + npmPath)).toString("utf8");
  const deps = new Set();
  for (const m of text.matchAll(/["'](\/npm\/[^"'\s]+?)["']/g)) deps.add(m[1]);
  const here = posix.dirname(localOf(npmPath));
  let out = text;
  for (const dep of deps) {
    let rel = posix.relative(here, localOf(dep));
    if (!rel.startsWith(".")) rel = "./" + rel;
    out = out.split(`"${dep}"`).join(`"${rel}"`).split(`'${dep}'`).join(`'${rel}'`);
  }
  await save(localOf(npmPath), Buffer.from(out, "utf8"));
  for (const dep of deps) await esmClosure(dep);
}

// --- 2. DuckDB extensions -------------------------------------------------------------------
const EXT_HOSTS = { core: "https://extensions.duckdb.org", community: "https://community-extensions.duckdb.org" };

let vendored = true;
try {
  for (const pkg of VENDOR.esm) await esmClosure(`/npm/${pkg}/+esm`);
  for (const f of VENDOR.files) await save(`npm/${f}`, await get(`${JSDELIVR}/npm/${f}`));
  for (const [repo, names] of Object.entries(VENDOR.extensions)) {
    for (const name of names) {
      const rel = `${PINS.duckdbCore}/wasm_eh/${name}.duckdb_extension.wasm`;
      await save(`duckdb-extensions/${repo}/${rel}`, await get(`${EXT_HOSTS[repo]}/${rel}`));
    }
  }
} catch (e) {
  vendored = false;
  console.warn(`!! vendoring failed, the deployed page will load packages from jsDelivr: ${e.message}`);
  await rm(distPath("npm"), { recursive: true, force: true });
  await rm(distPath("duckdb-extensions"), { recursive: true, force: true });
}

if (vendored) {
  const index = distPath("index.html");
  const html = await readFile(index, "utf8");
  const tightened = html
    .replace(/(script-src [^;"]*?) https:\/\/cdn\.jsdelivr\.net/, "$1")
    .replace(/\s*<link rel="preconnect" href="https:\/\/cdn\.jsdelivr\.net"[^>]*>/, "");
  if (tightened === html || /script-src [^;"]*cdn\.jsdelivr\.net/.test(tightened)) {
    throw new Error("dist/index.html: could not take jsDelivr out of the Content-Security-Policy");
  }
  await writeFile(index, tightened);
}

// --- 3. version.js ---------------------------------------------------------------------------
// GITHUB_SHA in CI; git locally; "unknown" only if both are unavailable.
let commit = process.env.GITHUB_SHA || "";
if (!commit) {
  try { commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch (_) {}
}
const short = commit ? commit.slice(0, 7) : "unknown";
const builtAt = new Date().toISOString();
await writeFile(new URL("./version.js", dist),
  `window.ONELAKE_STUDIO_VERSION = { commit: ${JSON.stringify(short)}, builtAt: ${JSON.stringify(builtAt)}, ` +
  `vendored: ${vendored} };\n`);

console.log(`Published site/ -> dist/  (version ${short}, built ${builtAt})` +
  (vendored ? `; vendored ${files} file(s), ${(bytes / 1e6).toFixed(1)} MB` : "; NOT vendored"));
