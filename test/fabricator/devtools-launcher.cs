// The WebView2 browser, started with a DevTools port: CI's msedgewebview2.exe in a copy of the runner's own
// WebView2 runtime (fabricator.yml), which Fabricator's WebView2 takes through WEBVIEW2_BROWSER_EXECUTABLE_FOLDER.
// It starts the runtime's real browser, msedgewebview2-real.exe beside it, with the arguments WebView2 gave it
// and --remote-debugging-port, and lives as long as it does, with its exit code. Nothing else changes: the same
// runtime, the same arguments, Fabricator as released. Fabricator sets WebView2's browser arguments itself, and
// WebView2 then ignores WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS and its registry override (tried in CI, 2026-11-16).
using System;
using System.Diagnostics;
using System.IO;

static class DevToolsLauncher {
  static int Main() {
    string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
    string real = Path.Combine(Path.GetDirectoryName(self), "msedgewebview2-real.exe");
    // The command line as WebView2 wrote it, less this program's own path (quoted or not).
    string line = Environment.CommandLine.TrimStart();
    int end = line.StartsWith("\"") ? line.IndexOf('"', 1) + 1 : line.IndexOf(' ');
    string args = end <= 0 || end >= line.Length ? "" : line.Substring(end);
    string port = Environment.GetEnvironmentVariable("FABRICATOR_DEVTOOLS_PORT") ?? "9333";
    // The browser process alone: its children (renderers, GPU, utilities) are started by it, with --type.
    if (!args.Contains("--type=")) args = "--remote-debugging-port=" + port + " " + args.TrimStart();
    var start = new ProcessStartInfo(real, args) { UseShellExecute = false };
    using (var browser = Process.Start(start)) {
      browser.WaitForExit();
      return browser.ExitCode;
    }
  }
}
