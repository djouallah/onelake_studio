// OneLake Studio as a signed-out user meets it: the vsix CI built, installed in a real VS Code
// server, with its real interface in headless Chrome. Above all the SQL editor's Run and Plan, from
// the editor through the panel and back. What it proves about signing out is proved by a listener:
// the job points OneLake's and Microsoft's hosts here, so any process's attempt to reach them,
// DuckDB's included, shows up in `connections`. Scenario 4 is that listener's control.
//
// CI's "browser" job runs it (.github/workflows/extension.yml), which sets up the server and hosts.
import { spawn, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

import { ACCOUNT, MODEL_QUERY, NEVER_READ, TABLE, WORKSPACE, globalState, seedAccount } from "./fixtures.mjs";

const SERVER = process.env.E2E_SERVER;
const VSIX = process.env.E2E_VSIX;
const DRIVER_VSIX = process.env.E2E_DRIVER_VSIX;
const OUT = process.env.E2E_OUT || join(tmpdir(), "onelake-e2e");
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const HOSTS = (process.env.E2E_HOSTS || "").split(/\s+/).filter(Boolean);
const PORT = 5301;
const DRIVER_PORT = 5302;
const OTHER_SQL_EXTENSIONS = ["ms-mssql.mssql", "ms-ossdata.vscode-pgsql"];

// ---------------------------------------------------------------------------
// What is reported
// ---------------------------------------------------------------------------
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${String(detail).slice(0, 600)}` : ""}`);
  return !!ok;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(200);
  }
  throw new Error(`waited ${timeoutMs} ms for ${what}; last saw: ${JSON.stringify(last)}`);
}

// ---------------------------------------------------------------------------
// Every connection to the hosts the job pointed here. The name is in the TLS hello.
// ---------------------------------------------------------------------------
const connections = [];
const listener = net.createServer(socket => {
  socket.on("error", () => {});
  socket.once("data", data => {
    const text = data.toString("latin1");
    connections.push({ host: HOSTS.find(h => text.includes(h)) || "?", at: new Date().toISOString() });
    socket.destroy();
  });
});
await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(443, "127.0.0.1", resolve); });

// ---------------------------------------------------------------------------
// A window: the server, Chrome on it, and the driver in its extension host
// ---------------------------------------------------------------------------
let shots = 0;
const pageErrors = [];
let server = null, context = null, page = null, logsOf = null;

// What the extension's Output channel holds, over every window on this data.
async function outputLog() {
  const files = await readdir(logsOf, { recursive: true }).catch(() => []);
  const ours = files.filter(f => /OneLake Studio\.log$/.test(f));
  return (await Promise.all(ours.map(f => readFile(join(logsOf, f), "utf8")))).join("\n");
}

// The extension host's own log, over every window on this data: what it activated, and when.
async function hostLog() {
  const files = await readdir(logsOf, { recursive: true }).catch(() => []);
  const ours = files.filter(f => /exthost\.log$/.test(f.replace(/\\/g, "/")));
  return (await Promise.all(ours.map(f => readFile(join(logsOf, f), "utf8")))).join("\n");
}

async function open({ dataDir, home, profile }) {
  logsOf = join(dataDir, "data", "logs");
  server = spawn(join(SERVER, "bin", "code-server"), [
    "--host", "127.0.0.1", "--port", String(PORT), "--without-connection-token",
    "--accept-server-license-terms", "--disable-telemetry",
    "--server-data-dir", dataDir, "--extensions-dir", join(OUT, "extensions"),
  ], { env: { ...process.env, HOME: home, E2E_DRIVER_PORT: String(DRIVER_PORT) }, detached: true, stdio: "ignore" });
  await until("the VS Code server", () => fetch(`http://127.0.0.1:${PORT}/`).then(r => r.ok), 60000);

  context = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME, headless: true, viewport: { width: 1600, height: 1000 },
  });
  // Any dialog the window ever shows, whenever it comes and goes: that is what a prompt is.
  await context.addInitScript(() => {
    window.__dialogs = [];
    new MutationObserver(list => {
      for (const m of list) for (const n of m.addedNodes) {
        const box = n.nodeType === 1 && (n.matches?.(".monaco-dialog-box") ? n : n.querySelector?.(".monaco-dialog-box"));
        if (box) window.__dialogs.push(box.innerText);
      }
    }).observe(document, { childList: true, subtree: true });
  });
  page = context.pages()[0] || await context.newPage();
  page.on("pageerror", e => { pageErrors.push(`${e.message}\n${e.stack || ""}`); });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  await until("the extension to activate", async () => (await drive("state")).active, 90000);
  await drive("exec", { command: "workbench.view.extension.onelakeStudio" });
}

