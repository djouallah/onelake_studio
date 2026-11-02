'use strict';
// =============================================================================
// excel.js — Open in Excel: a new workbook with a PivotTable on the endpoint (server.js)
// =============================================================================
// Through Excel's own automation, in a PowerShell that exits once Excel is on screen. The
// connection is made by code rather than from an .odc file, so no security bar stands between
// the click and the field list. Excel stays hidden until the PivotTable exists, so a failed
// connection leaves nothing behind.
//
// What goes into the script comes through the environment: a model's name is never part of
// its text, so no workspace or model name can be read as PowerShell.
// =============================================================================
const { spawn } = require('node:child_process');
const { CUBE } = require('./cube.js');

const NO_EXCEL = 3;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
try { $xl = New-Object -ComObject Excel.Application } catch { [Console]::Error.WriteLine($_.Exception.Message); exit ${NO_EXCEL} }
$wb = $null
try {
  $xl.Visible = $false
  $wb = $xl.Workbooks.Add()
  $ws = $wb.Worksheets.Item(1)
  $c = $wb.Connections.Add2($env:OLS_XMLA_NAME, '', $env:OLS_XMLA_CONNECTION, '${CUBE}', 1)
  $pc = $wb.PivotCaches().Create(2, $c)
  $pt = $pc.CreatePivotTable($ws.Range('A3'), 'PivotTable1')
  $wb.ShowPivotTableFieldList = $true
  [void]$pt.TableRange1.Select()
  $xl.Visible = $true
  [void]$xl.ActiveWindow.Activate()
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  if ($wb) { $wb.Close($false) }
  if ($xl.Workbooks.Count -eq 0) { $xl.Quit() }
  exit 1
}
`;

// A value of a connection string: quoted as OLE DB says, when it needs to be.
function connectionValue(v) {
  const s = String(v);
  if (!/[;'"=\s]/.test(s) && s === s.trim()) return s;
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return `"${s.replace(/"/g, '""')}"`;
}

const connectionString = ({ port, token, catalog }) => 'OLEDB;Provider=MSOLAP;' +
  `Data Source=http://127.0.0.1:${port}/${token}/;Initial Catalog=${connectionValue(catalog)};` +
  // No sign-in dialog: there's nothing to sign in to here, and hidden Excel would wait on it for good.
  'Protocol Format=XML;Transport Compression=None;Prompt=NoPrompt';

/** Resolves once Excel shows the PivotTable. `run`: stands in for spawning, in a test. */
function openInExcel({ port, token, catalog, name }, run = spawn) {
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, OLS_XMLA_NAME: `OneLake Studio ${name}`.slice(0, 200), OLS_XMLA_CONNECTION: connectionString({ port, token, catalog }) },
    });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => reject(new Error(`PowerShell could not start: ${e.message}`)));
    child.on('close', code => {
      if (code === 0) return resolve();
      if (code === NO_EXCEL) return reject(new Error('Open in Excel needs the Excel desktop app, and it could not be started on this machine.'));
      // PowerShell's own progress comes as blocks of CLIXML, with Excel's message around them.
      const said = err.replace(/#< CLIXML\s*(<Objs[\s\S]*?<\/Objs>)?/g, '').trim();
      return reject(new Error(`Excel could not open the PivotTable: ${said || `exit code ${code}`}`));
    });
  });
}

module.exports = { openInExcel, connectionString, connectionValue, SCRIPT };
