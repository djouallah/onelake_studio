// OneLake Studio as a signed-out user meets it: the vsix CI built, installed in a real VS Code
// server, with its real interface in headless Chrome. Above all the panel's SQL box: Run and Plan
// through to the answer. What it proves about signing out is proved by a listener: the job points
// OneLake's and Microsoft's hosts here, so any process's attempt to reach them, DuckDB's included,
// shows up in `connections`. Scenario 4 is that listener's control.
//
// CI's "browser" job runs it (.github/workflows/extension.yml), which sets up the server and hosts.
import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

import { ACCOUNT, MODEL_QUERY, NEVER_READ, REPORT_KEY, TABLE, WORKSPACE, globalState, seedAccount } from "./fixtures.mjs";

const SERVER = process.env.E2E_SERVER;
const VSIX = process.env.E2E_VSIX;
const DRIVER_VSIX = process.env.E2E_DRIVER_VSIX;
const OUT = process.env.E2E_OUT || join(tmpdir(), "onelake-e2e");
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const HOSTS = (process.env.E2E_HOSTS || "").split(/\s+/).filter(Boolean);
const PORT = 5301;
const DRIVER_PORT = 5302;
const OTHER_SQL_EXTENSIONS = ["ms-mssql.mssql", "ms-ossdata.vscode-pgsql"];
const FOREVER = "select sum(i) from range(100000000000000) t(i)";

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
    await sleep(100);
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

// The extension host's own log, over every window on this data: what it activated, and when.
async function hostLog() {
  const files = await readdir(logsOf, { recursive: true }).catch(() => []);
  const ours = files.filter(f => /exthost\.log$/.test(f.replace(/\\/g, "/")));
  return (await Promise.all(ours.map(f => readFile(join(logsOf, f), "utf8")))).join("\n");
}

