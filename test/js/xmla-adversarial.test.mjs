// Excel's endpoint, sent what Excel never sends. Whoever holds its token is still not trusted with the extension
// host's time or memory: a request is read in time linear in its size, a list of members is asked for a few at
// a time, and whatever arrives is answered with a fault, not with a crash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import http from "node:http";
import { eachSeed } from "./fuzz.mjs";

const require = createRequire(import.meta.url);
const { parseRequest, inner, unesc, esc } = require("../../xmla/soap.js");
const { buildCube } = require("../../xmla/cube.js");
const { parseSelect } = require("../../xmla/mdx.js");
const { literal } = require("../../xmla/cellset.js");
const { discover } = require("../../xmla/rowsets.js");
const { createHandler } = require("../../xmla/server.js");

const timed = run => { const t0 = Date.now(); run(); return Date.now() - t0; };

test("inner: what is between a tag and its first close, with attributes, or nothing", () => {
  assert.equal(inner("<a><Statement>x</Statement></a>", "Statement"), "x");
  assert.equal(inner('<Statement xmlns="u">a<b/>c</Statement>', "Statement"), "a<b/>c");
  assert.equal(inner("<Statement></Statement>", "Statement"), "");
  assert.equal(inner("<Statement>never closed", "Statement"), undefined);
  assert.equal(inner("<StatementList>x</StatementList>", "Statement"), undefined, "a longer name is another tag");
  assert.equal(inner("<Statement", "Statement"), undefined);
  assert.equal(inner("", "Statement"), undefined);
  assert.equal(inner("<Statement>one</Statement><Statement>two</Statement>", "Statement"), "one");
});

test("a request with a great deal that is never closed is read in time linear in its size", () => {
  const MB = 1024 * 1024;
  const hostile = {
    "unclosed restrictions": `<RestrictionList>${"<a>".repeat(MB)}`,
    "unclosed restrictions, closed list": `<RestrictionList>${"<CUBE_NAME>".repeat(5000)}</RestrictionList>`,
    "restrictions of many names": `<RestrictionList>${Array.from({ length: 8000 }, (_, i) => `<n${i}>`).join("")}</RestrictionList>`,
    "many opening property lists": "<PropertyList>".repeat(MB / 2),
    "many opening statements": "<Statement ".repeat(MB / 2),
    "many opening statements, each ended": "<Statement>".repeat(MB / 2),
    "an entity a megabyte long": `<Statement>&#x${"1".repeat(MB)};</Statement>`,
    "many entities": `<Statement>${"&amp;".repeat(MB / 2)}</Statement>`,
    "sessions": `<Session ${"SessionId=\"".repeat(MB / 4)}`,
  };
  for (const [what, text] of Object.entries(hostile)) {
    const ms = timed(() => { try { parseRequest(text); } catch (e) { assert.ok(e instanceof Error, what); } });
    assert.ok(ms < 3000, `${what}: ${ms} ms for ${text.length} characters`);
  }
});

test("a restriction list longer than Excel's is refused, and Excel's own still reads", () => {
  const long = `<RestrictionList><CUBE_NAME>${"x".repeat(70_000)}</CUBE_NAME></RestrictionList>`;
  assert.throws(() => parseRequest(long), /restriction list is too long/);
  const r = parseRequest(`<RestrictionList><CATALOG_NAME>c</CATALOG_NAME><CUBE_NAME>Model</CUBE_NAME>
    <MEMBER_UNIQUE_NAME><Value>[a].&amp;[1]</Value><Value>[b]</Value></MEMBER_UNIQUE_NAME><TREE_OP>8</TREE_OP><Empty/><Open>x</RestrictionList>`);
  assert.deepEqual(r.restrictions, { CATALOG_NAME: ["c"], CUBE_NAME: ["Model"], MEMBER_UNIQUE_NAME: ["[a].&[1]", "[b]"], TREE_OP: ["8"] });
});

test("an entity for a character that isn't one is an Error, and every other one reads back", () => {
  assert.throws(() => unesc("&#x110000;"), Error);
  assert.throws(() => unesc("&#99999999999;"), Error);
  for (const s of ["a<b>&\"'", "\u0000\u0001", "é日本😀", "&amp;lt;", "&#x26;"]) {
    // What esc writes, unesc reads back, but for the control characters XML has no place for.
    const back = unesc(esc(s));
    assert.equal(back, s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "�"), JSON.stringify(s));
  }
});

