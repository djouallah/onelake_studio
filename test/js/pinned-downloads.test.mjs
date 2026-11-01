// What the build downloads is held to the hash it had (scripts/pinned-downloads.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPins } from "../../scripts/pinned-downloads.mjs";

const sha = text => createHash("sha256").update(text).digest("hex");
const inTemp = async (t, run) => {
  const dir = await mkdtemp(join(tmpdir(), "pins-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return run(join(dir, "hashes.json"));
};

test("a download is held to its hash, and one it doesn't know stops the build", (t) => inTemp(t, async file => {
  await writeFile(file, JSON.stringify({ "https://x/a": sha("a") }));
  const pins = createPins({ file, record: false });
  assert.deepEqual(pins.check("https://x/a", Buffer.from("a")), Buffer.from("a"));
  assert.throws(() => pins.check("https://x/a", Buffer.from("tampered")), /is not what it was/);
  assert.throws(() => pins.check("https://x/new", Buffer.from("n")), /has no hash/);
}));

test("with no file yet nothing is checked, and it says so once", (t) => inTemp(t, async file => {
  const said = [];
  const pins = createPins({ file, record: false, log: m => said.push(m) });
  pins.check("https://x/a", Buffer.from("a"));
  pins.check("https://x/b", Buffer.from("b"));
  assert.equal(said.length, 1);
  assert.match(said[0], /not checked/);
  assert.equal(pins.save(), 0);
}));

test("recording adds what is new, and never changes what was seen", (t) => inTemp(t, async file => {
  await writeFile(file, JSON.stringify({ "https://x/b": sha("b") }));
  const pins = createPins({ file, record: true });
  pins.check("https://x/a", Buffer.from("a"));
  pins.check("https://x/b", Buffer.from("b"));
  assert.throws(() => pins.check("https://x/b", Buffer.from("changed")), /is not what it was/, "not even when recording");
  assert.equal(pins.save(), 1);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { "https://x/a": sha("a"), "https://x/b": sha("b") });
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8"))), ["https://x/a", "https://x/b"], "sorted");
}));
