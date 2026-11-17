// An export's .fabricator in Fabricator itself (github.com/spatney/rayfin-fabricator), the release a person
// installs, on Windows (CI, after export-fabric.test.mjs published the app and saved the file): opened as a
// double-click opens it, imported with its Import button, installed and run by Fabricator on its own local
// backend, and its preview signed in and drawing the Report from the lakehouse. Then what Fabricator says of it:
// its Advisor's checks, how it installed the packages, and how long from Import to a running app.
//
// Fabricator is driven through Windows UI Automation (test/fabricator/uia.ps1), what a screen reader reads and
// does: its buttons pressed by name, its pages' text read, Fabricator's own and its preview of the app. The
// released Fabricator opens no DevTools port: WebView2 takes no browser argument from outside an app that sets
// its own (environment, registry, a launcher, Image File Execution Options: each tried in CI, 2026-11-16 and 17).
// Nothing of Fabricator or the app is stood in for. The one step a person does that is skipped: Fabricator's
// Setup screen, which waits for a GitHub Copilot sign-in that importing and running an app do not need. Its
// localStorage key fabricator.setupComplete, as Setup's Enter button sets it, is written into Fabricator's
// WebView2 profile before it starts, by Microsoft Edge (the same Chromium) on that profile.
//
// The app's function reads OneLake as whoever `az` is signed in as (rayfin-local's token source), here the CI
// identity, as it is the person on their own machine.
//
// FABRICATOR_OUT: the file. FABRICATOR_EXE: the installed rayfin-fabricator.exe. SHOTS: a folder for screenshots.
import { spawn, execFileSync } from "node:child_process";
import { readFile, readdir, mkdir, stat, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const { FABRICATOR_OUT: FILE, FABRICATOR_EXE: EXE, APPDATA, LOCALAPPDATA } = process.env;
const SHOTS = process.env.SHOTS || join(process.env.RUNNER_TEMP || ".", "fabricator-shots");
const UIA = fileURLToPath(new URL("../fabricator/uia.ps1", import.meta.url));
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
// Fabricator's WebView2 profile, a folder of the test's own (WEBVIEW2_USER_DATA_FOLDER): WebView2 keeps it in EBWebView.
const USER_DATA = join(process.env.RUNNER_TEMP || tmpdir(), "fabricator-webview2");
// The table the app's Report reads, as make_tables.py writes it (test/js/run-fabric-local.mjs).
const TOTAL = 238834;
// Fabricator's Advisor findings that may stand, each for its reason. Any other fails.
const ALLOWED = {
  // A note (no points off) on every app with functions: Fabric's Functions are not in every region.
  "platform/functions-availability": "every app with functions has it",
};

const checks = [];
const check = (ok, what) => { checks.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
const fail = what => { console.log(`FAIL ${what}`); process.exit(1); };
if (!FILE || !EXE) fail("FABRICATOR_OUT and FABRICATOR_EXE are set by fabricator.yml");
if (!EDGE) fail("no Microsoft Edge on this machine, to write Fabricator's profile with");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (what, fn, ms, every = 2000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`${what}: not in ${Math.round(ms / 1000)} s`);
    await sleep(every);
  }
};
const data = join(APPDATA, "Rayfin Fabricator");
const json = async p => JSON.parse((await readFile(p, "utf8")).replace(/^\uFEFF/, ""));
const ps = (args, timeout = 120_000) =>
  execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], { encoding: "utf8", timeout });