test("fuzz: any text as a request, or as a statement, is answered with an Error or a value", () => {
  const PIECES = ["<", ">", "</", "/>", "Statement", "RestrictionList", "PropertyList", "Catalog", "Value", "Session", "SessionId=\"", "\"", "&", "&#x", "&#", ";",
    "amp;", "lt;", "0", "9", "f", "x", " ", "\n", "[", "]", ".", "&[", "{", "}", "(", ")", ",", "SELECT", "FROM", "WHERE", "ON", "COLUMNS", "ROWS", "NON EMPTY",
    "[Measures]", "[Model]", "Hierarchize", "DrilldownLevel", "CELL PROPERTIES VALUE", "'", "]]", "\u0000", "é"];
  const started = Date.now();
  eachSeed(r => {
    const text = r.text(PIECES, 1 + r.int(60));
    for (const [name, run] of [["parseRequest", () => parseRequest(text)], ["parseSelect", () => parseSelect(text)], ["literal", () => literal(text, r.pick(["string", "int64", "double", "dateTime", "boolean"]))]]) {
      try { run(); }
      catch (e) {
        assert.ok(e instanceof Error, `${name} threw a ${typeof e}`);
        assert.ok(!(e instanceof TypeError) && !(e instanceof ReferenceError), `${name} failed on ${JSON.stringify(text)} with its own mistake: ${e.stack}`);
      }
    }
  }, 4000);
  assert.ok(Date.now() - started < 20_000);
});

// --- members: a few queries at a time ---

const CATALOG = "demo.sales_semanticmodel";
const BIM = { model: { tables: [
  { name: "Sales", columns: [{ name: "amount", dataType: "double", isHidden: true }], measures: [{ name: "Total", expression: "SUM(Sales[amount])" }] },
  { name: "Calendar", columns: [{ name: "year", dataType: "int64" }, { name: "month", dataType: "string" }, { name: "day", dataType: "string" }],
    hierarchies: [{ name: "Calendar", levels: [{ name: "Year", ordinal: 0, column: "year" }, { name: "Month", ordinal: 1, column: "month" }, { name: "Day", ordinal: 2, column: "day" }] }] },
] } };

test("every descendant of a member is asked for a few queries at a time, however many there are", async () => {
  const cube = buildCube(CATALOG, BIM, CATALOG);
  let running = 0, most = 0, asked = 0;
  // A year of 40 months, each of 30 days: 41 queries under one member, 1,240 members.
  const query = async sql => {
    asked++;
    most = Math.max(most, ++running);
    await new Promise(r => setTimeout(r, 2));
    running--;
    const months = /"Calendar"\."month" = '(m\d+)'/.exec(sql);
    const rows = months ? Array.from({ length: 30 }, (_, d) => ({ c0: "2023", c1: months[1], c2: `d${d}` }))
      : Array.from({ length: 40 }, (_, m) => ({ c0: "2023", c1: `m${m}` }));
    return { rows, numRows: rows.length, fields: [] };
  };
  const xml = await discover(cube, "MDSCHEMA_MEMBERS", { MEMBER_UNIQUE_NAME: ["[Calendar].[Calendar].&[2023]"], TREE_OP: ["16"] }, { query, literal });
  assert.equal(asked, 41, "a query for the year's months, and one for each month's days");
  assert.ok(most <= 4, `${most} queries were running at once`);
  assert.equal([...xml.matchAll(/<MEMBER_UNIQUE_NAME>/g)].length, 40 + 40 * 30, "and every member is in the answer");
});

// --- the port ---

