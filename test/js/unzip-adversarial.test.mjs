// An app's file is a zip someone may have sent: reading one must cost no more than it says, never read past
// its own bytes, and fail with a reason. exportapp.js unzip, on zips built to break it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { deflateRawSync } from "node:zlib";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eachSeed, mutate } from "./fuzz.mjs";

const require = createRequire(import.meta.url);
const { unzip, zip, crc32, readApp, writeApp, MAX_ENTRIES } = require("../../fabric_app/export/exportapp.js");

// A zip written by hand, so every field can lie. `entries`: { name, data, packed?, method?, raw?, size?, crc?, at? };
// `at` makes an entry's directory record point at another's bytes.
function craft(entries) {
  const local = [], central = [];
  const offsets = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const method = e.method ?? 8;
    const packed = e.packed ?? (method === 8 ? deflateRawSync(e.data) : e.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(method, 8);
    head.writeUInt16LE(name.length, 26);
    offsets.push(offset);
    if (e.at == null) { local.push(head, name, packed); }
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(e.crc ?? crc32(e.data), 16);
    dir.writeUInt32LE(e.size ?? packed.length, 20);
    dir.writeUInt32LE(e.raw ?? e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(e.at != null ? offsets[e.at] : offset, 42);
    central.push(dir, name);
    if (e.at == null) offset += head.length + name.length + packed.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

const MB = 1024 * 1024;

test("the zip made by hand reads back: the tests below break a zip that works", () => {
  const out = unzip(craft([{ name: "site/a.js", data: Buffer.from("a") }, { name: "site/b.js", data: Buffer.from("bb"), method: 0 }]));
  assert.deepEqual([...out].map(([k, v]) => [k, v.toString()]), [["site/a.js", "a"], ["site/b.js", "bb"]]);
});

test("many entries that share one entry's bytes are stopped at the total, not unpacked one after another", () => {
  const zeros = Buffer.alloc(MB);
  // A kilobyte of packed bytes, named 64 times: 64 MB if each were taken at its word.
  const entries = [{ name: "site/0", data: zeros }];
  for (let i = 1; i < 64; i++) entries.push({ name: `site/${i}`, data: zeros, at: 0 });
  const bomb = craft(entries);
  assert.ok(bomb.length < 64 * 1024, `the file itself is small: ${bomb.length} bytes`);
  const before = process.memoryUsage().arrayBuffers;
  assert.throws(() => unzip(bomb, { maxTotal: 4 * MB }), /too big together to be an app/);
  assert.ok(process.memoryUsage().arrayBuffers - before < 16 * MB, "and it stopped before unpacking them all");
  // Under the limit the same trick is only a zip with repeated files.
  assert.equal(unzip(bomb, { maxTotal: 128 * MB }).size, 64);
});

test("more entries than an app holds is refused before any is read", () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({ name: `site/${i}`, data: Buffer.from("x") }));
  assert.throws(() => unzip(craft(entries), { maxEntries: 49 }), /50 entries is more than an app holds/);
  assert.equal(unzip(craft(entries), { maxEntries: 50 }).size, 50);
  assert.ok(MAX_ENTRIES >= 1000 && MAX_ENTRIES < 65535, "the real limit is under what a zip's directory can count");
});

test("an entry that says it is smaller than it is, or bigger, or has another checksum, is damaged", () => {
  const data = Buffer.alloc(4096, 7);
  assert.throws(() => unzip(craft([{ name: "site/a", data, raw: 10 }])), /site\/a is damaged/, "it unpacks to more than it says");
  assert.throws(() => unzip(craft([{ name: "site/a", data, raw: 8192 }])), /site\/a is damaged/, "and to less");
  assert.throws(() => unzip(craft([{ name: "site/a", data, crc: 1 }])), /site\/a is damaged/);
  assert.throws(() => unzip(craft([{ name: "site/a", data, raw: 0xffffffff }])), /too big to be an app's file/);
  assert.throws(() => unzip(craft([{ name: "site/a", data, size: 0x7fffffff }])), /site\/a is damaged/, "its bytes would end past the file's");
  assert.throws(() => unzip(craft([{ name: "site/a", data, method: 12 }])), /compressed in a way this can't read/);
});

test("an entry that names a place outside the app is refused", () => {
  const data = Buffer.from("x");
  // Beside a real file of the app's, so nothing is taken for a top folder the whole app was zipped in.
  const beside = { name: "rayfin/rayfin.yml", data };
  for (const name of ["../outside.js", "site/../../outside.js", "/etc/passwd", "C:/Windows/x", "site\\..\\..\\x", "site//x.js", "site/./x.js"]) {
    assert.throws(() => unzip(craft([beside, { name, data }])), /is not a path inside an app/, name);
  }
  // A folder zipped whole loses its top folder: what is left is checked, not what was written.
  for (const names of [["top//abs.js", "top/site/a.js"], ["top/C:/x.js", "top/site/a.js"], ["top/../x.js", "top/site/a.js"]]) {
    assert.throws(() => unzip(craft(names.map(name => ({ name, data })))), /is not a path inside an app/, names[0]);
  }
  assert.deepEqual([...unzip(craft([{ name: "top/site/a.js", data }, { name: "top/export.json", data }])).keys()], ["site/a.js", "export.json"]);
  // Dots in a name are not a way out.
  assert.equal(unzip(craft([{ name: "site/a..b/..c.js", data }])).size, 1);
});

test("no bytes, a few bytes, and a directory that points past the end all fail with a reason", () => {
  assert.throws(() => unzip(Buffer.alloc(0)), /no zip directory/);
  assert.throws(() => unzip(Buffer.from("PK\x05\x06")), /no zip directory/);
  const good = craft([{ name: "site/a", data: Buffer.from("a") }]);
  const end = good.length - 22;
  const far = Buffer.from(good); far.writeUInt32LE(0x7ffffff0, end + 16);
  assert.throws(() => unzip(far), /a broken zip directory/);
  const many = Buffer.from(good); many.writeUInt16LE(9, end + 10);
  assert.throws(() => unzip(many), /a broken zip directory/);
});

test("fuzz: a zip with bytes changed, cut or added is read or refused with an Error, and never more than it holds", async () => {
  const files = [["site/app.js", Buffer.from("// app\n".repeat(200))], ["site/report.json", Buffer.from('{"tiles":[]}')],
                 ["export.json", Buffer.from('{"name":"x"}')], ["rayfin/rayfin.yml", Buffer.alloc(3000, 0x61)]];
  const good = await zip(files);
  eachSeed(r => {
    const bad = mutate(r, good);
    let out;
    try { out = unzip(bad, { maxTotal: 8 * MB }); }
    catch (e) {
      assert.ok(e instanceof Error, "an Error, whatever was wrong");
      assert.ok(!(e instanceof TypeError), `a reason, not a mistake of the reader's own: ${e.stack}`);
      return;
    }
    let total = 0;
    for (const [name, bytes] of out) { assert.equal(typeof name, "string"); total += bytes.length; }
    assert.ok(total <= 8 * MB);
  }, 2000);
});

test("readApp says a broken file is not an app, and writeApp leaves no temporary file behind, even two at once", async t => {
  const dir = await mkdtemp(join(tmpdir(), "unzip-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "x.fabricapp");
  const files = n => new Map([["site/app.js", Buffer.from(`// ${n}`)]]);
  // Two writes of one file at the same moment: each is whole, and one of them is what is left.
  await Promise.all([writeApp(file, files(1), { n: 1 }), writeApp(file, files(2), { n: 2 })]);
  const app = await readApp(file);
  assert.equal(app.files.get("site/app.js").toString(), `// ${app.marker.n}`, "one write's files with that write's own record");
  assert.deepEqual(await readdir(dir), ["x.fabricapp"], "no .tmp left");
  assert.equal(await readApp(join(dir, "none.fabricapp")), null, "no file is no app, not an error");
  const broken = join(dir, "broken.fabricapp");
  await writeFile(broken, Buffer.from("this was never a zip"));
  await assert.rejects(readApp(broken), /is not a zip Export to Fabric can read: no zip directory/);
  // A zip that is not an app's: nothing Export to Fabric wrote, so nothing it writes over.
  await writeFile(broken, craft([{ name: "site/a", data: Buffer.from("a") }]));
  await assert.rejects(readApp(broken), /was not written by Export to Fabric/);
});