// What the extension's Output channel holds, over every window on this data.
async function outputLog() {
  const files = await readdir(logsOf, { recursive: true }).catch(() => []);
  const ours = files.filter(f => /OneLake Studio\.log$/.test(f));
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

// The tab on top: every tab's page stays loaded, so of those with a page it is the newest whose
// frames are all on screen. Failing that, the newest.
async function onScreen(f) {
  for (let at = f; at && at.parentFrame(); at = at.parentFrame()) {
    const el = await at.frameElement().catch(() => null);
    if (!el || !await el.isVisible().catch(() => false)) return false;
  }
  return true;
}
async function panel() {
  return until("the panel's page", async () => {
    let newest = null;
    for (const f of [...page.frames()].reverse()) {
      if (f.isDetached() || !await f.locator("#status").count().catch(() => 0)) continue;
      if (await onScreen(f)) return f;
      newest = newest || f;
    }
    return newest;
  }, 60000);
}

const isError = s => /\berror\b/.test(s.cls);
const panelState = async () => (await panel()).evaluate(() => {
  const $ = id => document.getElementById(id);
  const shown = el => !!el && !el.hidden;
  return {
    status: $("status").textContent, cls: $("status").className,
    stop: shown($("stopBtn")),
    title: $("activeTable").textContent,
    box: $("sqlEditor").value,
    caret: $("sqlEditor").selectionStart === $("sqlEditor").selectionEnd ? $("sqlEditor").selectionStart : null,
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

// The panel, opened by what opens it, and past its landing page.
async function openPanel(command = "onelakeStudio.newQuery", args = []) {
  const r = await drive("exec", { command, args, timeoutMs: 120000 });
  await until("DuckDB to be ready", async () => /DuckDB ready/.test((await panelState()).status), 120000);
  return r;
}

async function setBox(text, { cursor = null, selection = null } = {}) {
  const f = await panel();
  await f.locator("#sqlEditor").fill(text);
  await f.evaluate(({ cursor, selection }) => {
    const b = document.getElementById("sqlEditor");
    b.focus();
    if (selection) b.setSelectionRange(selection[0], selection[1]);
    else b.setSelectionRange(cursor ?? 0, cursor ?? 0);
  }, { cursor, selection });
}

// Something done in the panel, and its end: the status line, emptied first, says something other
// than that it is still at it, and Stop has gone.
async function act(trigger, timeoutMs = 60000) {
  const f = await panel();
  await f.evaluate(() => { document.getElementById("status").textContent = ""; });
  const t0 = Date.now();
  await trigger(f);
  const settled = await until("the status line", async () => {
    const s = await panelState();
    return s.status && !/^(Running|Planning|Opening|Stopping)/.test(s.status) && !s.stop;
  }, timeoutMs).then(() => "settled", e => e.message);
  return { settled, ms: Date.now() - t0, ...await panelState() };
}
const runIt = async (text, { plan = false, cursor = null, selection = null, timeoutMs = 60000 } = {}) => {
  await setBox(text, { cursor, selection });
  return act(f => f.locator(plan ? "#planBtn" : "#runBtn").click(), timeoutMs);
};
const settled = (name, r) => check(`${name}: it ended`, r.settled === "settled", `${r.settled} in ${r.ms} ms; status: ${r.status}`);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
async function runMatrix() {
  await step("Run: by Ctrl+Enter", async () => {
    await setBox("select 101 as first_one");
    const f = await panel();
    await f.locator("#sqlEditor").press("Control+Enter");
    const s = await cell(/\b101\b/);
    check("Ctrl+Enter ran it", !isError(s), s.status);
    check("Stop is gone when it ends", !s.stop);
  });

  await step("Run: the button", async () => {
    const r = await runIt("select 102 as by_button");
    settled("the button", r);
    check("the button ran it", /\b102\b/.test(r.table), r.table || r.status);
    check("the box keeps its text", r.box === "select 102 as by_button", r.box);
  });

  await step("Run: a double click is one click, and a cell still opens whole", async () => {
    // What DuckDB was asked, by a mark split so that asking doesn't count as one.
    const asked = async mark => {
      await page.waitForTimeout(1000);
      const r = await runIt(`select 'asked=' || count(*) as c from duckdb_logs where type = 'Quack' and message like '%PREPARE_REQUEST%${mark}' || '_mark%'`);
      return Number((/asked=(\d+)/.exec(r.table) || [])[1]);
    };
    const once = await runIt("select 1041 as e2e_once_mark");
    check("one click ran it", /\b1041\b/.test(once.table), once.table || once.status);
    const twice = await act(async f => {
      await setBox("select 1042 as e2e_twice_mark");
      await f.locator("#runBtn").dblclick();
    });
    check("a double click ran it", /\b1042\b/.test(twice.table), twice.table || twice.status);
    const [one, two] = [await asked("e2e_once"), await asked("e2e_twice")];
    check("as many statements as one click", one > 0 && two === one, `${one} and ${two}`);

    const f = await panel();
    await f.locator("td[data-c]").first().dblclick();
    await f.locator("#inspector").waitFor({ state: "visible", timeout: 5000 });
    check("the inspector shows the cell", /asked=/.test(await f.locator("#inspectorBody").innerText()));
    await f.locator("#inspectorClose").click();
  });

  await step("Run: the statement under the cursor", async () => {
    const text = "select 111 as one;\nselect 222 as two;\nselect 333 as three;";
    const r = await runIt(text, { cursor: text.indexOf("222") });
    settled("under the cursor", r);
    check("only that statement ran", /\b222\b/.test(r.table) && !/\b111\b|\b333\b/.test(r.table), r.table);
  });

  await step("Run: a selection", async () => {
    const text = "select 444 as one; select 555 as two";
    const r = await runIt(text, { selection: [text.indexOf("select 555"), text.length] });
    settled("a selection", r);
    check("only the selection ran", /\b555\b/.test(r.table) && !/\b444\b/.test(r.table), r.table);
  });

  await step("Run: a syntax error", async () => {
    const bad = "select 2 fromm where";
    const text = `select 1;\n\n${bad};`;
    const r = await runIt(text, { cursor: 12 });
    settled("a syntax error", r);
    check("the status line is red", isError(r), r.status);
    check("the old result is gone", !r.table, r.table);
    check("the cursor goes to the wrong word", r.caret === text.indexOf("where"), `at ${r.caret}, want ${text.indexOf("where")}`);
  });

  await step("Run: Ctrl+Enter again runs the statement, not one word", async () => {
    const f = await panel();
    const r = await act(() => f.locator("#sqlEditor").press("Control+Enter"));
    settled("again", r);
    check("still the same error, on the whole statement", isError(r) && /where/.test(r.status), r.status);
  });

  await step("Run: a word that starts no statement", async () => {
    const r = await runIt("selct 2");
    settled("not a statement", r);
    check("the status line is red", isError(r), r.status);
  });

  await step("Run: the next run works", async () => {
    const r = await runIt("select 601 as fixed");
    settled("after an error", r);
    check("it ran", /\b601\b/.test(r.table) && !isError(r), r.status);
  });

  await step("Run: SET VARIABLE and getvariable", async () => {
    const set = await runIt("SET VARIABLE e2e_a = 7");
    check("SET VARIABLE is answered", set.settled === "settled" && /e2e_a = 7/.test(set.status), set.status);
    const r = await runIt("select getvariable('e2e_a') + 1 as v");
    check("getvariable reads it", /\b8\b/.test(r.table), r.table || r.status);
  });

  await step("Run: a variable never set asks, and the answer is kept", async () => {
    await setBox("select getvariable('e2e_b') as v");
    const f = await panel();
    await f.locator("#runBtn").click();
    const box = page.locator(".quick-input-widget input:visible").first();
    await box.waitFor({ timeout: 20000 });
    await box.fill("55");
    await box.press("Enter");
    check("the value reached the query", !!await cell(/\b55\b/));
    const again = await runIt("select getvariable('e2e_b') + 1 as v");
    check("it isn't asked twice", /\b56\b/.test(again.table), again.table || again.status);
  });

  await step("Run: cancelling a variable's box stops the run", async () => {
    await setBox("select getvariable('e2e_c') as v");
    const f = await panel();
    await f.locator("#runBtn").click();
    const box = page.locator(".quick-input-widget input:visible").first();
    await box.waitFor({ timeout: 20000 });
    await box.press("Escape");
    const s = await until("the status", async () => {
      const x = await panelState();
      return /cancelled/i.test(x.status) && x;
    }, 15000);
    check("it says so, and nothing runs", !s.stop, s.status);
  });

  await step("Run: Stop", async () => {
    await setBox(FOREVER);
    const f = await panel();
    await f.locator("#runBtn").click();
    await until("the Stop button", async () => (await panelState()).stop, 20000);
    await f.locator("#stopBtn").click();
    const s = await until("it to stop", async () => {
      const x = await panelState();
      return /stopped/i.test(x.status) && x;
    }, 30000);
    check("the status says stopped, not failed", !isError(s), s.status);
    check("Stop is gone", !s.stop);
  }, 90000);

  await step("Run: a click says so at once, and counts", async () => {
    await setBox(FOREVER);
    const f = await panel();
    await f.locator("#runBtn").click();
    const first = await panelState();
    check("Running… is on screen straight away", /^Running/.test(first.status), first.status);
    const counted = await until("the count", async () => /^Running… \S/.test((await panelState()).status), 5000).then(() => true, () => false);
    check("and it counts", counted, (await panelState()).status);
    await f.locator("#stopBtn").click();
    await until("it to stop", async () => /stopped/i.test((await panelState()).status), 30000);
  }, 60000);

  await step("Run: a run while another is running", async () => {
    await setBox(FOREVER);
    const f = await panel();
    await f.locator("#runBtn").click();
    await until("the slow one to start", async () => (await panelState()).stop, 20000);
    const r = await runIt("select 701 as newer");
    settled("the newer run", r);
    check("the newer one owns the pane", /\b701\b/.test(r.table), r.table || r.status);
    check("nothing is left running", !r.stop, r.status);
  }, 120000);

  for (const [name, sql] of [["CREATE TABLE", "create table e2e_t (a int)"], ["a local file", "select * from read_text('/etc/hostname')"]]) {
    await step(`Run: ${name} is refused`, async () => {
      const r = await runIt(sql);
      settled(name, r);
      check(`${name} is refused`, isError(r), r.status);
    });
  }

  await step("Run: an empty box says so", async () => {
    const r = await runIt("   ");
    check("nothing to run ends at once", r.settled === "settled" && r.ms < 5000 && /nothing here/i.test(r.status), `${r.ms} ms; ${r.status}`);
  });
}

// What only an account's cache can answer.
async function cachedRunMatrix({ saved, home, dbFile }) {
  await step("Run: SHOW ALL TABLES from the cache", async () => {
    const r = await runIt("SHOW ALL TABLES");
    settled("SHOW ALL TABLES", r);
    check("it lists the cached tables, by their whole names", /orders/.test(r.table) && r.table.includes(WORKSPACE), r.table || r.status);
  });

  await step("Queries: a saved query opens in the box, and runs", async () => {
    await drive("exec", { command: "onelakeStudio.openQuery", args: [{ path: saved, label: "kept" }] });
    const s = await until("the query in the box", async () => {
      const x = await panelState();
      return /from a saved query/.test(x.box) && x;
    }, 15000);
    check("the panel names it", /kept/.test(s.title), s.title);
    const f = await panel();
    const r = await act(() => f.locator("#runBtn").click());
    settled("a saved query", r);
    check("it ran", /from a saved query/.test(r.table), r.table || r.status);
  });

  const folder = join(home, "OneLakeStudio", "queries", ACCOUNT.queries);
  await step("Queries: Save Query writes back the one it came from", async () => {
    const f = await panel();
    await f.locator("#sqlEditor").fill("select 'changed' as kept");
    const r = await act(() => f.locator("#saveQueryBtn").click());
    check("it says so", /Saved as kept/.test(r.status), r.status);
    check("the file holds it", readFileSync(saved, "utf8") === "select 'changed' as kept", readFileSync(saved, "utf8"));
  });

  await step("Queries: New Query, and Ctrl+S keeps it as Query N", async () => {
    await drive("exec", { command: "onelakeStudio.newQuery" });
    const s = await until("a new query", async () => {
      const x = await panelState();
      return !/changed/.test(x.box) && x.box.trim() && x;
    }, 15000);
    check("it starts with what can be queried", /SHOW ALL TABLES/i.test(s.box), s.box);
    const f = await panel();
    const r = await act(() => f.locator("#sqlEditor").press("Control+s"));
    check("it says so", /Saved as Query 1/.test(r.status), r.status);
    check("the file is there", existsSync(join(folder, "Query 1.sql")));
    const again = await act(() => f.locator("#saveQueryBtn").click());
    check("saving again is the same query", /Saved as Query 1/.test(again.status) && !existsSync(join(folder, "Query 2.sql")), again.status);
  });

  await step("Tree: a table click adds a tab with its SQL, not run, and the last tab is left as it was", async () => {
    await setBox("select 'mine' as typed");
    const before = await panel();
    await drive("exec", { command: "onelakeStudio.openTable", args: [{ workspace: WORKSPACE, item: "data.Lakehouse", schema: "dbo", table: "orders" }] });
    const s = await until("the table's SQL in the box", async () => {
      const x = await panelState();
      return /^SELECT \* FROM \S*orders LIMIT 100$/.test(x.box) && /orders/.test(x.title) && x;
    }, 30000);
    check("it wasn't run", !/select \* from/i.test(s.status), s.status);
    const tabs = (await drive("state")).tabs;
    check("its tab is named after the table", tabs.includes("orders"), tabs.join(", "));
    check("what was typed is still in the last tab", await before.locator("#sqlEditor").inputValue() === "select 'mine' as typed");
    check("the box's own tab has no Edit SQL", !await (await panel()).locator("#editSqlBtn").isVisible());
    check("offline, with none of its rows read, it has no Data tab", await (await panel()).locator("#viewData").isHidden());
    check("and it lands on Stats", await (await panel()).locator("#viewStats").isVisible());
    const said = await runIt("select 7007 as here");
    check("a query there still shows its result", !isError(said) && await (await panel()).locator("#resultsTable").isVisible(), said.status);
  });

  await step("Tree: a database file opens on what it holds", async () => {
    const rail = () => panel().then(f => f.evaluate(() => {
      const el = document.getElementById("dbRail");
      return { shown: !el.hidden, rows: [...el.querySelectorAll(".dbRow")].map(r => r.querySelector(".dbName").textContent) };
    }));
    await drive("exec", { command: "onelakeStudio.openFile", args: [dbFile] });
    const opened = await until("the file's tree", async () => { const r = await rail(); return r.shown && r.rows.length && r; }, 60000);
    check("the tree lists its schema, tables and view, tables first",
      opened.rows.join() === "shop.sqlite,main,customers,orders,big_orders", opened.rows.join());
    const named = (await drive("state")).tabs;
    check("its tab is named after the file", named.includes("shop.sqlite"), named.join(", "));
    const f = await panel();
    const overview = await f.locator("#dbOverview").innerText();
    check("the overview names the engine and every table, with real counts",
      /SQLite/.test(overview) && /big_orders/.test(overview) && /orders\s+Table\s+3\b/.test(overview), overview);
    const s = await panelState();
    check("nothing was run, and the box has the first table's SQL to start from",
      !s.table && /^SELECT \* FROM shop\w*\.main\.customers LIMIT 100$/.test(s.box), s.box);

    await f.locator(".dbRow-table", { hasText: "orders" }).first().click();
    await until("the table's card", async () => /main\.orders/.test((await panelState()).title), 15000);
    const card = await f.locator("#statsView").innerText();
    check("a table's card has its columns, primary key and definition",
      /amount/.test(card) && /REAL|DOUBLE/.test(card) && /PK/.test(card) && /CREATE TABLE/.test(card), card);
    check("it has no History", await f.locator("#viewHistory").isHidden());

    await f.locator("#viewData").click();
    const rows = await cell(/\b2\.5\b/);
    check("Data shows its rows", !isError(rows), rows.status);

    await f.locator(".dbRow-table", { hasText: "orders" }).first().locator(".dbTwisty").click();
    const open = await rail();
    check("its twisty lists the columns", open.rows.includes("amount"), open.rows.join());

    await f.locator(".dbFilter").fill("name");
    const filtered = await rail();
    check("the filter finds a column, and what holds it", filtered.rows.join() === "shop.sqlite,main,customers,id,name", filtered.rows.join());
    await f.locator(".dbFilter").fill("");

    const alias = /FROM (shop\w*)\./.exec(s.box)[1];
    const r = await runIt(`select sum(amount) as total from ${alias}.main.orders`);
    check("a query from the box answers, and the tree stays", /\b6\.5\b/.test(r.table) && (await rail()).shown, r.table || r.status);

    await f.locator(".dbRow-file").click();
    check("the file's row brings the overview back", await f.locator("#dbOverview").isVisible());
  }, 180000);

  await step("Tree: Logs and Performance open, and a statement that ran is in Logs", async () => {
    const tabs = async () => (await drive("state")).tabs.join(", ");
    await drive("exec", { command: "onelakeStudio.showPerformance" });
    await until("the Performance tab", async () => /Performance/.test(await tabs()), 15000);
    await drive("exec", { command: "onelakeStudio.showLogs" });
    await until("the Logs tab", async () => /Logs/.test(await tabs()), 15000);
    const listed = await until("a statement in Logs", async () => {
      for (const f of page.frames()) {
        if (f.isDetached() || !await f.locator("#filter").count().catch(() => 0)) continue;
        if (/from a saved query/.test(await f.locator("#list").innerText().catch(() => ""))) return true;
      }
      return false;
    }, 20000).catch(() => false);
    check("what ran earlier is listed", listed);
  });

  await step("Tree: Select Top Rows runs from the box", async () => {
    const r = await act(() => drive("exec", { command: "onelakeStudio.selectTop", args: [{ workspace: WORKSPACE, item: "data.Lakehouse", schema: "dbo", table: "neverread" }] }));
    settled("Select Top Rows", r);
    check("its SQL is in the box", r.box.includes(NEVER_READ), r.box);
    check("and it ran", /cache|offline|sign/i.test(r.status), r.status);
  });

  await step("Run: a table whose rows were never read says so at once", async () => {
    const r = await runIt(`select * from ${NEVER_READ}`);
    settled("a table never read", r);
    check("it ends at once, not on a timeout", r.ms < 15000, `${r.ms} ms`);
    check("the status is an error", isError(r), r.status);
    check("it says why", /cache|offline|sign/i.test(r.status), r.status);
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
  });
}

// ---------------------------------------------------------------------------
// A model's Report: every tile's SQL (FROM model) goes through the compiler. With no rows here a tile
// can only fail where the rows aren't held, never as SQL DuckDB can't parse. The Report is the zip's
// (fixtures.mjs): tiles over the model (a pivot among them), and a table whose row needs no rows from OneLake, to click.
// ---------------------------------------------------------------------------
const tilesDone = f => until("every tile done", async () => {
  const said = await f.locator("#modelView .rp-tile").evaluateAll(ts => ts.map(t => t.innerText));
  return said.length && said.every(t => !/Waiting…|Running…/.test(t)) && said;
}, 90000);
const UNCOMPILED = /Parser Error|Binder Error|Catalog Error|syntax error|AGG\(|\bSQL( syntax)?: /i;

async function modelMatrix() {
  await step("Model: the Report runs every tile, compiled", async () => {
    await drive("exec", { command: "onelakeStudio.openSemanticModel", args: [{ kind: "semanticModel", workspace: WORKSPACE, model: "shop", modelId: "shop" }], timeoutMs: 60000 });
    const f = await panel();
    await until("the model view", async () => f.locator("#modelView").isVisible(), 30000);
    await f.locator('#modelView [data-apage="report"]').click();
    const tiles = await tilesDone(f);
    check("the Report has tiles", tiles.length > 0, String(tiles.length));
    const bad = tiles.filter(t => UNCOMPILED.test(t));
    check("no tile's SQL reached DuckDB uncompiled", bad.length === 0, bad.join(" | "));
    // The zip's report is from before pages ({ tiles }): one page, Page 1, with + to add another.
    const names = await f.locator("#modelView .rp-page-name").allInnerTexts();
    check("its tiles are one page, Page 1", names.length === 1 && names[0] === "Page 1", names.join(" | "));
    check("a page can be added", await f.locator("#modelView .rp-page-add").isVisible());
    // A tile's 🖌: the format pane at the right, on that tile; its ✕ closes it.
    await f.locator('#modelView .rp-tile button[title="Format"]').first().click({ force: true });
    const pane = f.locator("#modelView .rp-pane");
    check("🖌 opens the format pane", await pane.isVisible() && /Tile[\s\S]*Report[\s\S]*Title/.test(await pane.innerText()), await pane.innerText());
    check("the tile is outlined", await f.locator("#modelView .rp-tile.rp-formatting").count() === 1);
    await pane.locator(".rp-pane-x").click();
    check("its ✕ closes it", await pane.isHidden() && await f.locator("#modelView .rp-tile.rp-formatting").count() === 0);
  }, 180000);

  await step("Model: a row picked in one tile filters the others", async () => {
    const f = await panel();
    const row = f.locator("#modelView .rp-tile tr.rp-pick").first();
    check("a tile takes clicks", await row.count() > 0);
    // Every text each tile shows from here on, so a run too quick to see is still seen.
    const { picked, slicers } = await f.evaluate(() => {
      const tiles = [...document.querySelectorAll("#modelView .rp-tile")];
      window.__rpSaid = tiles.map(t => [t.innerText]);
      new MutationObserver(() => tiles.forEach((t, i) => window.__rpSaid[i].push(t.innerText)))
        .observe(document.querySelector("#modelView .rp"), { childList: true, subtree: true, characterData: true });
      // A slicer lists every value whatever is picked: it does not run again.
      return { picked: tiles.findIndex(t => t.querySelector("tr.rp-pick")), slicers: tiles.map(t => t.classList.contains("rp-slicer-tile")) };
    });
    check("the Report has a slicer", slicers.some(Boolean));
    await row.click();
    const chips = f.locator("#modelView .rp-filters");
    const listed = await chips.innerText();
    check("the pick is listed above the tiles", /Filtered by:\s*Color = Red/.test(listed), listed);
    const tiles = await tilesDone(f);
    const said = await f.evaluate(() => window.__rpSaid);
    const others = tiles.map((t, i) => [t, i]).filter(([, i]) => i !== picked && !slicers[i]);
    check("every other tile ran again", others.every(([, i]) => said[i].some(t => /Running…/.test(t))), JSON.stringify(said));
    check("the tile picked in stays as it was", !said[picked].some(t => /Waiting…|Running…/.test(t)), said[picked].join(" | "));
    check("its row is highlighted", await f.locator("#modelView tr.rp-on").count() === 1);
    // With the pick as a WHERE, compiled: they stop where the rows aren't held, as they did unfiltered.
    check("the others ran filtered, past the compiler", others.every(([t]) => /isn't cached/.test(t) && !UNCOMPILED.test(t)),
      others.map(([t]) => t).join(" | "));

    await f.locator("#modelView .rp-x").first().click();
    check("its ✕ clears the pick", await chips.isHidden() && await f.locator("#modelView tr.rp-on").count() === 0);
    const again = await tilesDone(f);
    check("the others ran again, unfiltered", again.filter((_, i) => i !== picked).every(t => !UNCOMPILED.test(t)), again.join(" | "));
    check("the slicer did not run again", slicers.every((s, i) => !s || !said[i].some(t => /Running…/.test(t))), JSON.stringify(said));
    await f.locator('#modelView [data-apage="model"]').click();
  }, 180000);
}

// What the Logs tab lists, as written, with setup hidden as it is by default.
async function logsListed() {
  await drive("exec", { command: "onelakeStudio.showLogs" });
  return until("the Logs tab's rows", async () => {
    for (const f of page.frames()) {
      if (f.isDetached() || !await f.locator("#filter").count().catch(() => 0)) continue;
      const rows = await f.locator("#list tbody tr").evaluateAll(trs => trs.map(tr => ({ status: tr.children[1].textContent, sql: tr.querySelector(".one").textContent })));
      if (rows.length) return rows;
    }
    return false;
  }, 30000);
}
// Statements every matrix above runs, by a word of their own: each one is in Logs.
const RAN = [/select 101 as first_one/, /select 102 as by_button/, /fromm where/, /select 901 as planned/, /select 902 as explained/,
  /from a saved query/];

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------
const planned = () => until("the profile, or its error", async () => {
  const s = await panelState();
  return (s.profileDrawn || s.planError) && s;
}, 60000);

async function planMatrix() {
  await step("Plan: a statement", async () => {
    const r = await runIt("select 901 as planned", { plan: true });
    settled("a plan", r);
    const s = await planned();
    check("the plan view is on screen", s.plan);
    check("the profile is drawn, with no error", s.profileDrawn && !s.planError, s.planText);
    check("it shows timings and operators", /Timeline/.test(s.planText) && /Most expensive operators/.test(s.planText), s.planText);
    check("the table's tabs stepped aside", !s.viewBar);
    check("no result is left on screen", !s.table, s.table);
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

  await step("Run: EXPLAIN written in the box is the plan, not two columns of text", async () => {
    for (const text of ["explain select 902 as explained", "EXPLAIN ANALYZE select 903 as explained"]) {
      const r = await runIt(text);
      settled(text, r);
      const s = await planned();
      check(`${text}: the plan view is on screen`, s.plan && !s.planError, s.planText || s.status);
      check(`${text}: no explain_key table`, !/explain_key/.test(s.table), s.table);
    }
  });

  await step("Plan: a real query's operators", async () => {
    const r = await runIt("select i % 10 as d, count(*) as n from range(100000) t(i) group by all order by 1", { plan: true });
    settled("a query's plan", r);
    const s = await planned();
    check("the profile names its operators", /AGGREGATE|RANGE|ORDER|TOP_N/i.test(s.planText), s.planText);
  });

  await step("Plan: bad SQL", async () => {
    const bad = "select 2 fromm where";
    const text = `select 1;\n\n${bad};`;
    const r = await runIt(text, { plan: true, cursor: 12 });
    settled("bad SQL's plan", r);
    check("the cursor goes to the wrong word", r.caret === text.indexOf("where"), `at ${r.caret}, want ${text.indexOf("where")}`);
    check("the status line is red", isError(r), r.status);
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
    check("the status line is red", isError(red), red.status);
  });

  await step("Plan: empty says so", async () => {
    const r = await runIt("   ", { plan: true });
    check("nothing to plan ends at once", r.settled === "settled" && r.ms < 5000 && /nothing here/i.test(r.status), `${r.ms} ms; ${r.status}`);
  });

  await step("Plan: while another is measured, it says wait", async () => {
    const f = await panel();
    await setBox("select sum(i) from range(20000000000) t(i)");
    await f.locator("#planBtn").click();
    await until("the first plan's view", async () => (await panelState()).plan, 20000);
    const r = await runIt("select 904", { plan: true });
    settled("the second plan", r);
    check("it says wait", /still being measured/i.test(r.status), r.status);
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
    check("no plan is left on screen", !r.plan, r.planText);
  });

  await step("Plan: a semantic model's query, with no rows held", async () => {
    const r = await runIt(MODEL_QUERY, { plan: true });
    settled("a model's plan", r);
    check("it stops where the rows aren't held, past the compiler", isError(r) && /isn't cached/.test(r.status) && !/AGG|Catalog Error|Binder/.test(r.status), r.status);
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
  await step("Never signed in: New Query asks for an account, and cancelling leaves nothing stuck", async () => {
    const pending = drive("exec", { command: "onelakeStudio.newQuery", timeoutMs: 60000 });
    const dialog = page.locator(".monaco-dialog-box");
    const asked = await dialog.waitFor({ timeout: 20000 }).then(() => true, () => false);
    if (asked) await dialog.locator(".dialog-buttons a, .dialog-buttons button", { hasText: /cancel/i }).first().click();
    const r = await pending;
    check("nothing is left waiting", r.settled === "settled", JSON.stringify(r));
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
  await step("Signed out, new VS Code: the first click, before the engine is up", async () => {
    await drive("exec", { command: "onelakeStudio.newQuery", timeoutMs: 120000 });
    // New Query's own text lands as the page starts listening, long before the engine is up.
    await until("New Query's text", async () => /SHOW ALL TABLES/i.test((await panelState()).box), 30000);
    await setBox("select 42 as answer");
    const f = await panel();
    await f.locator("#runBtn").click();
    const s = await cell(/\b42\b/, 120000);
    check("it answered, with no sign-in", !isError(s), s.status);
    check("nothing prompted", (await dialogsSeen()).length === 0, (await dialogsSeen()).join(" | "));
    const state = await globalState(page);
    check("the decision still stands", state?.["onelakeStudio.signedOut"] === true, JSON.stringify(state));
    const tabs = (await drive("state")).tabs;
    check("the panel's tab says OneLake Studio and offline", tabs.includes("OneLake Studio: offline"), tabs.join(", "));
  }, 180000);
  await step("Signed out, new VS Code: Plan", async () => {
    await runIt("select 43 as answer", { plan: true });
    const s = await planned();
    check("the profile is drawn", s.profileDrawn && !s.planError, s.planText);
    check("nothing reached OneLake or Microsoft, after all that", connections.length === mark, JSON.stringify(connections.slice(mark)));
  });
  await step("Signed out: Save Query says why it can't", async () => {
    await runIt("select 44");
    const f = await panel();
    const s = await act(() => f.locator("#saveQueryBtn").click());
    check("it says so", isError(s) && /sign in/i.test(s.status), s.status);
  });
  await close();

  // ------------------------------------------------------------------- 3
  console.log("\n=== 3. Signed out, with an account's cache on this machine");
  const cached = await place("cached");
  const { saved, report, dbFile } = await seedAccount(cached);
  // The first start only makes the state to add to: an account known, and signed out.
  await open(cached);
  await step("Cached: the account is on this machine", async () => {
    await drive("exec", { command: "onelakeStudio.signOut" });
    await sleep(3000);
    // And the model's Report, from an export's zip (fixtures.mjs).
    const state = await globalState(page, { "onelakeStudio.lastAccount": ACCOUNT, [REPORT_KEY]: report });
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
    const drew = await until("the tree's line in the log", async () => /tree drawn \d+ms into activation: DuckDB not loaded/.exec(await outputLog()), 30000).catch(() => null);
    check("the tree drew with no DuckDB loaded", !!drew, drew ? drew[0] : await outputLog());
    if (drew) console.log(`  ${drew[0]}`);
    // What moved is said behind the tree, so it may not be there yet.
    await until("what moved", async () => /move: state file: /.test(await outputLog()) && /move: JSON store: /.test(await outputLog()) && /move: model copies: /.test(await outputLog()), 30000).catch(() => {});
    const started = (await outputLog()).split("\n").filter(l => /start: |move: |session: |catalog: /.test(l));
    console.log(started.map(l => `  ${l}`).join("\n"));
    check("VS Code asking and the tree answering are two lines", started.some(l => /start: VS Code asked for the tree at \d+ms/.test(l)) && started.some(l => /start: tree answered at \d+ms/.test(l)), started.join(" | "));
    check("what moved is said, each time", started.some(l => /move: state file: /.test(l)) && started.some(l => /move: JSON store: /.test(l)) && started.some(l => /move: model copies: /.test(l)), started.join(" | "));
  });
  await step("Cached: the panel", async () => { await openPanel(); });
  await runMatrix();
  await cachedRunMatrix({ saved, home: cached.home, dbFile });
  await planMatrix();
  await cachedPlanMatrix();
  await modelMatrix();
  let before = [];
  await step("Logs: everything that ran is listed", async () => {
    before = await logsListed().catch(() => []);
    for (const re of RAN) check(`Logs lists ${re.source}`, before.some(r => re.test(r.sql)), `${before.length} rows`);
    // A query's box in front again, for the steps after: the Report left the model on screen, and Logs is a tab of
    // its own. The engine is up, so no "DuckDB ready" comes again.
    await drive("exec", { command: "onelakeStudio.newQuery", timeoutMs: 60000 });
    await until("a query's box on screen", async () => (await panel()).locator("#sqlEditor").isVisible(), 30000);
  });
  await step("Cached: after all of it", async () => {
    check("nothing reached OneLake or Microsoft", connections.length === mark, JSON.stringify(connections.slice(mark)));
    check("nothing prompted", (await dialogsSeen()).length === 0, (await dialogsSeen()).join(" | "));
    const tabs = (await drive("state")).tabs;
    check("the panel's tab says OneLake Studio and offline", tabs.includes("OneLake Studio: offline"), tabs.join(", "));
    const f = await panel();
    await f.locator("#sqlEditor").fill("select 7007 as draft");
    await sleep(3000);
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
  await step("Control: the box's text came back, and Run and Plan still work", async () => {
    await openPanel("onelakeStudio.open");
    const back = await panelState();
    check("the box's text is what it was in the last window", back.box === "select 7007 as draft", back.box);
    const r = await runIt("select 77 as still_works", { timeoutMs: 120000 });
    settled("no internet", r);
    check("Run answered", /\b77\b/.test(r.table), r.table || r.status);
    await runIt("select 78", { plan: true });
    const s = await planned();
    check("Plan drew a profile", s.profileDrawn && !s.planError, s.planText);
    const listed = await runIt("SHOW ALL TABLES");
    settled("the kept catalog", listed);
    check("the catalog lists the tables after a restart", /orders/.test(listed.table), listed.table || listed.status);
  }, 240000);
  await step("Logs: nothing that ran before the restart is lost", async () => {
    const after = await logsListed().catch(() => []);
    const kept = new Set(after.map(r => `${r.status}|${r.sql}`));
    const lost = before.filter(r => !kept.has(`${r.status}|${r.sql}`));
    check("every statement listed before is still listed", before.length > 0 && lost.length === 0, `${lost.length} of ${before.length} lost: ${lost.slice(0, 5).map(r => r.sql).join(" | ")}`);
    check("and what ran since is there too", after.some(r => /select 77 as still_works/.test(r.sql)), `${after.length} rows`);
  });
  await close();

  // ------------------------------------------------------------------- 5
  // Every extension shares the host's one thread, and opening a .sql file starts the SQL extensions.
  // A query in the box opens none, so nothing here should start them.
  console.log("\n=== 5. Beside the SQL extensions many people have");
  const othersInstalled = await Promise.all(OTHER_SQL_EXTENSIONS.map(install)).then(() => true, e => e.message);
  check("the other SQL extensions installed", othersInstalled === true, othersInstalled);
  await open(cached);
  await step("Beside them: a query starts none of them", async () => {
    await globalState(page, { "onelakeStudio.signedOut": true });
    await openPanel();
    const clicked = Date.now();
    const r = await runIt("select 5555 as beside_them");
    const log = await hostLog();
    const started = OTHER_SQL_EXTENSIONS.filter(x => log.includes(`_doActivateExtension ${x}`));
    check("it answered", /\b5555\b/.test(r.table), r.table || r.status);
    check("it answered within 15 s", Date.now() - clicked < 15000, `${Date.now() - clicked} ms`);
    check("no other SQL extension started", started.length === 0, started.join(", ") || "none");
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
