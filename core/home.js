'use strict';
// =============================================================================
// home.js — where this install keeps its files, and what it remembers there, with no editor
// =============================================================================
// VS Code hands the extension its storage folder, its settings and its globalState. The command line with
// VS Code closed and the desktop app have none of that, and read the same places themselves, so all three
// share one cache. No `vscode` import.
// =============================================================================

const { join } = require('node:path');
const { readFileSync, writeFileSync, renameSync, existsSync } = require('node:fs');

const EXTENSION_ID = 'djouallah.onelake-studio';

// Where VS Code keeps this extension's files, for whichever VS Code this install is under, so the extension,
// the command line and the desktop app read one cache. With no VS Code, the app's own folder.
// ONELAKE_STUDIO_HOME keeps it all somewhere else.
function pathsOf(extensionDir, env = process.env, exists = existsSync) {
  if (env.ONELAKE_STUDIO_HOME) return { home: env.ONELAKE_STUDIO_HOME, settingsFile: join(env.ONELAKE_STUDIO_HOME, 'settings.json') };
  const product = /[\\/]\.vscode-insiders[\\/]/i.test(extensionDir) ? 'Code - Insiders' : 'Code';
  const user = join(env.APPDATA || '', product, 'User');
  const vscodeHome = join(user, 'globalStorage', EXTENSION_ID);
  if (exists(vscodeHome) || /[\\/]\.vscode(-insiders)?[\\/]/i.test(extensionDir)) return { home: vscodeHome, settingsFile: join(user, 'settings.json') };
  const own = join(env.LOCALAPPDATA || env.APPDATA || '', 'OneLake Studio', 'data');
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

module.exports = { pathsOf, parseSettings, readSettings, keptIn };
