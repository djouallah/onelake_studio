// =============================================================================
// release-notes.mjs — a version's section of docs/CHANGELOG.md, as a GitHub release's notes
// =============================================================================
// GitHub shows each line break in a release's notes, so the changelog's wrapped lines are joined
// back into one line per item.
//
//   node scripts/release-notes.mjs 0.2.11 > notes.md
// =============================================================================
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "CHANGELOG.md"), "utf8");
const lines = text.split(/\r?\n/);
const start = lines.indexOf(`## ${version}`);
if (start < 0) {
  console.error(`docs/CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
const out = [];
for (const line of lines.slice(start + 1)) {
  if (line.startsWith("## ")) break;
  // A wrapped line: indented, and not an item of its own.
  if (/^\s+\S/.test(line) && !/^\s*- /.test(line) && out.length && out.at(-1).trim()) out[out.length - 1] += ` ${line.trim()}`;
  else out.push(line);
}
process.stdout.write(`${out.join("\n").trim()}\n`);
