// An export's .fabricator in Fabricator itself (github.com/spatney/rayfin-fabricator), the release a person
// installs, on Windows (CI, after export-fabric.test.mjs published the app and saved the file): opened as a
// double-click opens it, imported with its Import button, installed and run by Fabricator on its own local
// backend, and its preview signed in and drawing the Report from the lakehouse. Then what Fabricator says of it:
// its Advisor's checks, how it installed the packages, and how long from Import to a running app.
//
// Fabricator is driven over the DevTools protocol of its WebView2, opened as VS Code's JavaScript debugger opens
// any WebView2 app's (vscode-js-debug, edgeLauncher.ts) and as Fabricator's own scripts/docs-screenshots do: a
// user data folder of its own and the DevTools port (WEBVIEW2_USER_DATA_FOLDER, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS),
// and WebView2's debugger pipe, on which it says the port it opened. The port alone was ignored: Fabricator sets
// the browser's arguments itself. Nothing of Fabricator or the app is stood in for. The one step a person
// does that is skipped: Fabricator's Setup screen, which waits for a GitHub Copilot sign-in that importing and
// running an app do not need (its localStorage key fabricator.setupComplete, as Setup's Enter button sets it).
//
// The app's function reads OneLake as whoever `az` is signed in as (rayfin-local's token source), here the CI
// identity, as it is the person on their own machine.
//
// FABRICATOR_OUT: the file. FABRICATOR_EXE: the installed rayfin-fabricator.exe. SHOTS: a folder for screenshots.
import { spawn, execFileSync } from "node:child_process";
import { readFile, readdir, mkdir, stat, cp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright-core";

const { FABRICATOR_OUT: FILE, FABRICATOR_EXE: EXE, APPDATA, LOCALAPPDATA } = process.env;
const SHOTS = process.env.SHOTS || join(process.env.RUNNER_TEMP || ".", "fabricator-shots");
const PORT = 9333;
// The table the app's Report reads, as make_tables.py writes it (test/js/run-fabric-local.mjs).
const TOTAL = 238834;
// Fabricator's Advisor findings that may stand, each for its reason. Any other fails.
const ALLOWED = {
  // A note (no points off) on every app with functions: Fabric's Functions are not in every region.
  "platform/functions-availability": "every app with functions has it",
};

const checks = [];
const check = (ok, what) => { checks.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
const fail = what => { console.log(`FAIL ${what}`); process.exitCode = 1; };
if (!FILE || !EXE) { fail("FABRICATOR_OUT and FABRICATOR_EXE are set by the lake's workflow"); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (what, fn, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`${what}: not in ${Math.round(ms / 1000)} s`);
    await sleep(500);
  }
};
const data = join(APPDATA, "Rayfin Fabricator");
// What WebView2 was started with, when its DevTools port never opened: Fabricator's processes and WebView2's,
// their command lines and listening ports, the profile's DevToolsActivePort, any Edge or WebView2 policy, and
// the desktop as it looks.
function diagnose(child) {
  console.log(`Fabricator's process ${child.pid}: ${child.exitCode == null ? "running" : `exited ${child.exitCode}`}`);
  console.log(`WebView2's debugger pipe: ${piped.length ? piped.join(" | ") : "nothing"}`);
  try { console.log(`DevToolsActivePort: ${readFileSync(join(USER_DATA, "EBWebView", "DevToolsActivePort"), "utf8")}`); }
  catch { try { console.log(`DevToolsActivePort: ${readFileSync(join(USER_DATA, "DevToolsActivePort"), "utf8")}`); } catch { console.log("no DevToolsActivePort"); } }
  const ps = script => {
    try { console.log(execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 60_000 })); }
    catch (e) { console.log(`(powershell: ${String(e.message).split("\n")[0]})`); }
  };
  ps(`Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'rayfin|msedgewebview2' } |
      ForEach-Object { $c = [string]$_.CommandLine; if ($c -match '--type=') { $c = $c.Substring(0, [Math]::Min(200, $c.Length)) };
                       '{0} {1} parent {2}: {3}' -f $_.Name, $_.ProcessId, $_.ParentProcessId, $c }`);
  ps(`$ids = (Get-Process msedgewebview2, rayfin-fabricator -ErrorAction SilentlyContinue).Id;
      Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } |
      ForEach-Object { 'listening {0}:{1} pid {2}' -f $_.LocalAddress, $_.LocalPort, $_.OwningProcess }`);
  ps(`Get-ChildItem -Recurse -Force -Filter DevToolsActivePort "$env:LOCALAPPDATA\\com.rayfin.fabricator" -ErrorAction SilentlyContinue |
      ForEach-Object { "$($_.FullName): $(Get-Content -Raw $_.FullName)" }; 'profiles:';
      Get-ChildItem -Force "$env:LOCALAPPDATA\\com.rayfin.fabricator" -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }`);
  ps(`foreach ($k in 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge', 'HKCU:\\SOFTWARE\\Policies\\Microsoft\\Edge') {
        if (Test-Path $k) { Get-ChildItem -Recurse $k | ForEach-Object { $_.Name; $_.Property } ; (Get-ItemProperty $k | Out-String) } else { "no $k" } }`);
  ps(`Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp);
      $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $bmp.Save('${join(SHOTS, "desktop.png").replace(/'/g, "''")}');
      "desktop $($b.Width)x$($b.Height) saved"`);
}
const json = async p => JSON.parse((await readFile(p, "utf8")).replace(/^﻿/, ""));
const shown = async page => (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 800);
await mkdir(SHOTS, { recursive: true });

