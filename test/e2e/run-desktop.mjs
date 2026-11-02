// The desktop app as a person meets it, from the vsix's files with its own Node process and bundle, in
// Edge: WebView2 is Edge, so this is the window the app shows. Signed out first, then on an account
// this machine already knows, where a query runs on the real engine. Screenshots go to <shots>.
//
//   node test/e2e/run-desktop.mjs <the app's folder> <shots>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [app, shots] = process.argv.slice(2);
await mkdir(shots, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "onelake-desktop-"));
const step = async (what, fn) => { await fn(); console.log(`ok - ${what}`); };

function start() {
  const child = spawn(process.execPath, ["--no-warnings", join(app, "dist", "desktop.js")], {
    env: { ...process.env, ONELAKE_STUDIO_HOME: home, ONELAKE_STUDIO_BRIDGE: `\\\\.\\pipe\\onelake-desktop-${process.pid}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", d => { stderr += d; });
  const ready = new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`no answer in 60s\n${stderr}`)), 60_000);
    child.stdout.setEncoding("utf8").on("data", d => {
      out += d;
      const nl = out.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      const said = JSON.parse(out.slice(0, nl));
      if (said.error) reject(new Error(`${said.error}\n${stderr}`)); else resolve(said);
    });
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`exited ${code}\n${stderr}`)); });
  });
  return { child, ready, stderr: () => stderr };
}

// Its stdin closing is the window closing.
function stop(proc) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { proc.child.kill(); resolve(false); }, 15_000);
    proc.child.removeAllListeners("exit");
    proc.child.on("exit", () => { clearTimeout(timer); resolve(true); });
    proc.child.stdin.end();
  });
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
let proc = null;
try {
  proc = start();
  let { url } = await proc.ready;
  let page = await browser.newPage({ viewport: { width: 1360, height: 860 } });

  await step("signed out, the window offers a sign-in, and says which build it is", async () => {
    await page.goto(url);
    await page.getByRole("button", { name: "Sign in to OneLake" }).waitFor({ timeout: 30_000 });
    await page.locator("#status").getByText(/OneLake 0\.\d+\.\d+/).waitFor();
    await page.screenshot({ path: join(shots, "1-signed-out.png") });
  });

  await step("the tree's width is dragged, and kept by the app", async () => {
    const sash = await page.locator("#sash").boundingBox();
    const left = (await page.locator("#activity").boundingBox()).width;
    await page.mouse.move(sash.x + sash.width / 2, sash.y + 200);
    await page.mouse.down();
    await page.mouse.move(left + 350, sash.y + 200, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => document.getElementById("side").offsetWidth === 350);
    // Written once the drag ends, by a call the window doesn't wait on.
    await page.waitForTimeout(500);
    const kept = JSON.parse(await readFile(join(home, "window-state.json"), "utf8"));
    assert.equal(kept.window.width, 350);
  });

  await step("closing the window ends the app", async () => {
    assert.equal(await stop(proc), true, "it was still running 15s after its window closed");
  });

  // What a sign-in leaves: the account this machine knows, whose cache is shown with no session.
  await writeFile(join(home, "standalone-state.json"), JSON.stringify({ "onelakeStudio.lastAccount": { key: "e2eaccount", queries: "e2e", tenant: "" } }));
  proc = start();
  ({ url } = await proc.ready);
  await page.close();
  page = await browser.newPage({ viewport: { width: 1360, height: 860 } });

  await step("on a known account, the tree draws from the cache, as wide as it was left", async () => {
    await page.goto(url);
    await page.locator(".row", { hasText: "Queries" }).waitFor({ timeout: 30_000 });
    await page.locator(".row", { hasText: "Logs" }).waitFor();
    assert.equal(await page.locator("#side").evaluate(el => el.offsetWidth), 350);
  });

  await step("Help › About says which version this is", async () => {
    await page.locator("#menubar button", { hasText: "Help" }).click();
    await page.locator("#menu .entry", { hasText: "About OneLake Studio" }).click();
    await page.locator(".dialog.about .detail").getByText(/Version 0\.\d+\.\d+/).waitFor();
    await page.screenshot({ path: join(shots, "1b-about.png") });
    await page.keyboard.press("Escape");
    await page.locator(".dialog.about").waitFor({ state: "detached" });
  });

  await step("New Query opens a tab, and a statement runs on the real engine", async () => {
    await page.locator("#empty-query").click();
    const frame = page.frameLocator("#pages iframe").first();
    const box = frame.locator("#sqlEditor");
    await box.waitFor({ timeout: 60_000 });
    assert.equal(await page.locator("#empty").isVisible(), false, "the start page is drawn over the tab");
    await box.fill("SELECT 42 AS answer");
    await frame.locator("#runBtn").click();
    await frame.locator("table").getByText("42", { exact: true }).waitFor({ timeout: 180_000 });
    await page.screenshot({ path: join(shots, "2-query.png") });
  });

  await step("Ctrl+B puts the tree away, typed in a tab too, and its button brings it back", async () => {
    const frame = page.frameLocator("#pages iframe").first();
    await frame.locator("#sqlEditor").click();
    await page.keyboard.press("Control+B");
    await page.locator("#side").waitFor({ state: "hidden" });
    await page.screenshot({ path: join(shots, "2b-tree-away.png") });
    await page.locator("#activity-tree").click();
    await page.locator("#side").waitFor({ state: "visible" });
  });

  await step("F5 and Ctrl+R in a tab reload nothing", async () => {
    await page.evaluate(() => { window.olsStillHere = true; });
    const frame = page.frameLocator("#pages iframe").first();
    await frame.locator("#sqlEditor").click();
    await page.keyboard.press("F5");
    await page.keyboard.press("Control+R");
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(() => window.olsStillHere), true, "the window was reloaded");
    await frame.locator("table").getByText("42", { exact: true }).waitFor();
  });

  await step("the grid's right-click is the extension's menu", async () => {
    const frame = page.frameLocator("#pages iframe").first();
    await frame.locator("table").getByText("42", { exact: true }).click({ button: "right" });
    await page.locator("#menu .entry", { hasText: "Copy with Headers" }).waitFor();
    await page.screenshot({ path: join(shots, "3-grid-menu.png") });
    await page.keyboard.press("Escape");
  });

  await step("Logs opens in a tab of its own, from the tree", async () => {
    await page.locator(".row", { hasText: "Logs" }).click();
    await page.locator(".tab", { hasText: "Logs" }).waitFor();
    await page.screenshot({ path: join(shots, "4-logs.png") });
  });

  await step("Settings come from the extension's own list", async () => {
    await page.locator("#side-actions button[title='More Actions…']").click();
    await page.locator("#menu .entry", { hasText: "Settings" }).click();
    await page.locator(".settings-page .name", { hasText: "Select Top Rows" }).waitFor();
    await page.screenshot({ path: join(shots, "5-settings.png") });
  });

  await step("a tab's right-click closes the others", async () => {
    assert.ok(await page.locator(".tab").count() >= 3);
    await page.locator(".tab", { hasText: "Settings" }).click({ button: "right" });
    await page.locator("#menu .entry", { hasText: "Close Others" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".tab").length === 1);
    await page.locator(".tab.active", { hasText: "Settings" }).waitFor();
  });

  await step("Go To opens on Ctrl+Alt+O", async () => {
    await page.keyboard.press("Control+Alt+O");
    await page.locator(".picker input").waitFor();
    await page.screenshot({ path: join(shots, "6-go-to.png") });
    await page.keyboard.press("Escape");
  });

  await step("closing a tab closes its page", async () => {
    const before = await page.locator(".tab").count();
    await page.locator(".tab.active .close").click();
    await page.waitForFunction(n => document.querySelectorAll(".tab").length === n - 1, before);
  });

  await step("and closing the window ends the app", async () => {
    assert.equal(await stop(proc), true);
    proc = null;
  });
  console.log("all passed");
} catch (e) {
  if (proc) console.error(proc.stderr());
  throw e;
} finally {
  await browser.close();
  if (proc) proc.child.kill();
  await rm(home, { recursive: true, force: true }).catch(() => {});
}
process.exit(0);
