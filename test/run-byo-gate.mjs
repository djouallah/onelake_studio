// The sign-in gate with no registration configured — the ordinary first run since the
// project stopped shipping an app registration of its own. Asserts that the gate asks for
// a registration instead of offering a Sign-in button that could only throw, that a saved
// registration is picked up and named, and that boot stays quiet either way.
// Not part of CI — a hand tool. Run: node test/run-byo-gate.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = 5199;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
               ".css": "text/css", ".json": "application/json" };
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  try {
    const file = join(root, "site", path === "/" ? "index.html" : path.slice(1));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail && !ok ? " — " + detail : ""}`);
};

// A real registration is never contacted: MSAL only reaches login.microsoftonline.com when
// the user clicks through, which this test never does. Any GUID proves the wiring.
const FAKE_CLIENT = "11111111-2222-3333-4444-555555555555";
const FAKE_TENANT = "66666666-7777-8888-9999-000000000000";

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));

  // --- First run: config.js ships an empty clientId ------------------------
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => !document.getElementById("runBtn").disabled, { timeout: 120000 });

  check("config.js ships no clientId",
    await page.evaluate(() => (window.ONELAKE_STUDIO_CONFIG.clientId || "") === ""));
  check("gate stays shut on boot — an unconfigured app is not an error",
    await page.evaluate(() => document.getElementById("authGate").style.display === "none"));
  check("status line reports a healthy boot, not a sign-in failure",
    !/failed|error/i.test(await page.locator("#status").innerText()));

  await page.click("#userBox button");
  await page.waitForSelector("#byoBox", { timeout: 5000 });

  check("gate opens straight into the registration form", await page.isVisible("#byoBox"));
  check("no Sign-in button that could only throw", !(await page.locator("#signinBtn").count()));
  check("no admin-consent block", !(await page.locator("#consentBox").count()));
  check("no admin-consent link", !(await page.locator("#consentLink").count()));
  check("gate says what it needs",
    /app registration in your own tenant/i.test(await page.locator("#authGateMsg").innerText()));
  check("form names the permission to grant",
    /user_impersonation/.test(await page.locator("#byoBox").innerText()));
  check("first run offers no 'use a different one' — there is nothing to switch from",
    !(await page.locator("#byoResetBtn").count()));

  // --- Saving one reloads into a working MSAL config -----------------------
  await page.fill("#byoClientId", FAKE_CLIENT);
  await page.fill("#byoTenantId", FAKE_TENANT);
  await page.click("#byoUseBtn");
  await page.waitForFunction(() => !document.getElementById("runBtn").disabled, { timeout: 120000 });

  check("registration persisted across the reload", await page.evaluate(
    () => JSON.parse(localStorage.getItem("onelake-studio-registration") || "{}").clientId
  ) === FAKE_CLIENT);
  check("gate still shut after saving — silent restore must not throw",
    await page.evaluate(() => document.getElementById("authGate").style.display === "none"));

  await page.click("#userBox button");
  await page.waitForSelector("#signinBtn", { timeout: 5000 });
  check("with a registration, the Sign-in button is back", await page.isVisible("#signinBtn"));
  check("banner names the registration in play",
    (await page.locator("#byoBanner").innerText()).includes(FAKE_CLIENT));
  check("banner offers a swap, not a way back to a built-in app",
    /use a different registration/i.test(await page.locator("#byoBanner").innerText()));

  // --- ?clientId= in the address bar still wins ----------------------------
  const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  await page.goto(`http://127.0.0.1:${PORT}/?clientId=${OTHER}&tenantId=${FAKE_TENANT}`);
  await page.waitForFunction(() => !document.getElementById("runBtn").disabled, { timeout: 120000 });
  check("URL parameter overrides the saved registration", await page.evaluate(
    () => JSON.parse(localStorage.getItem("onelake-studio-registration") || "{}").clientId
  ) === OTHER);

  check("no uncaught page errors throughout", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("harness ran to completion", false, e.message);
} finally {
  const failed = checks.filter(c => !c.ok).length;
  console.log(`RESULT: ${failed ? "FAILED" : "OK"} — ${checks.length - failed}/${checks.length} checks passed`);
  await browser.close().catch(() => {});
  server.close();
  process.exit(failed ? 1 : 0);
}