// WebView2's debugger pipe (\\.\pipe\WebView2\Debugger\<exe>\<name>, WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER): each
// WebView2 the app starts says on it the DevTools port it opened ({ devtoolsActivePort: "<port>\n…", type, id }).
const USER_DATA = join(process.env.RUNNER_TEMP || tmpdir(), "fabricator-webview2");
const pipeName = `fabricator_${randomBytes(9).toString("hex")}`;
const piped = [];
let pipedPort = null;
const pipe = createServer(stream => stream.on("data", d => {
  piped.push(String(d).replace(/\s+/g, " ").slice(0, 300));
  try { pipedPort = parseInt(String(JSON.parse(String(d)).devtoolsActivePort).split("\n")[0], 10) || pipedPort; } catch { /* not JSON */ }
}));
pipe.listen(`\\\\.\\pipe\\WebView2\\Debugger\\${basename(EXE)}\\${pipeName}`);
// Opened as a double-click opens it: the file as Fabricator's argument, the Import window its first screen.
const fabricator = spawn(EXE, [FILE], { env: { ...process.env,
  WEBVIEW2_USER_DATA_FOLDER: USER_DATA,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER: pipeName,
}, stdio: "ignore" });
let browser, main, preview;
const shoot = async (page, name) => page && page.screenshot({ path: join(SHOTS, `${name}.png`) }).catch(() => {});
try {
  // The port WebView2 says on its pipe, else the one asked for.
  const port = await until("Fabricator's DevTools endpoint", async () => {
    for (const p of new Set([pipedPort, PORT].filter(Boolean))) if ((await fetch(`http://127.0.0.1:${p}/json/version`).catch(() => null))?.ok) return p;
    return null;
  }, 120_000)
    .catch(e => { diagnose(fabricator); throw e; });
  console.log(`WebView2's DevTools on port ${port}; its debugger pipe: ${piped.join(" | ") || "nothing"}`);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const pages = () => browser.contexts().flatMap(c => c.pages());
  main = await until("Fabricator's window", async () => pages().find(p => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(p.url())), 60_000);
  main.on("pageerror", e => console.log("[fabricator pageerror]", e.message));
  console.log(`Fabricator's window: ${main.url()}`);

  // Setup, which waits for a Copilot sign-in: passed as its Enter button passes it.
  await main.waitForLoadState("domcontentloaded");
  await main.evaluate(() => localStorage.setItem("fabricator.setupComplete", "1"));
  await main.reload();

  // The Import window, for the file it was opened with.
  const dialog = main.locator(".project-file-modal[role=dialog]");
  await dialog.waitFor({ timeout: 120_000 }).catch(async e => { await shoot(main, "no-import-window"); throw new Error(`no Import window: ${e.message.split("\n")[0]}; Fabricator shows: ${await shown(main)}`); });
  const button = dialog.locator(".modal-footer .btn.btn--primary");
  await until("the Import button", async () => (await button.isEnabled()) && /^Import$/.test((await button.innerText()).trim()), 60_000)
    .catch(async e => { await shoot(main, "import-window"); throw new Error(`${e.message}; the window says: ${(await dialog.innerText()).replace(/\s+/g, " ")}`); });
  check(true, `Fabricator's Import window: ${(await dialog.innerText()).replace(/\s+/g, " ").slice(0, 200)}`);
  await shoot(main, "import-window");
  const clicked = Date.now();
  await button.click();
  await dialog.waitFor({ state: "detached", timeout: 120_000 });

  // The project Fabricator made of it, and its own log of what it did.
  const studio = await until("the project in studio.json", async () => {
    const s = await json(join(data, "studio.json"));
    return s.activeProjectId && s.projects.find(p => p.id === s.activeProjectId);
  }, 60_000);
  console.log(`the project: ${studio.name} in ${studio.path}`);
  const activity = async () => {
    const dir = join(data, "logs");
    const out = [];
    for (const f of (await readdir(dir)).filter(f => /^activity-.*\.jsonl$/.test(f))) {
      for (const line of (await readFile(join(dir, f), "utf8")).split(/\r?\n/)) { try { out.push(JSON.parse(line)); } catch { /* not a line */ } }
    }
    return out.filter(e => e.projectId === studio.id || /Imported/.test(e.message || ""));
  };
  const started = await until("the local backend", async () => (await activity()).find(e => e.event === "local.started"), 15 * 60_000)
    .catch(async e => { await shoot(main, "no-backend"); throw new Error(`${e.message}; Fabricator shows: ${await shown(main)}; its log: ${JSON.stringify(await activity())}`); });
  const appUrl = String(started.message).match(/https?:\/\/[^\s]+/)?.[0];
  const seconds = Math.round((Date.parse(started.time) - clicked) / 1000);
  console.log(`Import to a running app: ${seconds} s (${started.message})`);
  for (const e of await activity()) console.log(`  ${e.time} ${e.level} ${e.event}: ${e.message}`);

  // How it installed the packages: npm ci, from the project's lock file, not a resolve of every package.
  const logs = join(LOCALAPPDATA, "npm-cache", "_logs");
  const installs = [];
  for (const f of await readdir(logs).catch(() => [])) {
    const text = await readFile(join(logs, f), "utf8").catch(() => "");
    const argv = text.match(/verbose argv (.*)/)?.[1] ?? "";
    const cwd = text.match(/verbose cwd (.*)/)?.[1]?.trim() ?? "";
    if (/"(ci|install|i)"/.test(argv) && cwd.toLowerCase() === studio.path.toLowerCase()) {
      installs.push({ argv, packuments: (text.match(/http fetch GET 200 \S+ \d+ms/g) || []).filter(l => !/\.tgz /.test(l)).length });
    }
  }
  for (const i of installs) console.log(`  npm ${i.argv}: ${i.packuments} package lookups`);
  check(installs.length > 0 && installs.every(i => /^"ci"/.test(i.argv)), `Fabricator installed the project with npm ci (${installs.map(i => i.argv.split(" ")[0]).join(", ") || "no npm log"})`);
  check(installs.every(i => i.packuments === 0), "npm looked up no package: the lock file names them all");

  // The preview: Fabricator's own view of the app, its own Vite on its own local backend.
  preview = await until("Fabricator's preview of the app", async () => pages().find(p => appUrl && p.url().startsWith(new URL(appUrl).origin)), 120_000)
    .catch(async e => { await shoot(main, "no-preview"); throw new Error(`${e.message}; pages: ${pages().map(p => p.url()).join(", ")}`); });
  preview.on("pageerror", e => console.log("[app pageerror]", e.message));
  preview.on("console", m => { if (m.type() === "error") console.log("[app console.error]", m.text().split(/\r?\n/)[0].slice(0, 300)); });
  preview.on("response", r => { if (r.status() >= 400) console.log(`[app ${r.status()}]`, r.url().slice(0, 200)); });
  console.log(`the preview: ${preview.url()}`);
  // Not in Fabric's frame, so no silent sign-in: the gate's button, and the popup it opens, which the local
  // backend answers as the person signed in to `az`.
  const signIn = preview.getByRole("button", { name: "Sign in with Fabric" });
  await signIn.waitFor({ timeout: 120_000 }).catch(async e => { await shoot(preview, "no-sign-in"); throw new Error(`no sign-in button: ${e.message.split("\n")[0]}; the app shows: ${await shown(preview)}`); });
  check(true, "the preview asks to sign in");
  await shoot(preview, "sign-in");
  await signIn.click();
  // The Report: both tiles, each with its rows, the total the table holds.
  await preview.waitForFunction(() => {
    const tiles = [...document.querySelectorAll(".rp-tile")];
    return tiles.length >= 2 && tiles.every(t => t.querySelector("table td, .ex-error"));
  }, null, { timeout: 180_000 }).catch(async e => { await shoot(preview, "no-report"); throw new Error(`the Report never drew: ${e.message.split("\n")[0]}; the app shows: ${await shown(preview)}`); });
  await shoot(preview, "report");
  const tiles = await preview.evaluate(() => [...document.querySelectorAll(".rp-tile")].map(t => t.innerText.replace(/\s+/g, " ").trim()));
  const digits = s => s.replace(/[,\s]/g, "");
  const all = tiles.find(t => t.startsWith("All of it")) ?? "", by = tiles.find(t => t.startsWith("By region")) ?? "";
  check(digits(all).includes(String(TOTAL)), `the preview's Report: "${all.slice(0, 120)}" has the table's total ${TOTAL}`);
  check(["north", "south", "east"].every(r => by.includes(r)) && !/error/i.test(by), `by region, north, south and east: "${by.slice(0, 200)}"`);

  // The Advisor, which Fabricator runs on every project it opens: what it found, once it has the Rayfin versions.
  const advisor = join(data, "advisor", `${studio.id.replace(/[^A-Za-z0-9_-]/g, "_")}.state.json`);
  await until("the Advisor's checks", async () => (await json(advisor)).lastQuick, 120_000);
  await sleep(15_000);   // its version checks run again once the versions arrive
  const found = (await json(advisor)).lastQuick;
  for (const f of Object.values(found)) console.log(`  Advisor: ${f.severity} ${f.ruleId}: ${f.title}${ALLOWED[f.ruleId] ? ` (stands: ${ALLOWED[f.ruleId]})` : ""}`);
  const bad = Object.values(found).filter(f => !ALLOWED[f.ruleId]);
  check(bad.length === 0, `the Advisor finds nothing else${bad.length ? `: ${bad.map(f => `${f.ruleId} (${f.title})`).join("; ")}` : ""}`);

  // The local backend's own log: no error.
  const backendLog = join(data, "logs", "local-backend", `${studio.id}.log`);
  const lines = (await readFile(backendLog, "utf8").catch(() => "")).split(/\r?\n/);
  const errors = lines.filter(l => / (error|fatal) /i.test(l));
  for (const l of errors.slice(0, 20)) console.log(`  [backend] ${l.slice(0, 300)}`);
  check(errors.length === 0, `the local backend logged no error (${lines.length} lines)`);
  console.log(`Fabricator ${(await stat(EXE)).size} bytes; Import to a running app ${seconds} s`);
} catch (e) {
  check(false, String(e?.stack || e));
  await shoot(main, "fabricator-at-failure");
  await shoot(preview, "app-at-failure");
} finally {
  await browser?.close().catch(() => {});
  fabricator.kill();
  pipe.close();
  // Fabricator's local backend and its Vite outlive the window: stop them, as quitting Fabricator does.
  for (const name of ["rayfin-fabricator.exe", "rayfin-local.exe"]) {
    try { execFileSync("taskkill", ["/F", "/T", "/IM", name], { stdio: "ignore" }); } catch { /* not running */ }
  }
  // Fabricator's own logs and Advisor state, beside the screenshots, for CI to keep.
  for (const d of ["logs", "advisor"]) await cp(join(data, d), join(SHOTS, d), { recursive: true }).catch(() => {});
  await cp(join(data, "studio.json"), join(SHOTS, "studio.json")).catch(() => {});
}
if (!checks.length || !checks.every(Boolean)) process.exitCode = 1;
else console.log("the .fabricator imports, installs, runs and draws its Report in Fabricator");
process.exit(process.exitCode ?? 0);
