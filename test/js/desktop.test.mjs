// The desktop app: the extension's `when` clauses, a tab's page as the app serves it, the server's
// locks, and the part of VS Code's API the extension uses. The window itself is in test/e2e/run-desktop.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { when } = await import("../../desktop/ui/when.js");
const { chordOf, BROWSER_KEYS } = await import("../../desktop/ui/keys.js");
const { newer, checkUpdate, DOWNLOAD } = require("../../desktop/node/update.js");
const { createServer, pageFor } = require("../../desktop/node/server.js");
const vscode = require("../../desktop/node/vscode.js");
const { filterOf, openDialog } = require("../../desktop/node/dialogs.js");
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
  const page = pageFor(html, "7");
  assert.match(page, /<script nonce="abc\+\/=">/);
  assert.match(page, /acquireVsCodeApi/);
  assert.match(page, /--vscode-editor-background/);
  assert.match(page, /<body class="vscode-dark">/);
  assert.match(pageFor(`<head></head><body class="a">`, "1"), /<body class="vscode-dark a">/);
  assert.equal(pageFor(`<head></head><body>`, "1").includes("$&"), false);
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
    const rpc = await request(port, "/rpc", { cookie, method: "POST", body: JSON.stringify({ method: "m", args: [1] }), origin: server.origin() });
    assert.deepEqual(JSON.parse(rpc.text), { ok: true, result: { method: "m", args: [1] } });
    const elsewhere = await request(port, "/rpc", { cookie, method: "POST", body: "{}", origin: "http://evil.example" });
    assert.equal(elsewhere.status, 403, "another origin");

    // A tab's page is on a port of its own, another origin: it gets its files, and none of the window's calls.
    const pages = Number(new URL(server.pagesOrigin()).port);
    assert.notEqual(pages, port);
    const tab = await request(pages, `/tab/1?keys=${encodeURIComponent(JSON.stringify(["ctrl+b", 5]))}`, { cookie });
    assert.match(tab.text, /acquireVsCodeApi/);
    assert.ok(tab.text.includes(`const shell = ${JSON.stringify(server.origin())}`), "it posts to the window's origin only");
    assert.ok(tab.text.includes(`new Set(["ctrl+b"])`), "the keys it leaves to the window, strings only");
    assert.equal((await request(pages, "/tab/9", { cookie })).status, 404);
    assert.equal((await request(pages, "/tab/1")).status, 403, "no cookie");
    assert.equal((await request(pages, "/res/webview/app.js", { cookie, origin: server.pagesOrigin() })).text, "the page");
    assert.equal((await request(pages, "/res/secret.txt", { cookie })).status, 403);
    assert.equal((await request(port, "/tab/1", { cookie })).status, 404, "the window's port serves no page");
    const fromTab = await request(port, "/rpc", { cookie, method: "POST", body: JSON.stringify({ method: "app.exit" }), origin: server.pagesOrigin() });
    assert.equal(fromTab.status, 403, "a tab's page can't call the window's methods");
    assert.equal((await request(port, "/events", { cookie, origin: server.pagesOrigin() })).status, 403);
    for (const path of ["/rpc", "/events", "/", "/ui/index.html", "/theme.css"]) {
      const method = path === "/rpc" ? "POST" : "GET";
      assert.equal((await request(pages, path, { cookie, method, body: method === "POST" ? "{}" : undefined, origin: server.pagesOrigin() })).status, 404, path);
    }
    assert.equal((await request(pages, "/tab/1", { cookie, origin: server.origin() })).status, 403, "the pages' port takes its own origin only");
    assert.equal(server.resourceUrl(join(dir, "ext", "webview", "app.js")), `${server.pagesOrigin()}/res/webview/app.js`);
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
  log() {}, push: m => pushed.push(m), pagesOrigin: () => "http://127.0.0.1:1", resourceUrl: p => `http://127.0.0.1:1/res/${p}`,
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

