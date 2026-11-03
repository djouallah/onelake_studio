// The desktop app: the extension's `when` clauses, a tab's page as the app serves it, the server's
// locks, and the part of VS Code's API the extension uses. The window itself is in test/e2e/run-desktop.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const require = createRequire(import.meta.url);
const { when } = await import("../../desktop/ui/when.js");
const { chordOf, BROWSER_KEYS } = await import("../../desktop/ui/keys.js");
const { newer, checkUpdate, DOWNLOAD } = require("../../src/desktop/update.js");
const { createServer, pageFor } = require("../../src/desktop/server.js");
const vscode = require("../../src/desktop/vscode.js");
const { filterOf, openDialog } = require("../../src/desktop/dialogs.js");
const pkg = require("../../package.json");

test("every when clause the extension's menus use reads as VS Code reads it", () => {
  const signedIn = { view: "onelakeStudio.explorer", "onelakeStudio.signedIn": true, "onelakeStudio.hasSession": false };
  assert.equal(when("view == onelakeStudio.explorer && onelakeStudio.signedIn", signedIn), true);
  assert.equal(when("view == onelakeStudio.explorer && onelakeStudio.signedIn && !onelakeStudio.hasSession", signedIn), true);
  assert.equal(when("!onelakeStudio.signedIn", signedIn), false);
  assert.equal(when("view == onelakeStudio.explorer && viewItem =~ /^(table|file|dir)$/", { ...signedIn, viewItem: "file" }), true);
  assert.equal(when("view == onelakeStudio.explorer && viewItem =~ /^(table|file|dir)$/", { ...signedIn, viewItem: "files" }), false);
  assert.equal(when("webviewId == 'onelakeStudio' && webviewSection == 'grid'", { webviewId: "onelakeStudio", webviewSection: "grid" }), true);
  assert.equal(when("false", {}), false);
  assert.equal(when(undefined, {}), true);
  // Every clause in package.json parses: none throws.
  for (const list of Object.values(pkg.contributes.menus)) for (const m of list) when(m.when, {});
});

test("a tab's page gets VS Code's bridge in its own CSP, its theme, and its body class", () => {
  const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-abc+/='"></head><body><p>x</p></body></html>`;
  const page = pageFor(html, "7", true);
  assert.match(page, /<script nonce="abc\+\/=">/);
  assert.match(page, /acquireVsCodeApi/);
  assert.match(page, /--vscode-editor-background/);
  assert.match(page, /<body class="vscode-dark">/);
  assert.match(pageFor(`<head></head><body class="a">`, "1", false), /<body class="vscode-light a">/);
  assert.equal(pageFor(`<head></head><body>`, "1", false).includes("$&"), false);
});

