'use strict';
// =============================================================================
// home.js — where this install keeps its files, and what it remembers there, with no editor
// =============================================================================
// VS Code hands the extension its storage folder, its settings and its globalState. The command line with
// VS Code closed and the desktop app have none of that, and read their own install's places themselves. The
// extension and the desktop app are separate products: neither reads the other's folder, settings or cache.
// No `vscode` import.
// =============================================================================

const { join } = require('node:path');
const { homedir } = require('node:os');
const { readFileSync, writeFileSync, renameSync } = require('node:fs');

const EXTENSION_ID = 'djouallah.onelake-studio';

// Where this install keeps its files. The extension's, under VS Code (its command line with VS Code closed reads
// them too: it is the extension's): VS Code's folder for it. Anything else, the desktop app's: a folder of its
// own, whether VS Code is here or not. Two engines on one folder fought over the lake, its log and its catalog.
// ONELAKE_STUDIO_HOME keeps it all somewhere else.
function pathsOf(extensionDir, env = process.env) {
  if (env.ONELAKE_STUDIO_HOME) return { home: env.ONELAKE_STUDIO_HOME, settingsFile: join(env.ONELAKE_STUDIO_HOME, 'settings.json') };
  const product = /[\\/]\.vscode-insiders[\\/]/i.test(extensionDir) ? 'Code - Insiders' : 'Code';
  const user = join(env.APPDATA || '', product, 'User');
  if (/[\\/]\.vscode(-insiders)?[\\/]/i.test(extensionDir)) return { home: join(user, 'globalStorage', EXTENSION_ID), settingsFile: join(user, 'settings.json') };
  const own = env.LOCALAPPDATA || env.APPDATA ? join(env.LOCALAPPDATA || env.APPDATA, 'OneLake Studio', 'data')
    : join(env.HOME || homedir(), '.onelake-studio');
  return { home: own, settingsFile: join(own, 'settings.json') };
}

// VS Code's settings.json allows comments and trailing commas. Text in a string is left alone.
function parseSettings(text) {
  const plain = String(text).replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, m => (m[0] === '"' ? m : ''))
    .replace(/"(?:[^"\\]|\\.)*"|,(\s*[}\]])/g, (m, tail) => (m[0] === '"' ? m : tail));
  try {
    const v = JSON.parse(plain);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) { return {}; }
}

function readSettings(file) {
  try { return parseSettings(readFileSync(file, 'utf8')); } catch (_) { return {}; }
}

// A small JSON file with what VS Code's globalState and secrets hold there. Only this user can read it
// (their own profile's folder, and 0600 elsewhere). What's secret in it opens a local port, no more.
function keptIn(file) {
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (_) { return {}; } };
  const put = (key, value) => {
    const all = load();
    if (value === undefined) delete all[key]; else all[key] = value;
    const partial = `${file}.${process.pid}.tmp`;
    writeFileSync(partial, JSON.stringify(all), { mode: 0o600 });
    renameSync(partial, file);
  };
  return {
    get: (key, fallback) => { const v = load()[key]; return v === undefined ? fallback : v; },
    update: async (key, value) => put(key, value),
    store: async (key, value) => put(key, value),
  };
}

// The commit this build was packaged at (scripts/stage-webview.mjs writes it), as the status bar's stamp reads it.
function commitOf(extensionDir) {
  try { return String(JSON.parse(readFileSync(join(extensionDir, 'webview', 'build.json'), 'utf8')).commit || 'unknown'); }
  catch (_) { return 'unknown'; }
}

module.exports = { pathsOf, parseSettings, readSettings, keptIn, commitOf };