test("the tree: a node drawn with no tooltip gets the tree's own when the pointer rests on it, once", async () => {
  let resolved = 0;
  const provider = {
    getChildren: async () => [{ name: "t" }, { name: "u" }],
    getTreeItem: n => Object.assign(new vscode.TreeItem(n.name), { id: `tip-${n.name}` }, n.name === "u" ? { tooltip: "its own" } : {}),
    resolveTreeItem: async (item, n) => { resolved++; item.tooltip = { value: `about ${n.name}` }; return item; },
  };
  vscode.window.createTreeView("tips", { treeDataProvider: provider });
  const items = await vscode.desktop.treeChildren("tips", null);
  assert.deepEqual(items.map(i => i.tooltip), ["", "its own"]);
  assert.equal(resolved, 0, "drawing the tree resolves nothing");
  assert.equal(await vscode.desktop.treeTooltip("tips", "tip-t"), "about t");
  assert.equal(await vscode.desktop.treeTooltip("tips", "tip-t"), "about t");
  assert.equal(await vscode.desktop.treeTooltip("tips", "tip-u"), "its own");
  assert.equal(resolved, 1, "once, and not for a node that has one");
  assert.equal(await vscode.desktop.treeTooltip("tips", "gone"), "");
  // A tree with no resolveTreeItem: nothing to say.
  vscode.window.createTreeView("plain", { treeDataProvider: { getChildren: async () => [1], getTreeItem: () => ({ id: "p1", label: "p" }) } });
  await vscode.desktop.treeChildren("plain", null);
  assert.equal(await vscode.desktop.treeTooltip("plain", "p1"), "");
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
  assert.equal(b.webview.cspSource, "http://127.0.0.1:1", "the pages' origin, not the window's");
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

test("progress: work that can be cancelled is told by the window's Cancel, once, and other work has none", async () => {
  let told = 0;
  const done = vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Uploading", cancellable: true }, async (progress, token) => {
    token.onCancellationRequested(() => told++);
    progress.report({ message: "a.csv" });
    const { id, cancellable } = pushed.at(-1);
    assert.equal(cancellable, true);
    assert.equal(token.isCancellationRequested, false);
    vscode.desktop.progressCancel(id);
    vscode.desktop.progressCancel(id);
    return token.isCancellationRequested;
  });
  assert.equal(await done, true);
  assert.equal(told, 1);
  assert.equal(pushed.at(-1).t, "progress-end");
  // Cancel after the work ended reaches nothing.
  vscode.desktop.progressCancel(pushed.at(-1).id);
  assert.equal(told, 1);
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Exporting" }, async (progress, token) => {
    const { id, cancellable } = pushed.at(-1);
    assert.equal(cancellable, false);
    vscode.desktop.progressCancel(id);
    assert.equal(token.isCancellationRequested, false);
  });
});

test("a save dialog's filters, as Windows writes them", () => {
  assert.equal(filterOf({ CSV: ["csv"], Excel: ["xlsx", "xls"] }), "CSV|*.csv|Excel|*.xlsx;*.xls");
});

test("an open dialog: Windows' own, several files one per line, its filter and folder through the environment", async () => {
  const { EventEmitter } = require("node:events");
  const runs = [];
  const run = (exe, args, opts) => {
    runs.push({ exe, args, env: opts.env });
    const out = Object.assign(new EventEmitter(), { resume() {} });
    const child = Object.assign(new EventEmitter(), { stdout: out, stderr: { resume() {} }, stdin: { end() {} } });
    setImmediate(() => { out.emit("data", Buffer.from(["C:/data/a.csv", "C:/data/b b.parquet", ""].join("\r\n"))); child.emit("close", 0); });
    return child;
  };
  assert.deepEqual(await openDialog({ defaultPath: "C:/data", title: "Upload", many: true }, { run }), ["C:/data/a.csv", "C:/data/b b.parquet"]);
  const [{ exe, args, env }] = runs;
  assert.equal(exe, "powershell.exe");
  assert.match(Buffer.from(args.at(-1), "base64").toString("utf16le"), /OpenFileDialog/);
  assert.equal(env.OLS_MANY, "1");
  assert.equal(env.OLS_PATH, "C:/data");
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

test("a tab's page posts the window's keys to the window's origin, keeps its own, and right-clicks off the menus show the browser's only on text", () => {
  const shell = "http://127.0.0.1:5";
  const page = pageFor("<head></head><body>", "1", { shell, keys: ["ctrl+b", "f5"] });
  assert.match(page, /input, textarea/);
  assert.equal(page.includes("olsKeydown"), false, "it reaches nothing of the window's but postMessage");
  // The bridge, run as the page runs it.
  const posted = [], on = {};
  const sandbox = {
    parent: { postMessage: (m, to) => posted.push(JSON.parse(JSON.stringify([m, to]))) },
    sessionStorage: { getItem: () => null, setItem() {} },
    addEventListener: (type, fn) => { on[type] = fn; },
    Element: class {}, getSelection: () => "",
  };
  sandbox.window = sandbox;
  vm.runInNewContext(/<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(page)[1], sandbox);
  const press = (key, mods = {}) => {
    let prevented = false;
    on.keydown({ key, ctrlKey: false, shiftKey: false, altKey: false, ...mods, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.equal(press("B", { ctrlKey: true }), true);
  assert.deepEqual(posted.pop(), [{ olsKey: "1", key: { key: "B", ctrlKey: true, shiftKey: false, altKey: false } }, shell]);
  assert.equal(press("F5"), true, "the browser's reload does nothing");
  posted.pop();
  assert.equal(press("c", { ctrlKey: true }), false, "copy stays the page's");
  assert.equal(posted.length, 0);
  sandbox.acquireVsCodeApi().postMessage({ run: 1 });
  assert.deepEqual(posted.pop(), [{ olsTab: "1", msg: { run: 1 } }, shell]);
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
