// =============================================================================
// pinned-downloads.mjs — what the build downloads, held to the hash it had
// =============================================================================
// A version pins a name, not bytes. vendor.mjs and fetch-extensions.mjs download code that ships in
// the vsix and runs beside the user's OneLake token, so each download is held to the SHA-256 in
// scripts/downloads.sha256.json, by its URL, before anything uses it.
//
// A download whose hash differs stops the build. So does one the file doesn't list: a new pin is
// added on purpose, by the "Refresh download hashes" workflow, which sets RECORD_DOWNLOAD_HASHES.
// That workflow adds to the file and never changes a line of it: what was seen once stays what is
// expected. With no file at all, nothing is checked yet, and the build says so.
// =============================================================================
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = join(dirname(fileURLToPath(import.meta.url)), "downloads.sha256.json");

/** @param {{ file?: string, record?: boolean, log?: (line: string) => void }} [o] */
export function createPins({ file = MANIFEST, record = !!process.env.RECORD_DOWNLOAD_HASHES, log = console.log } = {}) {
  let known = null;
  try { known = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw new Error(`${file}: ${e.message}`); }
  let said = false;
  const added = {};

  return {
    // `bytes` as they arrived from `url`, or a reason the build stops.
    check(url, bytes) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      const want = known && Object.hasOwn(known, url) ? known[url] : null;
      if (want && want !== hash) {
        throw new Error(`${url} is not what it was: sha256 ${hash}, and ${file} says ${want}. Find out why before changing that file.`);
      }
      if (want) return bytes;
      if (record) { added[url] = hash; return bytes; }
      if (!known) {
        if (!said) log(`no ${file} yet, so downloads are not checked: run the "Refresh download hashes" workflow`);
        said = true;
        return bytes;
      }
      throw new Error(`${url} has no hash in ${file}. A new pin is added by the "Refresh download hashes" workflow.`);
    },
    // What this run saw for the first time, added to the file. Sorted, so a change reads as a change.
    save() {
      const names = Object.keys(added);
      if (!names.length) return 0;
      let now = {};
      try { now = JSON.parse(readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
      const all = { ...now, ...added };
      const sorted = Object.fromEntries(Object.keys(all).sort().map(k => [k, all[k]]));
      writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
      return names.length;
    },
  };
}
