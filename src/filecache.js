'use strict';
// =============================================================================
// filecache.js — an account's cache folder, settled for the lake once
// =============================================================================
// A OneLake table's files are kept whole under lake/ (tableservice.js). A folder from before the lake held
// what DuckDB had read in blocks, each a file of its own, and a copy of each Delta table's log under delta/:
// neither is read again, so both go, once. host/, models/ and what the table read API answered stay.
// No DuckDB here: the window loads this at activation, before the engine reads from the folder.
// =============================================================================

const fsp = require('node:fs/promises');
const { join } = require('node:path');

const LAYOUT = 'lake 1';

/**
 * A folder written before the lake: its blocks and its delta/ go. Answers whether they did, since what was
 * kept whole is then not here. The note is beside the folder, not in it.
 * @param {string} dir  an account's cache folder (engines.js fileCacheDirFor)
 */
async function settleFileCache(dir) {
  const note = `${dir}.layout`;
  if (await fsp.readFile(note, 'utf8').catch(() => null) === LAYOUT) return false;
  const old = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(note, LAYOUT);
  // Not waited for: tens of thousands of files.
  (async () => {
    for (const d of old) {
      if (d.isFile()) await fsp.rm(join(dir, d.name), { force: true }).catch(() => {});
      else if (d.name === 'delta') await fsp.rm(join(dir, d.name), { recursive: true, force: true }).catch(() => {});
    }
  })();
  return true;
}

module.exports = { settleFileCache, LAYOUT };