async function close() {
  await context?.close().catch(() => {});
  if (server) {
    const gone = new Promise(r => server.once("exit", r));
    try { process.kill(-server.pid, "SIGTERM"); } catch (_) {}
    await Promise.race([gone, sleep(10000)]);
  }
  server = context = page = null;
}

async function drive(op, args = {}) {
  const res = await fetch(`http://127.0.0.1:${DRIVER_PORT}/`, { method: "POST", body: JSON.stringify({ op, ...args }) });
  const answer = await res.json();
  if (!res.ok) throw new Error(`${op}: ${answer.error}`);
  return answer;
}

// A step that fails, or hangs, is one failed check: the rest still runs, and says what it says.
async function step(name, fn, timeoutMs = 120000) {
  console.log(`--- ${name}`);
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no end in ${timeoutMs} ms`)), timeoutMs); })]);
  } catch (e) {
    check(name, false, e.message);
  } finally {
    clearTimeout(timer);
    const file = `${String(++shots).padStart(3, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.png`;
    await page?.screenshot({ path: join(OUT, "shots", file) }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Reading the window
// ---------------------------------------------------------------------------
const sidebarTitle = () => page.locator(".part.sidebar .composite.title .title-label h2").first().innerText();
const dialogsSeen = () => page.evaluate(() => window.__dialogs);
const toasts = () => page.locator(".notifications-toasts .notification-list-item-message").allInnerTexts();
const onelakeStatus = () => page.locator(".part.statusbar .statusbar-item").allInnerTexts()
  .then(all => all.filter(t => /OneLake/.test(t)));

// What the eye gets: VS Code cuts a title too long for the header with "...", and the DOM still holds it all.
const titleFits = () => page.locator(".part.sidebar .composite.title .title-label h2").first()
  .evaluate(h => h.scrollWidth <= h.clientWidth);

async function expectOffline(label) {
  const title = await until(`${label}: the title`, async () => {
    const t = await sidebarTitle();
    return /^onelake studio: offline$/i.test(t) && t;
  }, 20000).catch(e => e.message);
  check(`${label}: the sidebar's title says OneLake Studio and offline`, /^onelake studio: offline$/i.test(title), title);
  check(`${label}: all of the title can be read`, await titleFits());
}

async function panel() {
  return until("the panel's page", async () => {
    for (const f of page.frames()) {
      if (f.isDetached()) continue;
      if (await f.locator("#status").count().catch(() => 0)) return f;
    }
    return null;
  }, 60000);
}

const isError = s => /\berror\b/.test(s.cls);
const panelState = async () => (await panel()).evaluate(() => {
  const $ = id => document.getElementById(id);
  const shown = el => !!el && !el.hidden;
  return {
    status: $("status").textContent, cls: $("status").className,
    stop: shown($("stopBtn")),
    table: shown($("resultsTable")) ? $("resultsTable").innerText.slice(0, 2000) : "",
    plan: shown($("planView")), planText: shown($("planView")) ? $("planView").innerText.slice(0, 2000) : "",
    viewBar: shown($("viewBar")),
    planError: !!$("planView").querySelector(".ex-error"),
    profileDrawn: !!$("planView").querySelector(".pf"),
  };
});

const cell = (re, timeoutMs = 60000) => until(`a result matching ${re}`, async () => {
  const s = await panelState();
  return re.test(s.table) && s;
}, timeoutMs);

// A statement, by the command a query's editor runs. The command's promise is the editor's wait
// for the panel's answer: if it never settles, the editor never hears.
async function runIt(text, { plan = false, cursor = null, selection = null, timeoutMs = 60000 } = {}) {
  await drive("setText", { text, cursor, selection });
  const r = await drive("exec", { command: plan ? "onelakeStudio.planQuery" : "onelakeStudio.runQuery", timeoutMs });
  return { ...r, ...await panelState() };
}
const settled = (name, r) => check(`${name}: the editor heard the answer`, r.settled === "settled", `${r.settled} in ${r.ms} ms; status: ${r.status}`);

const button = name => page.locator(`.editor-actions .action-label[aria-label^="${name}"]:visible`).first();
const lens = name => page.locator(".codelens-decoration a", { hasText: name }).first();
const focusEditor = () => page.locator(".editor-instance .monaco-editor .view-lines:visible").first().click();

// ---------------------------------------------------------------------------
// The SQL editor's Run
// ---------------------------------------------------------------------------
async function runMatrix() {
  await step("Run: the first statement, by Ctrl+Enter", async () => {
    await drive("setText", { text: "select 101 as first_one" });
    await focusEditor();
    await page.keyboard.press("Control+Enter");
    const s = await cell(/\b101\b/, 120000);
    check("Ctrl+Enter ran it", !isError(s), s.status);
    check("Stop is gone when it ends", !s.stop);
  }, 180000);

  await step("Run: the title bar's button", async () => {
    await drive("setText", { text: "select 102 as by_button" });
    await button("OneLake Run").click();
    check("the button ran it", !!await cell(/\b102\b/));
  });

  await step("Run: the CodeLens", async () => {
    await drive("setText", { text: "select 103 as by_lens" });
    await lens("OneLake Run").click({ timeout: 20000 });
    check("the lens ran it", !!await cell(/\b103\b/));
  });

  await step("Run: the statement under the cursor", async () => {
    const text = "select 111 as one;\nselect 222 as two;\nselect 333 as three;";
    const r = await runIt(text, { cursor: text.indexOf("222") });
    settled("under the cursor", r);
    check("only that statement ran", /\b222\b/.test(r.table) && !/\b111\b|\b333\b/.test(r.table), r.table);
  });

  await step("Run: a selection", async () => {
    const text = "select 444 as one; select 555 as two";
    const start = text.indexOf("select 555");
    const r = await runIt(text, { selection: [start, text.length] });
    settled("a selection", r);
    check("only the selection ran", /\b555\b/.test(r.table) && !/\b444\b/.test(r.table), r.table);
  });

  for (const [name, bad] of [["a syntax error", "select 2 fromm where"], ["a word that starts no statement", "selct 2"]]) {
    await step(`Run: ${name}`, async () => {
      const r = await runIt(`select 1;\n\n${bad};`, { cursor: 12 });
      settled(name, r);
      check(`${name}: the status bar is red`, isError(r), r.status);
      check(`${name}: the old result is gone`, !r.table, r.table);
      const d = await drive("diagnostics");
      check(`${name}: a diagnostic sits on the statement's line`, d.length === 1 && d[0].line === 2, JSON.stringify(d));
      if (name === "a syntax error") check("it sits on the wrong word", d[0]?.character === bad.indexOf("where"), JSON.stringify(d));
    });
  }

  await step("Run: an edit clears the diagnostic, and the next run works", async () => {
    const r = await runIt("select 601 as fixed");
    settled("after an error", r);
    check("it ran", /\b601\b/.test(r.table), r.status);
    check("the diagnostic is gone", (await drive("diagnostics")).length === 0);
  });

  await step("Run: SET VARIABLE and getvariable", async () => {
    await drive("setText", { text: "SET VARIABLE e2e_a = 7" });
    const set = await drive("exec", { command: "onelakeStudio.runQuery" });
    check("SET VARIABLE is answered", set.settled === "settled", JSON.stringify(set));
    const r = await runIt("select getvariable('e2e_a') + 1 as v");
    check("getvariable reads it", /\b8\b/.test(r.table), r.table || r.status);
  });

  await step("Run: a variable never set asks, and the answer is kept", async () => {
    await drive("setText", { text: "select getvariable('e2e_b') as v" });
    const pending = drive("exec", { command: "onelakeStudio.runQuery" });
    const box = page.locator(".quick-input-widget input:visible").first();
    await box.waitFor({ timeout: 20000 });
    await box.fill("55");
    await page.keyboard.press("Enter");
    settled("a typed variable", { ...await pending, status: "" });
    check("the value reached the query", !!await cell(/\b55\b/));
  });

  await step("Run: cancelling a variable's box stops the run", async () => {
    await drive("setText", { text: "select getvariable('e2e_c') as v" });
    const pending = drive("exec", { command: "onelakeStudio.runQuery" });
    const box = page.locator(".quick-input-widget input:visible").first();
    await box.waitFor({ timeout: 20000 });
    await box.press("Escape");
    const r = await pending;
    check("the editor is not left waiting", r.settled === "settled", JSON.stringify(r));
  });

  await step("Run: Stop", async () => {
    await drive("setText", { text: "select sum(i) from range(100000000000000) t(i)" });
    const pending = drive("exec", { command: "onelakeStudio.runQuery", timeoutMs: 60000 });
    const f = await panel();
    await until("the Stop button", async () => (await panelState()).stop, 20000);
    await f.locator("#stopBtn").click();
    const r = await pending;
    check("Stop ended it", r.settled === "settled", JSON.stringify(r));
    const s = await panelState();
    check("the status says stopped, not failed", /stopped/i.test(s.status) && !isError(s), s.status);
    check("Stop is gone", !s.stop);
  }, 90000);

  await step("Run: a run while another is running", async () => {
    await drive("setText", { text: "select sum(i) from range(100000000000000) t(i)" });
    const slow = drive("exec", { command: "onelakeStudio.runQuery", timeoutMs: 60000 });
    await until("the slow one to start", async () => (await panelState()).stop, 20000);
    const r = await runIt("select 701 as newer");
    settled("the newer run", r);
    check("the newer one owns the pane", /\b701\b/.test(r.table), r.table || r.status);
    const old = await slow;
    check("the older one was let go", old.settled === "settled", JSON.stringify(old));
    const s = await panelState();
    check("nothing is left running", !s.stop, s.status);
  }, 120000);

  await step("Run: two editors keep their own results", async () => {
    const a = await drive("setText", { text: "select 801 as a" });
    await drive("exec", { command: "onelakeStudio.runQuery" });
    const b = await drive("newQuery");
    const rb = await runIt("select 802 as b");
    check("the second editor shows its own", /\b802\b/.test(rb.table), rb.table);
    await drive("show", { uri: a.uri });
    check("the first editor's comes back", !!await cell(/\b801\b/, 15000).catch(() => false),
      (await panelState()).table);
    await drive("show", { uri: b.uri });
    check("and the second's", !!await cell(/\b802\b/, 15000).catch(() => false), (await panelState()).table);
    await drive("show", { uri: a.uri });
  });

  for (const [name, sql] of [["CREATE TABLE", "create table e2e_t (a int)"], ["a local file", "select * from read_text('/etc/hostname')"]]) {
    await step(`Run: ${name} is refused`, async () => {
      const r = await runIt(sql);
      settled(name, r);
      check(`${name} is refused`, isError(r), r.status);
      check(`${name}: the editor marks it`, (await drive("diagnostics")).length === 1);
    });
  }

  await step("Run: an empty query says so", async () => {
    await drive("setText", { text: "   " });
    const r = await drive("exec", { command: "onelakeStudio.runQuery" });
    check("nothing to run ends at once", r.settled === "settled" && r.ms < 5000, JSON.stringify(r));
  });
}

// What only an account's cache can answer.
async function cachedRunMatrix({ saved }) {
  await step("Run: SHOW ALL TABLES from the cache", async () => {
    const r = await runIt("SHOW ALL TABLES");
    settled("SHOW ALL TABLES", r);
    check("it lists the cached tables, by their whole names", /orders/.test(r.table) && r.table.includes(WORKSPACE), r.table || r.status);
  });

  await step("Run: a saved query", async () => {
    const before = await drive("openFile", { path: saved });
    const r = await drive("exec", { command: "onelakeStudio.runQuery" });
    settled("a saved query", { ...r, status: "" });
    check("it ran", !!await cell(/from a saved query/), before.uri);
    await drive("newQuery");
  });

  await step("Run: a table whose rows were never read says so at once", async () => {
    const r = await runIt(`select * from ${NEVER_READ}`);
    settled("a table never read", r);
    check("it ends at once, not on a timeout", r.ms < 15000, `${r.ms} ms`);
    check("the status is an error", isError(r), r.status);
    check("it says why", /cache|offline|sign/i.test(r.status), r.status);
    check("the editor marks it", (await drive("diagnostics")).length === 1);
  });

  await step("Run: a table whose metadata is held, with no rows", async () => {
    const r = await runIt(`select count(*) from ${TABLE}`);
    settled("a table with metadata only", r);
    check("it ends at once, not on a timeout", r.ms < 15000, `${r.ms} ms`);
    check("the status is an error", isError(r), r.status);
    check("it says why", /cache|offline|sign/i.test(r.status), r.status);
  });

  await step("Run: a semantic model's query, with no rows held", async () => {
    const r = await runIt(MODEL_QUERY);
    settled("a model query", r);
    check("it stops where the rows aren't held, past the compiler", isError(r) && /isn't cached/.test(r.status) && !/AGG|Catalog Error|Binder/.test(r.status), r.status);
    check("the model opened from its local copy", /opened semanticmodel\.e2e\.shop for a query/.test(await outputLog()));
    check("it ends at once, not on a timeout", r.ms < 30000, `${r.ms} ms`);
    check("the editor marks it", (await drive("diagnostics")).length === 1);
  });
}

// ---------------------------------------------------------------------------
// The SQL editor's Plan
// ---------------------------------------------------------------------------
const planned = () => until("the profile, or its error", async () => {
  const s = await panelState();
  return (s.profileDrawn || s.planError) && s;
}, 60000);

async function planMatrix() {
  await step("Plan: a statement, by the title bar's button", async () => {
    await drive("setText", { text: "select 901 as planned" });
    await button("OneLake Plan").click();
    const s = await planned();
    check("the plan view is on screen", s.plan);
    check("the profile is drawn, with no error", s.profileDrawn && !s.planError, s.planText);
    check("it shows timings and operators", /Timeline/.test(s.planText) && /Most expensive operators/.test(s.planText), s.planText);
    check("the table's tabs stepped aside", !s.viewBar);
    check("no result is left on screen", !s.table, s.table);
  });

  await step("Plan: the CodeLens", async () => {
    await drive("setText", { text: "select 902 as lens_planned" });
    await lens("OneLake Plan").click({ timeout: 20000 });
    const s = await planned();
    check("the lens drew a profile", s.profileDrawn && !s.planError, s.planText);
  });

  await step("Plan: the Tree tab", async () => {
    const f = await panel();
    await f.locator('.pf-tab[data-view="tree"]').click();
    const text = await until("the plan's tree", async () => {
      const t = await f.locator("pre.sm-plan").innerText().catch(() => "");
      return t.trim() && t;
    }, 30000);
    check("the tree holds DuckDB's plan", /projection|dummy_scan/i.test(text), text.slice(0, 200));
    await f.locator('.pf-tab[data-view="profile"]').click();
    check("back on the Profile, it is not measured again", await f.locator(".pf").isVisible());
  });

  await step("Plan: a Run afterwards puts results back", async () => {
    const r = await runIt("select 903 as after_plan");
    settled("a Run after a Plan", r);
    check("the result is back", /\b903\b/.test(r.table), r.table || r.status);
    check("the plan is gone", !r.plan);
  });

  await step("Plan: a real query's operators", async () => {
    const r = await runIt("select i % 10 as d, count(*) as n from range(100000) t(i) group by all order by 1", { plan: true });
    settled("a query's plan", r);
    const s = await planned();
    check("the profile names its operators", /AGGREGATE|RANGE|ORDER|TOP_N/i.test(s.planText), s.planText);
  });

  await step("Plan: bad SQL reaches the editor", async () => {
    const r = await runIt("select 1;\n\nselect 2 fromm where;", { plan: true, cursor: 12 });
    settled("bad SQL's plan", r);
    const d = await drive("diagnostics");
    check("the editor marks the line", d.length === 1 && d[0].line === 2, JSON.stringify(d));
    check("it sits on the wrong word", d[0]?.character === "select 2 fromm where".indexOf("where"), JSON.stringify(d));
    check("the message doesn't speak of the EXPLAIN behind it", !/EXPLAIN/.test(d[0]?.message || ""), JSON.stringify(d));
    check("the status bar is red", isError(r), r.status);
    check("no plan is left on screen", !r.plan, r.planText);
  });

  await step("Plan: a query that fails only when run", async () => {
    const r = await runIt("select 1 / cast(i::varchar || 'x' as int) from range(3) t(i)", { plan: true });
    settled("a failure at run time", r);
    const s = await planned();
    check("the view says why", s.planError, s.planText);
    const red = await until("the status", async () => {
      const x = await panelState();
      return isError(x) && x;
    }, 10000).catch(() => s);
    check("the status bar is red", isError(red), red.status);
  });

  await step("Plan: empty says so", async () => {
    await drive("setText", { text: "   " });
    const r = await drive("exec", { command: "onelakeStudio.planQuery" });
    check("nothing to plan ends at once", r.settled === "settled" && r.ms < 5000, JSON.stringify(r));
  });

  await step("Plan: while another is measured, it says wait", async () => {
    await drive("setText", { text: "select sum(i) from range(20000000000) t(i)" });
    const slow = drive("exec", { command: "onelakeStudio.planQuery", timeoutMs: 120000 });
    await until("the first plan's view", async () => (await panelState()).plan, 20000);
    const r = await runIt("select 904", { plan: true });
    settled("the second plan", r);
    check("it says wait", /still being measured/i.test(r.status), r.status);
    await slow;
    await until("the first profile to end", async () => {
      const s = await panelState();
      return s.profileDrawn || s.planError;
    }, 180000);
  }, 240000);
}

async function cachedPlanMatrix() {
  await step("Plan: a table whose rows were never read", async () => {
    const r = await runIt(`select * from ${NEVER_READ}`, { plan: true });
    settled("a table never read", r);
    check("it ends at once, not on a timeout", r.ms < 15000, `${r.ms} ms`);
    check("it says why, in red", isError(r) && /cache|offline|sign/i.test(r.status), r.status);
    check("the editor marks it", (await drive("diagnostics")).length === 1);
    check("no plan is left on screen", !r.plan, r.planText);
  });

  await step("Plan: a semantic model's query, with no rows held", async () => {
    const r = await runIt(MODEL_QUERY, { plan: true });
    settled("a model's plan", r);
    check("it stops where the rows aren't held, past the compiler", isError(r) && /isn't cached/.test(r.status) && !/AGG|Catalog Error|Binder/.test(r.status), r.status);
    check("the editor marks it", (await drive("diagnostics")).length === 1);
    check("no plan is left on screen", !r.plan, r.planText);
  });
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------
async function main() {
  await mkdir(join(OUT, "shots"), { recursive: true });
  await mkdir(join(OUT, "extensions"), { recursive: true });
  const installEnv = { ...process.env, HOME: await mkdtemp(join(tmpdir(), "e2e-home-")) };
  const install = extension => promisify(execFile)(join(SERVER, "bin", "code-server"), [
    "--accept-server-license-terms", "--server-data-dir", join(OUT, "install"),
    "--extensions-dir", join(OUT, "extensions"), "--install-extension", extension, "--force",
  ], { env: installEnv, maxBuffer: 1 << 24 });
  for (const vsix of [VSIX, DRIVER_VSIX]) await install(vsix);
  console.log("installed:", await readdir(join(OUT, "extensions")));

  const place = async name => {
    const dir = join(OUT, name);
    const home = join(dir, "home"), dataDir = join(dir, "data"), profile = join(dir, "chrome");
    await mkdir(home, { recursive: true });
    return { home, dataDir, profile };
  };

  // ------------------------------------------------------------------- 1
  console.log("\n=== 1. Never signed in");
  const first = await place("fresh");
  await open(first);
  await step("Never signed in: what the window shows", async () => {
    await expectOffline("never signed in");
    const welcome = await page.locator(".part.sidebar .welcome-view").innerText();
    check("the welcome view offers a sign-in", /Sign in to OneLake/.test(welcome), welcome);
    check("nothing prompted at startup", (await dialogsSeen()).length === 0, (await dialogsSeen()).join(" | "));
  });
  await step("Never signed in: Run asks for an account, and cancelling leaves nothing stuck", async () => {
    await drive("newQuery");
    await drive("setText", { text: "select 42" });
    const pending = drive("exec", { command: "onelakeStudio.runQuery", timeoutMs: 60000 });
    const dialog = page.locator(".monaco-dialog-box");
    const asked = await dialog.waitFor({ timeout: 20000 }).then(() => true, () => false);
    if (asked) await dialog.locator(".dialog-buttons a, .dialog-buttons button", { hasText: /cancel/i }).first().click();
    const r = await pending;
    check("the editor is not left waiting", r.settled === "settled", JSON.stringify(r));
    const said = await until("the warning", async () => {
      const list = await toasts();
      return list.find(t => /needs a Microsoft account/.test(t));
    }, 20000).catch(() => (toasts()));
    check("it says an account is needed", /needs a Microsoft account/.test(String(said)), said);
  }, 120000);

  // ------------------------------------------------------------------- 2
  console.log("\n=== 2. Sign Out, then a new VS Code");
  await step("Sign Out: the command", async () => {
    const r = await drive("exec", { command: "onelakeStudio.signOut" });
    check("it runs", r.settled === "settled", JSON.stringify(r));
    await sleep(3000);
    const state = await globalState(page);
    check("the decision is written down", state?.["onelakeStudio.signedOut"] === true, JSON.stringify(state));
  });
  await close();
  let mark = connections.length;
  await open(first);
  await step("Signed out, new VS Code: nothing asked, nothing sent", async () => {
    await expectOffline("after a restart");
    const state = await globalState(page);
    check("the decision survived", state?.["onelakeStudio.signedOut"] === true, JSON.stringify(state));
    await sleep(10000);
    check("nothing prompted", (await dialogsSeen()).length === 0, (await dialogsSeen()).join(" | "));
    check("nothing reached OneLake or Microsoft", connections.length === mark, JSON.stringify(connections.slice(mark)));
  });
  await step("Signed out, new VS Code: Run opens with no prompt", async () => {
    await drive("newQuery");
    const r = await runIt("select 42 as answer", { timeoutMs: 120000 });
    settled("signed out", r);
    check("it answered, with no sign-in", /\b42\b/.test(r.table), r.table || r.status);
    check("nothing prompted", (await dialogsSeen()).length === 0, (await dialogsSeen()).join(" | "));
    const state = await globalState(page);
    check("the decision still stands", state?.["onelakeStudio.signedOut"] === true, JSON.stringify(state));
    const tabs = (await drive("state")).tabs;
    check("the panel's tab says OneLake Studio and offline", tabs.includes("OneLake Studio: offline"), tabs.join(", "));
  }, 180000);
  await step("Signed out, new VS Code: Plan opens with no prompt", async () => {
    await runIt("select 43 as answer", { plan: true });
    const s = await planned();
    check("the profile is drawn", s.profileDrawn && !s.planError, s.planText);
    check("nothing reached OneLake or Microsoft, after all that", connections.length === mark, JSON.stringify(connections.slice(mark)));
  });
  await close();

  // ------------------------------------------------------------------- 3
  console.log("\n=== 3. Signed out, with an account's cache on this machine");
  const cached = await place("cached");
  const { saved } = await seedAccount(cached);
  // The first start only makes the state to add to: an account known, and signed out.
  await open(cached);
  await step("Cached: the account is on this machine", async () => {
    await drive("exec", { command: "onelakeStudio.signOut" });
    await sleep(3000);
    const state = await globalState(page, { "onelakeStudio.lastAccount": ACCOUNT });
    check("the account is written in", state?.["onelakeStudio.lastAccount"]?.key === ACCOUNT.key, JSON.stringify(state));
  });
  await close();
  mark = connections.length;
  await open(cached);
  await step("Cached: the tree comes from the cache", async () => {
    await expectOffline("signed out with a cache");
    const rows = await until("the tree's rows", async () => {
      const t = await page.locator(".part.sidebar .monaco-list-row").allInnerTexts();
      return t.some(x => x.includes(WORKSPACE)) && t;
    }, 30000);
    check("the workspace is listed", rows.some(x => x.includes(WORKSPACE)), rows.join(" | "));
    check("the saved queries are listed", rows.some(x => /quer/i.test(x)), rows.join(" | "));
    check("nothing prompted", (await dialogsSeen()).length === 0);
  });
  await step("Cached: a new query", async () => { await drive("newQuery"); });
  await runMatrix();
  await cachedRunMatrix({ saved });
  await planMatrix();
  await cachedPlanMatrix();
  await step("Cached: after all of it", async () => {
    check("nothing reached OneLake or Microsoft", connections.length === mark, JSON.stringify(connections.slice(mark)));
    check("nothing prompted", (await dialogsSeen()).length === 0, (await dialogsSeen()).join(" | "));
    const tabs = (await drive("state")).tabs;
    check("the panel's tab says OneLake Studio and offline", tabs.includes("OneLake Studio: offline"), tabs.join(", "));
  });
  // Scenario 4's state, in the same browser.
  await globalState(page, { "onelakeStudio.signedOut": false });
  await close();

  // ------------------------------------------------------------------- 4
  console.log("\n=== 4. Control: not signed out, and no internet");
  mark = connections.length;
  await open(cached);
  await step("Control: the startup probe reaches the listener", async () => {
    const hit = await until("a connection", async () => connections.length > mark && connections[mark], 30000).catch(() => null);
    check("the listener saw the probe, so its silence above means something", !!hit, JSON.stringify(connections.slice(mark)));
    check("the probe went to OneLake", hit?.host === "onelake.dfs.fabric.microsoft.com", JSON.stringify(hit));
  });
  await step("Control: it knows it is offline, and why", async () => {
    await expectOffline("no internet");
    const said = await until("the status bar", async () => (await onelakeStatus()).find(t => /no internet/.test(t)), 30000)
      .catch(() => onelakeStatus());
    check("the status bar says no internet", /offline \(no internet\)/.test(String(said)), said);
  });
  await step("Control: Run and Plan still work", async () => {
    await drive("newQuery");
    const r = await runIt("select 77 as still_works", { timeoutMs: 120000 });
    settled("no internet", r);
    check("Run answered", /\b77\b/.test(r.table), r.table || r.status);
    await runIt("select 78", { plan: true });
    const s = await planned();
    check("Plan drew a profile", s.profileDrawn && !s.planError, s.planText);
  }, 180000);
  await close();

  // ------------------------------------------------------------------- 5
  // Every extension shares the host's one thread, and opening a .sql file starts the SQL extensions.
  // A click on Run waits behind them, so what counts is how long a click takes to be answered.
  console.log("\n=== 5. Beside the SQL extensions many people have");
  const othersInstalled = await Promise.all(OTHER_SQL_EXTENSIONS.map(install)).then(() => true, e => e.message);
  check("the other SQL extensions installed", othersInstalled === true, othersInstalled);
  await open(cached);
  await step("Beside them: a click on Run, on a query just opened", async () => {
    await globalState(page, { "onelakeStudio.signedOut": true });
    const t0 = Date.now();
    await drive("newQuery");
    const opened = Date.now() - t0;
    await drive("setText", { text: "select 5555 as beside_them" });
    const clicked = Date.now();
    await button("OneLake Run").click();
    const s = await cell(/\b5555\b/, 180000);
    const ms = Date.now() - clicked;
    const { language } = await drive("state");
    const log = await hostLog();
    const started = OTHER_SQL_EXTENSIONS.filter(x => log.includes(`_doActivateExtension ${x}`));
    console.log(`  opening took ${opened} ms, the click ${ms} ms; language ${language}; started: ${started.join(", ") || "none"}`);
    check("it answered within 15 s of the click", ms < 15000, `${ms} ms; language ${language}; started: ${started.join(", ") || "none"}; ${s.status}`);
  }, 240000);
  await close();

  const ours = pageErrors.filter(e => /vscode-resource|vscode-cdn|\/app\/|\/webview\//.test(e));
  check("the panel's page threw nothing", ours.length === 0, ours.slice(0, 5).join("\n---\n"));
}

let crashed = null;
await main().catch(e => { crashed = e; console.error("the run itself failed:", e); });
await close().catch(() => {});
listener.close();

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
for (const f of failed) console.log(`FAILED: ${f.name}${f.detail ? `\n  ${f.detail.slice(0, 1200)}` : ""}`);
process.exit(failed.length || crashed ? 1 : 0);
