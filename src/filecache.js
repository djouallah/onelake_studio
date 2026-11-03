'use strict';
// =============================================================================
// filecache.js — the disk cache's block size, and a folder written at another one
// =============================================================================
// cache_httpfs keeps what DuckDB reads from OneLake in blocks, each a file of its own on disk and a request
// of its own to OneLake. Its 512 KiB made a 9 GB table 18,000 files, each opened on every scan. The engine
// sets this size (engine-host.js); the window settles the folder before the engine reads from it.
// No DuckDB here: the window loads this at activation.
// =============================================================================

const fsp = require('node:fs/promises');
const { join } = require('node:path');

const FILE_CACHE_BLOCK = 4 * 1024 * 1024;
const LAYOUT = `block ${FILE_CACHE_BLOCK}`;

/**
 * A folder written at another block size: its blocks are never read again, as a block's name has its size
 * in it, so they go. Answers whether they did, since what was kept whole is then not here. The note is
 * beside the folder, not in it: cache_httpfs takes every file in it for a block. delta/ stays, and a
 * block written after the folder was listed is the new size's.
 * @param {string} dir  an account's disk cache folder (engines.js fileCacheDirFor)
 */
async function settleFileCache(dir) {
  const note = `${dir}.layout`;
  if (await fsp.readFile(note, 'utf8').catch(() => null) === LAYOUT) return false;
  const old = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(note, LAYOUT);
  // Not waited for: tens of thousands of files, and one removed under a read is only a cache miss.
  (async () => {
    for (const d of old) if (d.isFile()) await fsp.rm(join(dir, d.name), { force: true }).catch(() => {});
  })();
  return true;
}

module.exports = { FILE_CACHE_BLOCK, settleFileCache };
