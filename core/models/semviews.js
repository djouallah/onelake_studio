'use strict';
// =============================================================================
// semviews.js — where this machine keeps its semantic views
// =============================================================================
// dax-sql's createViews() (app/semantic.js) knows what a view is; this only remembers which
// ones exist, so they survive a restart and the panel and the command line see the same
// list. A view is a pointer — { name, schema, path, created } — kept in the account's catalog file
// (catalogfile.js); its model file stays where it is and is read from there. Nothing is ever
// written to Fabric or OneLake. An older version's JSON file is read once and then deleted.
//
// A path is a local model file (a semantic model's local copy) or an abfss:// URL of one in a
// lakehouse's Files/. A view is kept when a model is opened — a click, or a query that names it. A model file is a .bim (TMSL) or an Apache Ossie
// model (.yaml or .yml); app/semantic.js reads either. `schema` is the model's workspace: SQL
// names it semanticmodel.ws.model. A semantic model opened from the tree is a local copy of its
// definition (extension.js fetchModel), and its view points at that.
// =============================================================================

const fsp = require('node:fs/promises');
const { join, dirname, relative, isAbsolute } = require('node:path');

const { ONELAKE_FILE_URL: ABFSS } = require('../names');

const exists = p => fsp.access(p).then(() => true, () => false);

/**
 * @param {object} o
 * @param {(account: string|null) => object} o.catalogFor  the account's catalog file (createCatalogFile)
 * @param {string} [o.dir]                        where an older version's JSON files are
 * @param {{ readBytes(ws: string, path: string): Promise<Uint8Array> }} o.onelake
 * @param {() => void} [o.onChange]               a view was kept or dropped
 * @param {(line: string) => void} [o.log]
 */
// One view: its name in its schema, ignoring case.
const sameView = (v, name, schema) =>
  v.name.toLowerCase() === String(name).toLowerCase() &&
  String(v.schema || '').toLowerCase() === String(schema || '').toLowerCase();

function createSemViews({ catalogFor, dir = null, onelake, onChange = () => {}, log = () => {} }) {
  let account = null;
  const catalog = () => {
    const file = catalogFor(account);
    if (dir) {
      const came = file.importViews(join(dir, `${account || 'signed-out'}.json`));
      if (came != null) log(`move: model pointers: ${came} came across from the JSON file, which is gone`);
    }
    return file;
  };

  // With no `id`, which is only how a row is found again. A file that can't be read holds no views.
  async function list() {
    try { return catalog().views().map(({ id, ...view }) => view); }
    catch (_) { return []; }
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
    useAccount(key) { account = key || null; },
    list,
    // Every view with its text, for defining them; one that cannot be read says why.
    async texts() {
      const out = [];
      for (const v of await list()) {
        try { out.push({ ...v, text: await readBim(v.path) }); }
        catch (e) { out.push({ ...v, error: e.message }); }
      }
      return out;
    },
    // One view with its text, or null when none is kept; one that cannot be read says why.
    async text(name, schema) {
      const v = (await list()).find(x => sameView(x, name, schema));
      if (!v) return null;
      try { return { ...v, text: await readBim(v.path) }; }
      catch (e) { return { ...v, error: e.message }; }
    },
    // Remembered (replacing the one of that name in that schema); the text is read first, so a
    // path that does not read is never stored.
    async put(name, path, schema = null) {
      const text = await readBim(path);
      const sch = schema ? String(schema) : null;
      catalog().keepView({ name: String(name), schema: sch, path, created: new Date().toISOString() }, v => sameView(v, name, sch));
      onChange();
      return { name: String(name), schema: sch, path, text };
    },
    // A copy under `accountDir` an earlier version named <model>.yaml is <model>.ossie.yaml now, the
    // name Ossie's own tools use: renamed, and its view pointed there. A file of the person's own,
    // anywhere else, is left as it is. Answers how many views moved.
    async renameCopies(accountDir) {
      let moved = 0;
      for (const v of await list()) {
        if (ABFSS.test(v.path) || !/\.yaml$/i.test(v.path) || /\.ossie\.yaml$/i.test(v.path)) continue;
        const rel = relative(accountDir, v.path);
        if (isAbsolute(rel) || rel.split(/[\\/]/)[0] === '..') continue;
        const to = v.path.replace(/\.yaml$/i, '.ossie.yaml');
        if (!await exists(to)) {
          if (!await exists(v.path)) continue;
          if (!await fsp.rename(v.path, to).then(() => true, () => false)) continue;
        }
        await this.put(v.name, to, v.schema);
        moved++;
      }
      return moved;
    },
    // A local copy from before they were kept per account sits in <root>/<workspace>/. The ones
    // this account opened move into `accountDir`, so they still open offline, and never over one
    // there. A copy no account points at is left where it is; nothing reads it now. Answers how
    // many views moved.
    async adoptCopies(root, accountDir) {
      let moved = 0;
      for (const v of await list()) {
        if (ABFSS.test(v.path)) continue;
        const rel = relative(root, v.path);
        const parts = rel.split(/[\\/]/);
        if (isAbsolute(rel) || parts[0] === '..' || parts.length !== 2) continue;
        const to = join(accountDir, ...parts);
        if (!await exists(to)) {
          if (!await exists(v.path)) continue;
          await fsp.mkdir(dirname(to), { recursive: true });
          const went = await fsp.rename(v.path, to).then(() => true, () => false);
          if (!went) continue;
        }
        await this.put(v.name, to, v.schema);
        moved++;
      }
      return moved;
    },
  };
}

module.exports = { createSemViews };
