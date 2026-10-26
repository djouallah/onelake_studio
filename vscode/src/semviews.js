'use strict';
// =============================================================================
// semviews.js — where this machine keeps its semantic views
// =============================================================================
// dax-sql's createViews() (app/semantic.js) knows what a view is; this only remembers which
// ones exist, so they survive a restart and the panel and the command line see the same
// list. A view is a pointer — { name, path, created } — kept in one JSON file per Microsoft
// account, in the extension's own storage; its .bim stays where it is and is read from
// there. Nothing is ever written to Fabric or OneLake.
//
// A path is a local .bim, an abfss:// URL of a .bim in OneLake, or Files/….bim relative to
// a lakehouse (stored as its abfss:// URL).
// =============================================================================

const fsp = require('node:fs/promises');
const { join, dirname } = require('node:path');

const DFS_HOST = 'onelake.dfs.fabric.microsoft.com';
const ABFSS = /^abfss:\/\/([^@/]+)@onelake\.dfs\.fabric\.microsoft\.com\/(.+)$/i;

/**
 * @param {object} o
 * @param {string} o.dir                          where the per-account files live
 * @param {{ readBytes(ws: string, path: string): Promise<Uint8Array> }} o.onelake
 */
function createSemViews({ dir, onelake }) {
  let account = 'signed-out';
  const fileOf = () => join(dir, `${account}.json`);

  async function list() {
    try {
      const j = JSON.parse(await fsp.readFile(fileOf(), 'utf8'));
      return Array.isArray(j) ? j : [];
    } catch (_) { return []; }
  }
  async function save(entries) {
    await fsp.mkdir(dirname(fileOf()), { recursive: true });
    const tmp = `${fileOf()}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(entries, null, 2));
    await fsp.rename(tmp, fileOf());
  }

  // `Files/…` is relative to a lakehouse; everything else is already where it is.
  function resolve(path, lh) {
    const p = String(path).trim();
    if (/^\/?Files\//i.test(p)) {
      if (!lh || !lh.workspace || !lh.item) {
        throw new Error(`${p} is relative to a lakehouse — open one first, or give the abfss:// path`);
      }
      return `abfss://${lh.workspace}@${DFS_HOST}/${lh.item}/${p.replace(/^\//, '')}`;
    }
    return p;
  }

  async function readBim(path) {
    if (!/\.bim$/i.test(path)) throw new Error(`${path}: a semantic view is read from a .bim file (TMSL)`);
    const m = ABFSS.exec(path);
    const bytes = m ? await onelake.readBytes(m[1], m[2]) : await fsp.readFile(path);
    return Buffer.from(bytes).toString('utf8');
  }

  return {
    useAccount(key) { account = key || 'signed-out'; },
    list,
    resolve,
    readBim,
    // Every view with its text, for defining them; one that cannot be read says why.
    async texts() {
      const out = [];
      for (const v of await list()) {
        try { out.push({ ...v, text: await readBim(v.path) }); }
        catch (e) { out.push({ ...v, error: e.message }); }
      }
      return out;
    },
    // Remembered (replacing one of that name); the text is read first, so a path that does
    // not read is never stored.
    async put(name, path) {
      const text = await readBim(path);
      const entries = (await list()).filter(v => v.name.toLowerCase() !== String(name).toLowerCase());
      entries.push({ name: String(name), path, created: new Date().toISOString() });
      await save(entries);
      return { name: String(name), path, text };
    },
    async remove(name) {
      const entries = await list();
      const left = entries.filter(v => v.name.toLowerCase() !== String(name).toLowerCase());
      if (left.length !== entries.length) await save(left);
    },
    // The first time an account has none, the models already downloaded become views, as
    // they were before views were kept.
    async seed(found) {
      try { await fsp.access(fileOf()); return; } catch (_) {}
      await save(found.map(f => ({ name: f.name, path: f.path, created: new Date().toISOString() })));
    },
  };
}

module.exports = { createSemViews };