function request(port, path, { cookie = "", host = `127.0.0.1:${port}`, origin, method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) } }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", d => { text += d; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("the server: a token becomes a cookie, and without it, the wrong Host, or another origin, nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-"));
  await mkdir(join(dir, "ui"));
  await mkdir(join(dir, "ext", "webview"), { recursive: true });
  await writeFile(join(dir, "ui", "index.html"), "the window");
  await writeFile(join(dir, "ext", "webview", "app.js"), "the page");
  await writeFile(join(dir, "ext", "secret.txt"), "not for a page");
  const server = createServer({
    uiDir: join(dir, "ui"), extensionDir: join(dir, "ext"),
    pageOf: id => (id === "1" ? "<head></head><body>tab</body>" : null),
    rpc: async ({ method, args }) => ({ method, args }),
  });
  const port = await server.listen();
  try {
    const url = new URL(server.url());
    assert.equal((await request(port, "/")).status, 403, "no cookie");
    assert.equal((await request(port, "/?k=wrong")).status, 403, "a wrong token");
    const first = await request(port, `/?k=${url.searchParams.get("k")}`);
    assert.equal(first.status, 303);
    const cookie = first.headers["set-cookie"][0].split(";")[0];
    assert.match(first.headers["set-cookie"][0], /HttpOnly; SameSite=Strict/);
    assert.equal((await request(port, "/", { cookie })).text, "the window");
    assert.equal((await request(port, "/", { cookie, host: `localhost:${port}` })).status, 403, "DNS rebinding");
    assert.equal((await request(port, "/res/webview/app.js", { cookie })).text, "the page");
    assert.equal((await request(port, "/res/secret.txt", { cookie })).status, 403, "outside the page's folders");
    assert.equal((await request(port, "/res/webview/../secret.txt", { cookie })).status, 403);
    assert.equal((await request(port, "/res/webview/%2e%2e/secret.txt", { cookie })).status, 403);
    assert.match((await request(port, "/tab/1", { cookie })).text, /acquireVsCodeApi/);
    assert.equal((await request(port, "/tab/9", { cookie })).status, 404);
    const rpc = await request(port, "/rpc", { cookie, method: "POST", body: JSON.stringify({ method: "m", args: [1] }), origin: server.origin() });
    assert.deepEqual(JSON.parse(rpc.text), { ok: true, result: { method: "m", args: [1] } });
    const elsewhere = await request(port, "/rpc", { cookie, method: "POST", body: "{}", origin: "http://evil.example" });
    assert.equal(elsewhere.status, 403, "another origin");
    assert.equal(server.resourceUrl(join(dir, "ext", "webview", "app.js")), `${server.origin()}/res/webview/app.js`);
    assert.throws(() => server.resourceUrl(join(dir, "elsewhere.js")), /is not this app's/);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// What the window would be told, and what it answers.
const pushed = [];
let answers = [];
vscode.attach({
  log() {}, push: m => pushed.push(m), origin: () => "http://127.0.0.1:1", resourceUrl: p => `http://127.0.0.1:1/res/${p}`,
  setting: (key, fallback) => (key === "onelakeStudio.tableOpensOn" ? "data" : fallback),
  ask: async (kind, payload) => { pushed.push({ ask: kind, ...payload }); return answers.shift(); },
});

test("commands: registered, run, and setContext tells the window", async () => {
  vscode.commands.registerCommand("x.add", (a, b) => a + b);
  assert.equal(await vscode.commands.executeCommand("x.add", 2, 3), 5);
  await vscode.commands.executeCommand("setContext", "onelakeStudio.signedIn", true);
  assert.deepEqual(pushed.at(-1), { t: "context", key: "onelakeStudio.signedIn", value: true });
  assert.equal(vscode.desktop.contexts["onelakeStudio.signedIn"], true);
  await assert.rejects(vscode.commands.executeCommand("x.none"), /no command x.none/);
});

test("a message is a question with its buttons, modal or not, and no answer is undefined", async () => {
  answers = ["Delete"];
  assert.equal(await vscode.window.showWarningMessage("Delete it?", { modal: true, detail: "really" }, "Delete"), "Delete");
  assert.deepEqual(pushed.at(-1), { ask: "message", level: "warning", message: "Delete it?", modal: true, detail: "really", items: ["Delete"] });
  answers = [null];
  assert.equal(await vscode.window.showInformationMessage("Done"), undefined);
});

test("settings read through the window's settings, section and key", () => {
  assert.equal(vscode.workspace.getConfiguration("onelakeStudio").get("tableOpensOn", "stats"), "data");
  assert.equal(vscode.workspace.getConfiguration("onelakeStudio").get("selectTopRows", 1000), 1000);
});

test("the tree: nodes by id, their icons, what a click runs, and what's dragged", async () => {
  const nodes = [{ name: "a" }, { name: "b" }];
  const changed = new vscode.EventEmitter();
  const provider = {
    onDidChangeTreeData: changed.event,
    getChildren: async parent => (parent ? [] : nodes),
    getTreeItem: n => Object.assign(new vscode.TreeItem(n.name, n.name === "a" ? 1 : 0), {
      id: `id-${n.name}`, contextValue: "table", iconPath: new vscode.ThemeIcon("database", new vscode.ThemeColor("testing.iconPassed")),
      command: { command: "x.open", arguments: [n] },
    }),
  };
  const opened = [];
  vscode.commands.registerCommand("x.open", n => opened.push(n.name));
  vscode.window.createTreeView("v", { treeDataProvider: provider, dragAndDropController: {
    handleDrag: (list, data) => data.set("text/plain", new vscode.DataTransferItem(`dragged ${list[0].name}`)),
  } });
  const items = await vscode.desktop.treeChildren("v", null);
  assert.deepEqual(items.map(i => [i.id, i.label, i.collapsible, i.contextValue, i.icon.id, i.icon.color, i.dragText]),
    [["id-a", "a", 1, "table", "database", "testing.iconPassed", "dragged a"], ["id-b", "b", 0, "table", "database", "testing.iconPassed", "dragged b"]]);
  await vscode.desktop.treeClick("v", "id-b");
  assert.deepEqual(opened, ["b"]);
  changed.fire();
  assert.equal(pushed.at(-1).t, "tree-changed");
});

test("a tab: opened, posted to, told it's shown or not, and closed once", () => {
  const a = vscode.window.createWebviewPanel("onelakeStudio", "One");
  const b = vscode.window.createWebviewPanel("onelakeStudio", "Two");
  assert.equal(a.active, false);
  assert.equal(b.active, true);
  const seen = [];
  a.onDidChangeViewState(e => seen.push(e.webviewPanel.active));
  vscode.desktop.tabShown(a.id);
  assert.deepEqual(seen, [true]);
  a.webview.postMessage({ hello: 1 });
  assert.deepEqual(pushed.at(-1), { t: "tab-post", id: a.id, msg: { hello: 1 } });
  let gone = 0;
  a.onDidDispose(() => gone++);
  a.dispose();
  a.dispose();
  assert.equal(gone, 1);
  assert.throws(() => a.webview.postMessage({}), /closed/);
  assert.equal(a.webview.asWebviewUri(vscode.Uri.file("x")).toString(), "http://127.0.0.1:1/res/x");
});

test("a quick pick: the window's choice is its selection", () => {
  const qp = vscode.window.createQuickPick();
  qp.items = [{ label: "$(table) a" }, { label: "b" }];
  let chosen = null;
  qp.onDidAccept(() => { chosen = qp.selectedItems[0].label; });
  qp.show();
  const open = pushed.at(-1);
  assert.equal(open.t, "pick-open");
  vscode.desktop.pickAccept(open.id, 1);
  assert.equal(chosen, "b");
});

test("a save dialog's filters, as Windows writes them", () => {
  assert.equal(filterOf({ CSV: ["csv"], Excel: ["xlsx", "xls"] }), "CSV|*.csv|Excel|*.xlsx;*.xls");
});

test("an open dialog: Windows' own, its filter and folder through the environment, never the script", async () => {
  const runs = [];
  const run = (exe, args, opts) => {
    runs.push({ exe, args, env: opts.env });
    const out = new (require("node:events"))();
    const child = Object.assign(new (require("node:events"))(), {
      stdout: Object.assign(out, { resume() {} }), stderr: { resume() {} }, stdin: { end() {} },
    });
    setImmediate(() => { out.emit("data", Buffer.from("C:\models\sales.yaml
")); child.emit("close", 0); });
    return child;
  };
  const path = await openDialog({ defaultPath: "C:\models", title: "Open a model file", filters: { Model: ["yaml", "yml", "bim"] } }, { run });
  assert.equal(path, "C:\models\sales.yaml");
  const [{ exe, args, env }] = runs;
  assert.equal(exe, "powershell.exe");
  assert.match(Buffer.from(args.at(-1), "base64").toString("utf16le"), /OpenFileDialog/);
  assert.equal(env.OLS_FILTER, "Model|*.yaml;*.yml;*.bim");
  assert.equal(env.OLS_PATH, "C:\models");
});

test("keys: named as the window's shortcuts are, and the browser's own do nothing", () => {
  assert.equal(chordOf({ ctrlKey: true, shiftKey: true, key: "Tab" }), "ctrl+shift+tab");
  assert.equal(chordOf({ ctrlKey: true, key: "B" }), "ctrl+b");
  assert.equal(chordOf({ ctrlKey: true, altKey: true, key: "o" }), "ctrl+alt+o");
  assert.equal(chordOf({ key: "F5" }), "f5");
  for (const k of ["f5", "ctrl+r", "ctrl+p", "ctrl+f", "alt+arrowleft"]) assert.ok(BROWSER_KEYS.has(k), k);
  // What a tab's page does itself stays the page's: copy, select all, run, the grid's arrows.
  for (const k of ["ctrl+c", "ctrl+shift+c", "ctrl+v", "ctrl+a", "ctrl+z", "ctrl+enter", "arrowdown"]) assert.ok(!BROWSER_KEYS.has(k), k);
});

test("a tab's keys go to the window first, and a right-click off the menus shows the browser's only on text", () => {
  const page = pageFor("<head></head><body>", "1", true);
  assert.match(page, /parent\.olsKeydown\(e\)/);
  assert.match(page, /input, textarea/);
});

test("updates: the latest release's tag against this version", async () => {
  assert.equal(newer("0.2.11", "0.2.10"), true);
  assert.equal(newer("0.10.0", "0.9.9"), true);
  assert.equal(newer("0.2.10", "0.2.10"), false);
  assert.equal(newer("0.2.9", "0.2.10"), false);
  const answering = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
  assert.deepEqual(await checkUpdate("0.2.10", answering(200, { tag_name: "ext-v0.2.11" })),
    { version: "0.2.10", latest: "0.2.11", newer: true, download: DOWNLOAD });
  assert.equal((await checkUpdate("0.2.10", answering(200, { tag_name: "ext-v0.2.10" }))).newer, false);
  await assert.rejects(checkUpdate("0.2.10", answering(403, {})), /403/);
  await assert.rejects(checkUpdate("0.2.10", answering(200, { tag_name: "v1" })), /latest release is v1/);
});
