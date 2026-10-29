'use strict';
// =============================================================================
// semviews.js — where this machine keeps its semantic views
// =============================================================================
// dax-sql's createViews() (app/semantic.js) knows what a view is; this only remembers which
// ones exist, so they survive a restart and the panel and the command line see the same
// list. A view is a pointer — { name, schema, path, created } — kept in one JSON file per Microsoft
// account, in the extension's own storage; its .bim stays where it is and is read from
// there. Nothing is ever written to Fabric or OneLake.
//
// A path is a local model file, an abfss:// URL of one in OneLake, or Files/… relative to a
// lakehouse (stored as its abfss:// URL). A model file is a .bim (TMSL) or an Apache Ossie
// model (.yaml or .yml); app/semantic.js reads either. `schema` is the model's workspace: SQL
// names it semanticmodel.ws.model. A semantic model opened from the tree is a local copy of its
// definition (extension.js fetchModel), and its view points at that.
// =============================================================================

const fsp = require('node:fs/promises');
const { join, dirname } = require('node:path');

const DFS_HOST = 'onelake.dfs.fabric.microsoft.com';
const ABFSS = /^abfss:\/\/([^@/]+)@onelake\.dfs\.fabric\.microsoft\.com\/(.+)$/i;

/**
 * @param {object} o
 * @param {string} o.dir                          where the per-account files live
 * @param {{ readBytes(ws: string, path: string): Promise<Uint8Array> }} o.onelake
 * @param {() => void} [o.onChange]               a view was kept or dropped
 */
// One view: its name in its schema, ignoring case.
const sameView = (v, name, schema) =>
  v.name.toLowerCase() === String(name).toLowerCase() &&
  String(v.schema || '').toLowerCase() === String(schema || '').toLowerCase();

function createSemViews({ dir, onelake, onChange = () => {} }) {
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
    if (!/\.(bim|ya?ml)$/i.test(path)) {
      throw new Error(`${path}: a semantic view is read from a .bim file (TMSL) or an Ossie .yaml file`);
    }
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
    // Remembered (replacing the one of that name in that schema); the text is read first, so a
    // path that does not read is never stored.
    async put(name, path, schema = null) {
      const text = await readBim(path);
      const sch = schema ? String(schema) : null;
      const entries = (await list()).filter(v => !sameView(v, name, sch));
      entries.push({ name: String(name), schema: sch, path, created: new Date().toISOString() });
      await save(entries);
      onChange();
      return { name: String(name), schema: sch, path, text };
    },
    async remove(name, schema = null) {
      const entries = await list();
      const left = entries.filter(v => !sameView(v, name, schema));
      if (left.length !== entries.length) { await save(left); onChange(); }
    },
  };
}

module.exports = { createSemViews };