async function withServer(backend, run, token = "the-token") {
  let port = 0;
  const said = [];
  const server = http.createServer((req, res) => createHandler({ token, port, backend, log: m => said.push(m) })(req, res));
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  const ask = ({ method = "POST", path = `/${token}/`, headers = {}, body = "" } = {}) => new Promise(resolve => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { "Content-Type": "text/xml", ...headers } }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", e => resolve({ status: 0, error: e.code || e.message }));
    req.end(body);
  });
  try { await run(ask, said, port); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
const refuses = { cube: async () => { throw new Error("no model here"); }, query: async () => { throw new Error("no query here"); } };

test("through the port: nothing that isn't Excel's request reaches the model, and each is answered", async () => {
  let reached = 0;
  const backend = { cube: async () => { reached++; throw new Error("no model here"); }, query: async () => { reached++; throw new Error("no query here"); } };
  await withServer(backend, async ask => {
    // Without the token, or from a browser, or by another name for this machine: refused before the body is read.
    const body = "<Discover><RequestType>MDSCHEMA_CUBES</RequestType></Discover>";
    for (const [what, o, status] of [
      ["no token", { path: "/" }, 404], ["another token", { path: "/the-tokem/" }, 404], ["a longer token", { path: "/the-token-and-more/" }, 404],
      ["the token as a query", { path: "/?the-token" }, 404], ["a second segment", { path: "/the-token/x" }, 404],
      ["an encoded token", { path: "/%74he-token/" }, 404],
      ["an Origin", { headers: { Origin: "http://127.0.0.1" } }, 403], ["an empty Origin", { headers: { Origin: "" } }, 403],
      ["localhost", { headers: { Host: "localhost" } }, 403], ["a rebinding name", { headers: { Host: "evil.example" } }, 403],
      ["PUT", { method: "PUT" }, 405], ["DELETE", { method: "DELETE" }, 405],
      ["JSON", { headers: { "Content-Type": "application/json" } }, 415], ["compressed XML", { headers: { "Content-Type": "application/sx+xpress" } }, 415],
    ]) {
      const r = await ask({ body, ...o });
      assert.equal(r.status, status, `${what}: ${JSON.stringify(r)}`);
    }
    assert.equal(reached, 0, "none of them asked for a model");
  });
});

test("through the port: bodies that are not requests get a fault, and the server goes on answering", async () => {
  await withServer(refuses, async (ask, said) => {
    for (const body of ["", "not xml", "<", "<Statement>", "<Discover><RequestType>NO_SUCH_ROWSET</RequestType></Discover>",
                        "<Execute><Command><Statement>&#x110000;</Statement></Command></Execute>",
                        "<Execute><Command><Statement>DROP TABLE x</Statement></Command></Execute>",
                        `<Discover><RequestType>MDSCHEMA_MEMBERS</RequestType><Restrictions><RestrictionList>${"<a>".repeat(100_000)}</RestrictionList></Restrictions></Discover>`,
                        "\u0000\u0001\u0002", "<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY e SYSTEM \"file:///etc/passwd\">]><Statement>&e;</Statement>"]) {
      const r = await ask({ body });
      assert.equal(r.status, 200, `${JSON.stringify(body.slice(0, 60))}: ${JSON.stringify(r).slice(0, 200)}`);
      assert.match(r.body, /<soap:Fault>|<root /, "a fault Excel can show, or an empty answer");
      assert.ok(!r.body.includes("root:x:"), "and nothing of this machine's files");
    }
    // Still there.
    const again = await ask({ method: "GET" });
    assert.equal(again.status, 200);
    assert.ok(said.length > 0, "each was said in the log");
  });
});

test("through the port: a body past the limit is cut off, not kept", async () => {
  await withServer(refuses, async (ask, _said, port) => {
    const before = process.memoryUsage().rss;
    // 40 MB, sent in pieces: the limit is 32.
    const r = await new Promise(resolve => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/the-token/", headers: { "Content-Type": "text/xml" } },
        res => { res.resume(); res.on("end", () => resolve({ status: res.statusCode })); });
      req.on("error", e => resolve({ error: e.code || e.message }));
      const piece = Buffer.alloc(1024 * 1024, 0x61);
      let sent = 0;
      const more = () => {
        while (sent < 40) { sent++; if (!req.write(piece)) { req.once("drain", more); return; } }
        req.end();
      };
      more();
    });
    assert.ok(r.error || r.status !== 200, `it was not answered as a request: ${JSON.stringify(r)}`);
    assert.ok(process.memoryUsage().rss - before < 200 * 1024 * 1024, "and its megabytes were not all held");
  });
});
