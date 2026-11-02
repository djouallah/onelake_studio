// The website's screenshots, taken in the app's own window. The installed app runs on this machine's
// home, signed in, with what it has read, so the pictures show real data; Edge draws the window, as
// WebView2 does in the app. Excel's picture is Excel's own window, opened from the app's Open in
// Excel. Nothing is built. The pictures go to website/img.
//
//   node scripts/website-shots.mjs "%LOCALAPPDATA%\OneLake Studio\app" [out dir]
//
// The data is the account's: the demo workspace's lakehouse (aemo tables) and its DL semantic model.
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const [app] = process.argv.slice(2);
const out = resolve(process.argv[3] || join(import.meta.dirname, "..", "website", "img"));
const step = async (what, fn) => { await fn(); console.log(`ok - ${what}`); };

function start() {
  const child = spawn(join(app, "node.exe"), ["--no-warnings", join(app, "dist", "desktop.js")], {
    env: { ...process.env, ONELAKE_STUDIO_BRIDGE: `\\\\.\\pipe\\onelake-shots-${process.pid}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", d => { stderr += d; });
  const ready = new Promise((ok, fail) => {
    let said = "";
    const timer = setTimeout(() => fail(new Error(`no answer in 60s\n${stderr}`)), 60_000);
    child.stdout.setEncoding("utf8").on("data", d => {
      said += d;
      const nl = said.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      const line = JSON.parse(said.slice(0, nl));
      if (line.error) fail(new Error(`${line.error}\n${stderr}`)); else ok(line);
    });
    child.on("exit", code => { clearTimeout(timer); fail(new Error(`exited ${code}\n${stderr}`)); });
  });
  return { child, ready, stderr: () => stderr };
}

// Fields onto the Excel PivotTable the app just opened, then Excel's window, below its title bar
// (the account's picture is there), into excel.png. The workbook is closed unsaved.
const EXCEL = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @'
using System; using System.Drawing; using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  struct RECT { public int L, T, R, B; }
  public static Bitmap Shot(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    var bmp = new Bitmap(r.R - r.L, r.B - r.T);
    using (var g = Graphics.FromImage(bmp)) { var dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc); }
    return bmp;
  }
}
'@
[Win]::SetProcessDPIAware() | Out-Null
$xl = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
$wb = $xl.ActiveWorkbook
$ws = $wb.Worksheets.Item(1)
$pt = $ws.PivotTables('PivotTable1')
$pt.CubeFields.Item('[duid].[FuelSourceDescriptor]').Orientation = 1
$pt.CubeFields.Item('[duid].[Region]').Orientation = 2
$pt.CubeFields.Item('[Measures].[Mwh]').Orientation = 4
$pt.DataBodyRange.NumberFormat = '#,##0'
[void]$ws.Columns('A:G').AutoFit()
$wb.ShowPivotTableFieldList = $true
[void]$ws.Range('B5').Select()
$xl.WindowState = -4143; $xl.Left = 20; $xl.Top = 20; $xl.Width = 1200; $xl.Height = 645
[void][Win]::SetForegroundWindow([IntPtr]$xl.Hwnd)
Start-Sleep -Milliseconds 2000
$full = [Win]::Shot([IntPtr]$xl.Hwnd)
$top = [int]($full.Height * 0.062)
$crop = New-Object System.Drawing.Rectangle 0, $top, ($full.Width - 8), ($full.Height - $top - 8)
$img = $full.Clone($crop, $full.PixelFormat)
$img.Save($env:OLS_SHOT, [System.Drawing.Imaging.ImageFormat]::Png)
$wb.Close($false)
if ($xl.Workbooks.Count -eq 0) { $xl.Quit() }
`;

const proc = start();
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const { url } = await proc.ready;
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2, colorScheme: "dark" });
  // A newer release in the status bar dates the picture.
  await page.addInitScript(() => {
    new MutationObserver(() => {
      for (const el of document.querySelectorAll("#status-right > *")) if (/^\s*Update to/.test(el.textContent)) el.remove();
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await page.goto(url);
  await page.locator("#tree .row").first().waitFor({ timeout: 60_000 });
  const shot = name => page.screenshot({ path: join(out, `${name}.png`) });
  const tab = () => page.frameLocator("#pages iframe.shown");
  // Part of a tab: the element as far as it shows, scrolled to its top, cut where its scrolling
  // parents cut it (and `within`, inside its border), with a margin of the tab around it.
  const part = async (name, locator, { pad = 0, within = null } = {}) => {
    const r = await locator.evaluate((el, within) => {
      const cuts = [];
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (getComputedStyle(p).overflowY === "visible") continue;
        p.scrollTop = 0;
        cuts.push([p, 0]);
      }
      const box = within && el.closest(within);
      if (box) cuts.push([box, 2]);
      let { left, top, right, bottom } = el.getBoundingClientRect();
      for (const [p, inset] of cuts) {
        const b = p.getBoundingClientRect();
        left = Math.max(left, b.left + inset); top = Math.max(top, b.top + inset);
        right = Math.min(right, b.right - inset); bottom = Math.min(bottom, b.bottom - inset);
      }
      return { left, top, right, bottom };
    }, within);
    const frame = await page.locator("#pages iframe.shown").boundingBox();
    const x = Math.max(frame.x, frame.x + r.left - pad), y = Math.max(frame.y, frame.y + r.top - pad);
    await page.screenshot({ path: join(out, `${name}.png`), clip: { x, y, width: frame.x + r.right + pad - x, height: frame.y + r.bottom + pad - y } });
  };
  const row = label => page.locator("#tree .row").filter({ has: page.locator(".label", { hasText: new RegExp(`^${label}$`) }) });
  // By its chevron, so nothing in the tree is selected.
  const expand = async (label, want = true, i = 0) => {
    const r = row(label).nth(i);
    await r.waitFor({ timeout: 30_000 });
    if ((await r.getAttribute("aria-expanded") === "true") !== want) { await r.locator(".twist").click(); await page.waitForTimeout(1500); }
  };
  const settle = async () => {
    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(2000);
      if (!await tab().getByText(/Running the query/).first().isVisible().catch(() => false)) return;
    }
  };

  // The tree as a person would leave it: one workspace open, down to its tables and model.
  await expand("Favorites", false);
  await expand("Other workspaces");
  for (const r of await page.locator("#tree .row[aria-expanded=true]").all()) {
    const label = await r.locator(".label").innerText();
    if (await r.evaluate(el => el.style.paddingLeft) === "16px" && label !== "demo") { await r.locator(".twist").click(); await page.waitForTimeout(500); }
  }
  await expand("demo");
  await expand("data");
  await expand("Tables", true, (await row("Tables").count()) - 1);
  await expand("Semantic models", true, (await row("Semantic models").count()) - 1);

  await step("query.png: every table this account can read, in one statement", async () => {
    await page.keyboard.press("Control+N");
    await tab().locator("#sqlEditor").waitFor({ timeout: 60_000 });
    await tab().locator("#sqlEditor").fill("SHOW ALL TABLES;");
    await tab().locator("#runBtn").click();
    await tab().locator("table.results tbody tr").first().waitFor({ timeout: 120_000 });
    await shot("query");
  });

  await step("profile.png: a join over 128 million rows, and where its time went", async () => {
    await tab().locator("#sqlEditor").fill([
      "SELECT d.Region, d.FuelSourceDescriptor, sum(s.mw) / 12 AS mwh",
      "FROM lakehouse.demo.data.aemo.summary s",
      "JOIN lakehouse.demo.data.aemo.duid d USING (DUID)",
      "GROUP BY ALL",
      "ORDER BY mwh DESC;",
    ].join("\n"));
    await tab().locator("button", { hasText: /^Plan$/ }).click();
    await tab().locator("#planView").getByText("Most expensive operators").waitFor({ timeout: 300_000 });
    // Tall enough for the timeline and the operators under it.
    await page.setViewportSize({ width: 1360, height: 1180 });
    await page.waitForTimeout(1000);
    await part("profile", tab().locator("#planView"));
    await page.setViewportSize({ width: 1360, height: 860 });
  });

  await step("stats.png, history.png: a Delta table in a click", async () => {
    await row("summary").first().click();
    const stats = tab().locator("#statsView");
    await stats.getByText("Total size").waitFor({ timeout: 120_000 });
    await page.waitForTimeout(1000);
    await part("stats", stats.locator("table").first(), { pad: 10 });
    await tab().locator("button:visible", { hasText: "HISTORY" }).click();
    await stats.getByText("Operation").waitFor({ timeout: 120_000 });
    await page.waitForTimeout(1000);
    await part("history", stats);
  });

  await step("model.png, pivot.png: the DL semantic model, and a pivot over it", async () => {
    await row("DL").first().click();
    await page.locator(".tab", { hasText: /^DL/ }).waitFor({ timeout: 180_000 });
    const model = tab().locator(".model-diagram");
    await model.locator("svg").waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    await part("model", model.locator("svg"), { within: ".model-diagram" });

    await tab().locator("button.subtab", { hasText: "Pivot" }).click();
    const field = name => tab().locator(".ex-field", { hasText: name }).first();
    await field("Mwh").waitFor({ timeout: 60_000 });
    const zones = tab().locator(".ex-drop");    // rows, columns, values, filters
    if (await tab().locator("button", { hasText: /^Clear$/ }).isEnabled().catch(() => false)) {
      await tab().locator("button", { hasText: /^Clear$/ }).click();
    }
    await field("date").dragTo(zones.nth(0));
    await field("Region").dragTo(zones.nth(1));
    await field("Mwh").dragTo(zones.nth(2));
    await field("year").dragTo(zones.nth(3));
    await tab().locator("input[type=number]:visible").first().fill("2025");
    await tab().locator("button", { hasText: /^Apply$/ }).click();
    await settle();
    await tab().locator("button", { hasText: /^Area$/ }).first().click();
    await page.waitForTimeout(3000);
    await shot("pivot");
  });

  await step("excel.png: the same model, in an Excel PivotTable", async () => {
    await tab().locator("button", { hasText: "Open in Excel" }).first().click();
    await tab().getByText(/is open in Excel/).waitFor({ timeout: 120_000 });
    const ps = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(EXCEL, "utf16le").toString("base64")],
      { env: { ...process.env, OLS_SHOT: join(out, "excel.png") }, encoding: "utf8", timeout: 300_000 });
    if (ps.status !== 0) throw new Error(`Excel: ${ps.stderr || ps.stdout}`);
  });

  // Back as the tree was found.
  await expand("Other workspaces", false);
  await expand("Favorites");
} catch (e) {
  console.error(proc.stderr());
  throw e;
} finally {
  await browser.close();
  proc.child.stdin.end();
  setTimeout(() => proc.child.kill(), 15_000).unref();
}
