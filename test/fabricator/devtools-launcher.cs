// The WebView2 browser, started with a DevTools port, for CI's Fabricator test (fabricator.yml). Fabricator sets
// WebView2's browser arguments itself, so WebView2 ignores WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS and its registry
// override, and it refuses a browser executable it did not sign (both tried in CI, 2026-11-16).
//
// So Fabricator's WebView2 runs a copy of the runner's own runtime (WEBVIEW2_BROWSER_EXECUTABLE_FOLDER), its
// files as they are, and Windows starts this program in place of that copy's msedgewebview2.exe: Image File
// Execution Options, its Debugger, filtered to that one path. Given the browser's command line, this program
// starts the same browser of the runtime as it is installed (FABRICATOR_BROWSER: the same version, which Image
// File Execution Options do not filter, so its own children start as they always do) with the same arguments
// and --remote-debugging-port, and lives as long as it does, with its exit code.
using System;
using System.Diagnostics;
using System.IO;

static class DevToolsLauncher {
  static readonly string log = Environment.GetEnvironmentVariable("FABRICATOR_LAUNCHER_LOG");
  static void Say(string s) { if (log != null) try { File.AppendAllText(log, DateTime.UtcNow.ToString("o") + " " + s + Environment.NewLine); } catch { } }

  static int Main() {
    try { return Run(); } catch (Exception e) { Say("failed: " + e); return 1; }
  }

  // The rest of a command line after its first token, quoted or not.
  static string AfterFirst(string line) {
    line = line.TrimStart();
    int end = line.StartsWith("\"") ? line.IndexOf('"', 1) + 1 : line.IndexOf(' ');
    return end <= 0 || end >= line.Length ? "" : line.Substring(end).TrimStart();
  }

  static int Run() {
    // As Image File Execution Options start it: this program's path, then the browser's command line.
    string browserLine = AfterFirst(Environment.CommandLine);
    string args = AfterFirst(browserLine);
    string real = Environment.GetEnvironmentVariable("FABRICATOR_BROWSER");
    if (string.IsNullOrEmpty(real) || !File.Exists(real)) { Say("no FABRICATOR_BROWSER: " + real); return 1; }
    if (args.IndexOf("--type=", StringComparison.Ordinal) < 0) {
      string port = Environment.GetEnvironmentVariable("FABRICATOR_DEVTOOLS_PORT") ?? "9333";
      args = "--remote-debugging-port=" + port + " " + args;
    }
    Say("start " + real + " " + args);
    var start = new ProcessStartInfo(real, args) { UseShellExecute = false };
    using (var browser = Process.Start(start)) {
      Say("running, pid " + browser.Id);
      browser.WaitForExit();
      Say("exit " + browser.ExitCode);
      return browser.ExitCode;
    }
  }
}
