'use strict';
// =============================================================================
// tokenstore.js — the sign-in's token cache on disk, outside any editor
// =============================================================================
// VS Code keeps its own tokens. With no editor, the refresh token is this file's, so it is encrypted
// for this Windows user with DPAPI. PowerShell does that, as it drives Excel for Open in Excel: no
// native module to ship. It takes a moment, so what was read is held for as long as this process runs.
// A file that can't be read (another user's, another machine's) is no sign-in, not a failure.
// =============================================================================

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const { dirname } = require('node:path');

const dpapi = verb => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$out = [Security.Cryptography.ProtectedData]::${verb}($in, $null, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($out))
`;

// The bytes through DPAPI, in base64 both ways: on stdin, so they are never on a command line.
function throughDpapi(verb, base64, run = spawn) {
  const encoded = Buffer.from(dpapi(verb), 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; });
    child.stderr.resume();
    child.on('error', e => reject(new Error(`PowerShell could not start: ${e.message}`)));
    child.on('close', code => {
      if (code === 0) return resolve(out.trim());
      reject(new Error(`the token cache could not be ${verb === 'Protect' ? 'encrypted' : 'read'}: exit code ${code}`));
    });
    child.stdin.end(base64);
  });
}

const dpapiProtect = text => throughDpapi('Protect', Buffer.from(text, 'utf8').toString('base64'));
const dpapiUnprotect = base64 => throughDpapi('Unprotect', base64).then(b => Buffer.from(b, 'base64').toString('utf8'));

/**
 * @param {string} file
 * @param {object} [o]
 * @param {(text: string) => Promise<string>} [o.protect]
 * @param {(stored: string) => Promise<string>} [o.unprotect]
 */
function createTokenStore(file, { protect = dpapiProtect, unprotect = dpapiUnprotect } = {}) {
  let held;   // undefined until the file has been read: then its text, or null with none
  return {
    async read() {
      if (held !== undefined) return held;
      const stored = await fsp.readFile(file, 'utf8').catch(() => null);
      held = stored ? await unprotect(stored).catch(() => null) : null;
      return held;
    },
    async write(text) {
      held = text;
      const stored = await protect(text);
      await fsp.mkdir(dirname(file), { recursive: true });
      // Whole or not at all: another process may be reading it.
      const partial = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(partial, stored);
      await fsp.rename(partial, file).catch(async e => { await fsp.rm(partial, { force: true }).catch(() => {}); throw e; });
    },
    async clear() {
      held = null;
      await fsp.rm(file, { force: true });
    },
  };
}

module.exports = { createTokenStore, dpapiProtect, dpapiUnprotect };
