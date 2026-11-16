# Fabricator's window through Windows UI Automation, what a screen reader reads and does, for CI's Fabricator
# test (test/js/run-fabricator.mjs). The released Fabricator opens no DevTools port: WebView2 takes no browser
# argument from outside an app that sets its own (tried in CI, 2026-11-16 and 17). UI Automation needs nothing of
# the app: WebView2 exposes its pages' content to it, Fabricator's own and its preview of the app.
#
#   uia.ps1 text   -Process <id>                  every name in the process's windows, one per line
#   uia.ps1 press  -Process <id> -Name <name>     invokes the button named so (exact), "pressed" or "none"
#   uia.ps1 has    -Process <id> -Name <regex>    the first name matching, or nothing
param(
  [Parameter(Position = 0, Mandatory)] [ValidateSet('text', 'press', 'has')] [string] $Do,
  [Parameter(Mandatory)] [int] $Process,
  [string] $Name = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.TreeScope]
$C = [System.Windows.Automation.Condition]

# The process's top-level windows: Fabricator's own, and a popup it opened (the app's sign-in).
$byPid = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $Process)
$windows = $A::RootElement.FindAll($T::Children, $byPid)

function All-Named {
  foreach ($w in $windows) {
    foreach ($e in $w.FindAll($T::Descendants, $C::TrueCondition)) {
      $n = $e.Current.Name
      if ($n) { [pscustomobject]@{ Element = $e; Name = $n; Type = $e.Current.ControlType.ProgrammaticName } }
    }
  }
}

switch ($Do) {
  'text' { All-Named | ForEach-Object { "$($_.Type -replace 'ControlType\.', '')`t$($_.Name -replace '\s+', ' ')" } }
  'has' {
    $hit = All-Named | Where-Object { $_.Name -match $Name } | Select-Object -First 1
    if ($hit) { $hit.Name -replace '\s+', ' ' }
  }
  'press' {
    $hit = All-Named | Where-Object { $_.Name -eq $Name -and $_.Type -eq 'ControlType.Button' } | Select-Object -First 1
    if (-not $hit) { 'none'; break }
    $p = $null
    if ($hit.Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); 'pressed' }
    else { 'no invoke' }
  }
}
