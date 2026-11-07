'use strict';
// =============================================================================
// dialogs.js — what the window can't do itself: Windows' own dialogs, the clipboard, Explorer
// =============================================================================
// Through PowerShell, as Open in Excel is (xmla/excel.js): no native module to ship. What goes into a
// script comes through the environment or stdin, so no file name can be read as PowerShell.
// =============================================================================

const { spawn } = require('node:child_process');

// A dialog's answer comes back as UTF-8: Windows PowerShell writes a redirected stdout in the OEM code
// page, and a path with an é in it would come back mangled.
const FOREGROUND = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
[Console]::OutputEncoding = [Text.Encoding]::UTF8
`;

const SAVE = `${FOREGROUND}
$d = New-Object System.Windows.Forms.SaveFileDialog
$d.OverwritePrompt = $true
if ($env:OLS_PATH) {
  $d.FileName = [IO.Path]::GetFileName($env:OLS_PATH)
  $dir = [IO.Path]::GetDirectoryName($env:OLS_PATH)
  if ($dir -and (Test-Path $dir)) { $d.InitialDirectory = $dir }
}
if ($env:OLS_FILTER) { $d.Filter = $env:OLS_FILTER }
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.FileName) }
$owner.Close()
`;

const OPEN = `${FOREGROUND}
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Multiselect = $env:OLS_MANY -eq '1'
if ($env:OLS_TITLE) { $d.Title = $env:OLS_TITLE }
if ($env:OLS_PATH -and (Test-Path $env:OLS_PATH)) { $d.InitialDirectory = $env:OLS_PATH }
if ($env:OLS_FILTER) { $d.Filter = $env:OLS_FILTER }
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write(($d.FileNames -join "\`n")) }
$owner.Close()
`;

const FOLDER = `${FOREGROUND}
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.ShowNewFolderButton = $true
if ($env:OLS_TITLE) { $d.Description = $env:OLS_TITLE }
if ($env:OLS_PATH -and (Test-Path $env:OLS_PATH)) { $d.SelectedPath = $env:OLS_PATH }
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }
$owner.Close()
`;

const COPY = `
[Console]::InputEncoding = [Text.Encoding]::UTF8
Set-Clipboard -Value ([Console]::In.ReadToEnd())
`;

function powershell(script, { env = {}, input = '', run = spawn } = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    const chunks = [];
    child.stdout.on('data', d => chunks.push(d));
    child.stderr.resume();
    child.on('error', e => reject(new Error(`PowerShell could not start: ${e.message}`)));
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8').trim());
      else reject(new Error(`PowerShell exited with ${code}`));
    });
    child.stdin.end(input, 'utf8');
  });
}

// { CSV: ['csv'] } as Windows writes a dialog's filter: "CSV|*.csv".
const filterOf = filters => Object.entries(filters).map(([name, exts]) => `${name}|${exts.map(e => `*.${e}`).join(';')}`).join('|');

const saveDialog = ({ defaultPath = '', filters = {} } = {}, o = {}) =>
  powershell(SAVE, { ...o, env: { OLS_PATH: defaultPath, OLS_FILTER: filterOf(filters) } }).then(p => p || null);

// The files picked, one or several (`many`), or [] when dismissed.
const openDialog = ({ defaultPath = '', title = '', filters = {}, many = false } = {}, o = {}) =>
  powershell(OPEN, { ...o, env: { OLS_PATH: defaultPath, OLS_TITLE: title, OLS_FILTER: filterOf(filters), OLS_MANY: many ? '1' : '' } })
    .then(out => out.split(/\r?\n/).filter(Boolean));

const folderDialog = ({ defaultPath = '', title = '' } = {}, o = {}) =>
  powershell(FOLDER, { ...o, env: { OLS_PATH: defaultPath, OLS_TITLE: title } }).then(p => p || null);

const copy = (text, o = {}) => powershell(COPY, { ...o, input: text }).then(() => undefined);

// Shown in Explorer, selected. Explorer's exit code means nothing, so nothing waits on it.
function reveal(path, run = spawn) {
  run('explorer.exe', [`/select,${path}`], { detached: true, stdio: 'ignore' }).unref();
}

function openExternal(url, run = spawn) {
  if (!/^https?:\/\//i.test(url)) return false;
  run('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

module.exports = { saveDialog, openDialog, folderDialog, copy, reveal, openExternal, filterOf };
