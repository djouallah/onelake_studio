'use strict';
// diskuse.js — how much a folder holds, and removing it.

const { join } = require('node:path');
const fsp = require('node:fs/promises');

// The size of a directory's files, and their removal — for the disk cache.
async function dirBytes(dir) {
  if (!dir) return 0;
  let n = 0;
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    const st = await fsp.stat(join(dir, name)).catch(() => null);
    if (st && st.isFile()) n += st.size;
  }
  return n;
}
// The same with its subfolders, for what is kept in them: models by workspace.
async function treeBytes(dir) {
  let n = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) n += await treeBytes(join(dir, e.name));
    else n += (await fsp.stat(join(dir, e.name)).catch(() => ({ size: 0 }))).size;
  }
  return n;
}
const removeDir = dir => (dir ? fsp.rm(dir, { recursive: true, force: true }).catch(() => {}) : Promise.resolve());

module.exports = { dirBytes, treeBytes, removeDir };
