// What the command line says it does, against what it does: --help and the skill an agent reads
// name every command and option there is, and none that is not. A skill that drifts is an agent
// typing what fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { run, bridgeName } from "./cli-harness.mjs";

const require = createRequire(import.meta.url);
const { COMMANDS, EXIT } = require("../../src/bridge.js");

// (The one option of node's own it names is how it runs the command line.)
const SKILL = (await readFile(new URL("../../claude-skill/SKILL.md", import.meta.url), "utf8")).replaceAll("node --no-warnings", "node");
const CLI_SOURCE = await readFile(new URL("../../bin/cli.mjs", import.meta.url), "utf8");
const { stdout: HELP } = await run(["--help"], { path: bridgeName() });

// Every option the parser takes, read from the parser's own tables.
const table = name => Object.keys(Function(`return ${new RegExp(`const ${name} = (\\{[^}]*\\})`).exec(CLI_SOURCE)[1]}`)());
const PARSED = [...table("SWITCHES"), ...table("VALUES"), "--help", "--version"];
const optionsIn = text => [...new Set(text.match(/(?<![\w-])--[a-z][a-z-]*/g) || [])];

test("the parser's tables were found", () => {
  assert.ok(PARSED.includes("--json") && PARSED.includes("--timeout"), PARSED.join(" "));
});

test("--help names every command and every option", () => {
  for (const name of Object.keys(COMMANDS)) assert.match(HELP, new RegExp(`^  ${name}\\b`, "m"), name);
  for (const flag of PARSED) assert.ok(HELP.includes(flag), flag);
});

test("--help names no option there is not", () => {
  for (const flag of optionsIn(HELP)) assert.ok(PARSED.includes(flag), flag);
});

test("the skill names every command and every option", () => {
  for (const name of Object.keys(COMMANDS)) assert.ok(SKILL.includes(`\`${name}`), name);
  for (const flag of PARSED.filter(f => f !== "--help" && f !== "--version")) assert.ok(SKILL.includes(flag), flag);
});

test("the skill names no option there is not", () => {
  for (const flag of optionsIn(SKILL)) assert.ok(PARSED.includes(flag), flag);
});

test("the skill's table of exit codes is the code's", () => {
  const rows = [...SKILL.matchAll(/^\| (\d) \| `([A-Z_]+)` \|/gm)].map(m => [m[2], Number(m[1])]);
  assert.deepEqual(Object.fromEntries(rows), EXIT);
});

test("--help's exit codes are the code's", () => {
  const line = HELP.slice(HELP.indexOf("exit codes:"));
  for (const code of Object.values(EXIT)) assert.match(line, new RegExp(`(^|\\s)${code} `), String(code));
});