let fabricator;
// Fabricator's window through UI Automation: its text, a name in it, a button pressed.
const uia = (what, name = "") => ps(["-File", UIA, what, "-Process", String(fabricator.pid), ...(name ? ["-Name", name] : [])]).trim();
const screen = () => { try { return uia("text").split(/\r?\n/).map(l => l.split("\t").pop()).join(" | "); } catch (e) { return `(UI Automation: ${e.message.split("\n")[0]})`; } };
const shoot = name => {
  const to = join(SHOTS, `${name}.png`).replace(/'/g, "''");
  try {
    ps(["-Command", "Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; " +
      "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); " +
      `$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $bmp.Save('${to}')`]);
  } catch { /* a screenshot is for looking at, after */ }
};
await mkdir(SHOTS, { recursive: true });

// Setup passed, as its Enter button passes it: fabricator.setupComplete in localStorage for Fabricator's page
// (http://tauri.localhost, Tauri's on Windows), written by Edge on the profile Fabricator's WebView2 will open.
{
  const edge = await chromium.launchPersistentContext(join(USER_DATA, "EBWebView"), { executablePath: EDGE, headless: true });
  const page = edge.pages()[0] ?? await edge.newPage();
  await page.route("http://tauri.localhost/**", r => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>setup</title>" }));
  await page.goto("http://tauri.localhost/");
  await page.evaluate(() => localStorage.setItem("fabricator.setupComplete", "1"));
  console.log(`Fabricator's profile: setupComplete ${await page.evaluate(() => localStorage.getItem("fabricator.setupComplete"))}`);
  await edge.close();
}

// Opened as a double-click opens it: the file as Fabricator's argument, the Import window its first screen.
fabricator = spawn(EXE, [FILE], { env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: USER_DATA }, stdio: "ignore" });
try {
  // The Import window, for the file it was opened with, and its Import button.
  await until("Fabricator's Import window", async () => uia("has", "^Import project$"), 180_000)
    .catch(e => { shoot("no-import-window"); throw new Error(`${e.message}; Fabricator shows: ${screen().slice(0, 1500)}`); });
  shoot("import-window");
  check(true, `Fabricator's Import window: ${screen().slice(0, 300)}`);
  // Pressed once it is enabled (it is not while the file is read): a disabled button refuses the press.
  await until("the Import button", async () => uia("press", "Import") === "pressed", 120_000)
    .catch(e => { shoot("import-button"); throw new Error(`${e.message}; Fabricator shows: ${screen().slice(0, 1500)}`); });
  const clicked = Date.now();

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
    .catch(async e => { shoot("no-backend"); throw new Error(`${e.message}; Fabricator shows: ${screen().slice(0, 1500)}; its log: ${JSON.stringify(await activity())}`); });
  const seconds = Math.round((Date.parse(started.time) - clicked) / 1000);
  console.log(`Import to a running app: ${seconds} s (${started.message})`);
  for (const e of await activity()) console.log(`  ${e.time} ${e.level} ${e.event}: ${e.message}`);

  // How it installed the packages: npm ci, from the project's lock file, not a resolve of every package.
  // Its logs, where npm keeps them on this machine (a runner sets its own cache).
  let cache = join(LOCALAPPDATA, "npm-cache");
  try { cache = execFileSync("npm", ["config", "get", "cache"], { encoding: "utf8", shell: true }).trim() || cache; } catch { /* the default */ }
  const logs = join(cache, "_logs");
  console.log(`npm's logs: ${logs}`);
  const installs = [], seen = [];
  for (const f of await readdir(logs).catch(() => [])) {
    const text = await readFile(join(logs, f), "utf8").catch(() => "");
    const argv = text.match(/verbose argv (.*)/)?.[1] ?? "";
    const cwd = text.match(/verbose cwd (.*)/)?.[1]?.trim() ?? "";
    seen.push(`${f}: npm ${argv} in ${cwd}`);
    if (/"(ci|install|i)"/.test(argv) && cwd.toLowerCase() === studio.path.toLowerCase()) {
      installs.push({ argv, packuments: (text.match(/http fetch GET 200 \S+ \d+ms/g) || []).filter(l => !/\.tgz /.test(l)).length });
    }
  }
  for (const i of installs) console.log(`  npm ${i.argv}: ${i.packuments} package lookups`);
  // No install found (2026-11-17, once, with the app running from an install all the same): what npm's logs do hold.
  if (!installs.length) for (const s of seen.length ? seen : ["(no log file)"]) console.log(`  ${s}`);
  check(installs.length > 0 && installs.every(i => /^"ci"/.test(i.argv)), `Fabricator installed the project with npm ci (${installs.map(i => i.argv.split(" ")[0]).join(", ") || "no npm log"})`);
  check(installs.every(i => i.packuments === 0), "npm looked up no package: the lock file names them all");

  // The preview: Fabricator's own view of the app, its own Vite on its own local backend. Not in Fabric's frame,
  // so no silent sign-in: the gate's button, and the popup it opens, which the local backend answers itself.
  await until("the preview's sign-in", async () => uia("has", "^Sign in with Fabric$"), 180_000)
    .catch(e => { shoot("no-sign-in"); throw new Error(`${e.message}; Fabricator shows: ${screen().slice(0, 1500)}`); });
  check(true, "the preview asks to sign in");
  shoot("sign-in");
  check(uia("press", "Sign in with Fabric") === "pressed", "its button pressed");
  // The Report: the total the table holds, and the sum by region, as the preview shows them.
  const digits = t => t.replace(/[,\s]/g, "");
  const report = await until("the Report's total", async () => { const t = screen(); return digits(t).includes(String(TOTAL)) && t; }, 240_000, 5000)
    .catch(e => { shoot("no-report"); throw new Error(`${e.message}; Fabricator shows: ${screen().slice(0, 2500)}`); });
  shoot("report");
  check(true, `the preview's Report has the table's total ${TOTAL}`);
  check(["north", "south", "east"].every(r => report.includes(r)), "and the sum by region: north, south and east");

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
  shoot("at-failure");
} finally {
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
