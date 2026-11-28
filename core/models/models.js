'use strict';
// =============================================================================
// models.js — a semantic model's local copy, a notebook's, and what the cache can name
// =============================================================================

const { dirname, basename, resolve } = require('node:path');
const { existsSync, renameSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const fsp = require('node:fs/promises');
const { walkCached } = require('../onelake/onelake');
const { modelAccountDir, modelCopyPath, notebookCopyPath, notebookKind } = require('./fabric');
const { readFromOneLake } = require('./sqlendpoint');
const { fmtBytes, sqlKind, displayName, MODEL_KIND, modelSqlName, stripBom, splitItem, sqlPart } = require('../names');

// What Fabric says when asked for the definition of a model its Publish made of a semantic view (seen on
// every such model, 2026-11-19): such a model never opens, and the tree marks it as that.
const VIEW_MODEL_REFUSED = /configured by service apps|denied access to read the model/i;
const VIEW_MODEL = "a semantic view's model";

// A model file's model name: its file name with no model extension, `.ossie.yaml` being one, as Ossie's
// own tools name a model (sales.ossie.yaml is sales).
const modelNameOf = path => basename(path).replace(/(\.ossie)?\.(ya?ml|bim|tmdl)$/i, '') || basename(path);

/**
 * @param {object} o
 * @param {object} o.onelake  onelake.js
 * @param {object} o.fabric  fabric.js
 * @param {object} o.semviews  semviews.js
 * @param {() => Promise<object>} o.modules  the compiler and the page's modules (agent.js)
 * @param {() => string} o.modelsFolder  where the local copies are
 * @param {() => (string | null)} o.account  this account's folder there
 * @param {string} o.oldModels  where an older version kept them
 * @param {(list: object[]) => Promise<string[]>} o.nameTables  Direct Lake tables (by GUIDs) -> their SQL names (sqltables.js)
 * @param {(message: string) => void} o.notify  something the person should be told
 * @param {(node: object) => void} o.onModelChanged  a model's local copy came or went
 * @param {(line: string) => void} o.log
 */
function createModels({ onelake, fabric, semviews, modules, modelsFolder, account, oldModels, nameTables, notify, onModelChanged, log }) {
  // A model's local copy is kept per account (fabric.js modelCopyPath). The copies from before
  // that move once; opening a model waits for it, so it finds its copy where it now is.
  let modelsAdopted = Promise.resolve(0);
  // A model's local copy is data, so it is in the cache folder. Where an older version kept them, or
  // the cache folder that was (`from`, its models folder), the whole of this account's folder moves,
  // and each view is pointed at its new place.
  function adoptModels(from = oldModels) {
    modelsAdopted = modelsAdopted.then(async () => {
      const here = modelAccountDir(modelsFolder(), account()), before = modelAccountDir(from, account());
      let moved = 0;
      if (before !== here) {
        moved = from === oldModels ? await semviews.adoptCopies(oldModels, before) : 0;
        if (existsSync(before)) {
          await fsp.cp(before, here, { recursive: true, force: false });
          moved += await semviews.adoptCopies(before, here) + 1;
          await fsp.rm(before, { recursive: true, force: true });
          await fsp.rmdir(from).catch(() => {});
        }
      }
      log(moved ? `move: model copies: moved to ${here}, with ${moved - 1} views pointed there` : 'move: model copies: nothing to move');
      // Copies named <model>.yaml by an earlier version are <model>.ossie.yaml now, their views with them.
      const renamed = await semviews.renameCopies(here);
      if (renamed) log(`move: model copies: ${renamed} renamed <model>.ossie.yaml`);
      // Views named <model>.ossie after their file by an earlier version are <model> now.
      const ossie = await semviews.renameOssieViews(here);
      if (ossie) log(`move: model views: ${ossie} named without .ossie`);
      return moved;
    }).catch(e => {
      log(`move: the local copies of models could not be moved, and are tried again next time — ${e.message}`);
      return 0;
    });
    return modelsAdopted;
  }

  // What Go To can name, kept for a moment (completionNames below).
  let namesKept = null;

  // A copy an earlier version named <model>.yaml, and no view points at, is renamed when first looked for.
  const modelPath = n => {
    const path = modelCopyPath(modelsFolder(), account(), n.workspace, n.model);
    const old = path.replace(/\.ossie\.yaml$/, '.yaml');
    if (!existsSync(path) && existsSync(old)) { try { renameSync(old, path); } catch (_) { /* kept as it is */ } }
    return path;
  };

  // A model's local copy (fetchModel), when there is one: the tree's check mark.
  const modelKey = n => `${n.workspace}|${n.modelId}`;
  const cachedModel = n => (existsSync(modelPath(n)) ? modelPath(n) : null);

  // Models a click found it cannot open (Import, DirectQuery, Direct Lake over a SQL endpoint),
  // for this session: key -> what kind it is. The tree marks them,
  // and a second click says so again without reading the definition from Fabric again.
  const unsupportedModels = new Map();
  const unsupportedNote = (n, mode) => (mode === VIEW_MODEL
    ? `${n.model} is the model Fabric's Publish made of a semantic view, and Fabric lets no one read its definition. ` +
      `Open the view instead: Context/Semantic Views/${n.model} in its lakehouse.`
    : `${n.model} is ${mode}. OneLake Studio opens Direct Lake models whose tables it can find in OneLake.`);

  // A semantic model, opened from the tree or named by a query: its definition (Fabric's
  // getDefinition, TMSL), kept as a local copy in Apache Ossie — modelPath(n), ~/OneLakeStudio/
  // semantic-models/<account>/<workspace>/<model>.yaml — and read from there after. Nothing is written to OneLake, so a
  // user who may only read the workspace opens and queries a model all the same. A model over a SQL endpoint is kept as one over the
  // item behind it (sqlendpoint.js). A model with no tables in OneLake is refused, and nothing is
  // kept. `fresh` reads Fabric again, over the local copy.
  // `${path}|${fresh}`, lower-cased -> Promise<{ path, text }>: a fresh read never joins one that
  // may answer from the local copy, and one account's never joins another's.
  const fetching = new Map();
  const writeWhole = async (to, body) => {
    const partial = `${to}.${process.pid}.tmp`;
    await fsp.writeFile(partial, body);
    await fsp.rename(partial, to).catch(async e => { await fsp.rm(partial, { force: true }).catch(() => {}); throw e; });
  };
  // The model Fabric's Publish made of a semantic view, from the TMDL it wrote: <lakehouse>/SystemContext/Semantic
  // Views/<model>/, in the lakehouse whose metadata.json there names this model (modelObjectId). As TMSL bytes, as
  // getBim answers; null when no lakehouse of the workspace has it.
  async function publishedTmsl(n) {
    const dir = `Semantic Views/${n.model}`;
    for (const l of (await fabric.listItems(n.workspace)).filter(i => i.type === 'Lakehouse')) {
      const item = `${l.name}.Lakehouse`;
      let meta;
      try {
        meta = JSON.parse(stripBom(Buffer.from(await onelake.readBytes(n.workspace, `${item}/SystemContext/${dir}/metadata.json`)).toString('utf8')));
      } catch (_) { continue; }   // not this lakehouse's view
      if (String(meta && meta.modelObjectId).toLowerCase() !== String(n.modelId).toLowerCase()) continue;
      const tmdl = (await onelake.files({ workspace: n.workspace, item, area: 'SystemContext' }, dir, { fresh: true }))
        .find(e => !e.isDir && /\.tmdl$/i.test(e.name));
      if (!tmdl) return null;
      const text = stripBom(Buffer.from(await onelake.readBytes(n.workspace, tmdl.path)).toString('utf8'));
      const { compiler } = await modules();
      return Buffer.from(JSON.stringify(compiler.tmdlToTmsl(text)));
    }
    return null;
  }
  function fetchModel(n, { fresh = false, say = () => {} } = {}) {
    const path = modelPath(n);
    const key = `${path}|${!!fresh}`.toLowerCase();
    if (!fetching.has(key)) fetching.set(key, (async () => {
      await modelsAdopted;
      if (!fresh) {
        const kept = await fsp.readFile(path, 'utf8').catch(() => null);
        if (kept != null) return { path, text: kept };
      }
      say('reading its definition from Fabric…');
      let bim;
      try { bim = await fabric.getBim(n.workspace, n.modelId); }
      catch (e) {
        // A semantic view's model (Fabric's Publish made it): Fabric refuses its definition to everyone, but
        // wrote it whole as TMDL beside the view. Read from there; with none found, it is said what it is.
        if (!VIEW_MODEL_REFUSED.test(String((e && e.message) || ''))) throw e;
        say("reading it from its semantic view's TMDL…");
        bim = await publishedTmsl(n).catch(err => { log(`${n.workspace}/${n.model}: its TMDL could not be read — ${err.message}`); return null; });
        if (!bim) {
          unsupportedModels.set(modelKey(n), VIEW_MODEL);
          onModelChanged(n);
          throw Object.assign(new Error(unsupportedNote(n, VIEW_MODEL)), { unsupported: true });
        }
        log(`${n.workspace}/${n.model}: a semantic view's model, read from its TMDL in SystemContext/`);
      }
      let doc;
      try { doc = JSON.parse(stripBom(Buffer.from(bim).toString('utf8'))); }
      catch (e) { throw new Error(`its definition is not TMSL: ${e.message}`); }
      const { semantic, compiler } = await modules();
      const read = await readFromOneLake(doc, n.workspace, { fabric, onelake });
      if (read.refused || !semantic.lakehousesOf(doc).length) {
        const mode = read.refused || semantic.storageMode(doc);
        if (read.why) log(`${n.workspace}/${n.model}: ${read.why}`);
        unsupportedModels.set(modelKey(n), mode);
        onModelChanged(n);
        throw Object.assign(new Error(unsupportedNote(n, mode)), { unsupported: true });
      }
      unsupportedModels.delete(modelKey(n));
      for (const note of read.notes) {
        log(`${n.workspace}/${n.model}: ${note}`);
        notify(`${n.model}: ${note}`);
      }
      // A model over one lakehouse of its own workspace names each table item.schema.table, as
      // Fabric's SQL endpoint does: the copy says where its data is by name alone, with no
      // Direct Lake expression of GUIDs, and reads offline with nothing to look up but the
      // tree's listing. One over several lakehouses, or another workspace's, keeps its expression.
      const lake = [...semantic.directLakeTables(doc)].filter(([, l]) => l.lh);
      let names = null;
      if (lake.length) {
        try {
          const idents = await nameTables(lake.map(([, l]) => ({ ...l.lh, ...l.t })));
          // ws.item.schema.table, an item other than a lakehouse with its kind after it: the item is its name alone
          // in item.schema.table.
          const parts = idents.map(semantic.nameParts);
          const items = new Set(parts.map(p => JSON.stringify(p.slice(0, 2).map(semantic.unquote)).toLowerCase()));
          const part = parts.length ? semantic.unquote(parts[0][1]) : null;
          const item = part == null ? null : (splitItem(part) || { item: part }).item;
          if (items.size === 1 && item != null && same(semantic.unquote(parts[0][0]), n.workspace)) {
            names = new Map(lake.map(([table], i) => [table, [sqlPart(item), ...parts[i].slice(2)].join('.')]));
          }
        } catch (e) {
          log(`${n.workspace}/${n.model}: its tables could not be named, so the copy keeps their Direct Lake expression — ${e.message}`);
        }
      }
      // lineWidth 0: a long DAX expression stays on its lines, not folded to the page's width.
      const ossie = compiler.tmslToOssie(doc, n.model, names ? { source: t => names.get(t.name.toLowerCase()) ?? null } : {});
      const text = compiler.stringifyYaml(ossie, { lineWidth: 0 });
      await fsp.mkdir(dirname(path), { recursive: true });
      // Whole or not at all: this file is what later opens trust, with nothing to say it was cut short.
      await writeWhole(path, text);
      log(`downloaded ${n.workspace}/${n.model} -> ${path} (${fmtBytes(Buffer.byteLength(text))})`);
      onModelChanged(n);
      return { path, text };
    })().finally(() => fetching.delete(key)));
    return fetching.get(key);
  }

  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const samePath = (a, b) => (process.platform === 'win32' ? same(resolve(a), resolve(b)) : resolve(a) === resolve(b));

  // Every table the store has seen, with its columns if they were read, as its SQL name's parts: a
  // walk of the cache alone (the command line's `find` walks it the same way).
  async function walkTables() {
    const { paths } = await modules();
    const found = [];
    const all = await walkCached(onelake.cached);
    for (const w of (all && all.workspaces) || []) {
      // Its semantic models, as the Fabric listing has them: ws.model_semanticmodel.
      for (const m of w.models) found.push({ kind: MODEL_KIND, workspace: w.name, model: m.name, modelId: m.id });
      for (const it of w.items) {
        const kind = sqlKind(it.kind);
        if (!kind) continue;
        for (const t of it.tables || []) {
          if (t.meta && t.meta.notValid) continue;
          const fields = t.meta && t.meta.schemaFields;
          // itemDir: the item as the tree knows it (data.Lakehouse), to open the table there.
          const named = { kind, workspace: w.name, item: displayName(it.name), itemDir: it.name, schema: t.schema || 'dbo', table: t.table };
          if (!fields || !fields.length) { found.push(named); continue; }
          found.push(t.meta.empty
            ? { ...named, emptySql: paths.emptyTableSql(fields) }
            : { ...named, columns: fields.map(f => ({ name: f.name, type: paths.icebergToDuckType(f.type) })) });
        }
      }
    }
    // And every model kept as a view: Fabric's, or a model file opened from a lakehouse's Files/.
    for (const v of await semviews.list()) {
      if (v.schema) found.push({ kind: MODEL_KIND, workspace: v.schema, model: v.name });
    }
    return found;
  }

  // A semantic model a query names that no view has yet: found in its workspace's model
  // listing (the cache's, else Fabric's), its local copy kept (fetchModel), and kept as a view.
  // Answers the view as semviews keeps it, with its text: { name, schema, path, text }.
  const openSqlModel = async ({ workspace, model }) => {
    const full = modelSqlName(workspace, model);
    const workspaces = await onelake.workspaces().catch(() => []);
    const ws = workspaces.find(w => same(w, workspace)) || String(workspace);
    const pick = list => (list || []).find(m => same(m.name, model));
    const kept = await onelake.cached.models(ws);
    let hit = pick(kept && kept.value);
    // Not in the kept listing is not an answer yet: a model made since. Past the cache.
    if (!hit) {
      hit = pick(await onelake.models(ws, { fresh: true }).catch(e => {
        throw new Error(`${full}: the semantic models of ${ws} could not be listed — ${e.message}`);
      }));
    }
    if (!hit) throw new Error(`${full}: there is no semantic model ${model} in workspace ${ws}`);
    const { path } = await fetchModel({ workspace: ws, model: hit.name, modelId: hit.id });
    log(`opened ${full} for a query, from ${path}`);
    return semviews.put(hit.name, path, ws);
  };

  // A model file on this machine (an Ossie .yaml, a .bim or a TMDL script, opened from disk): its text, its model's name, and the workspace its tables are in when that can be
  // known with no question asked. Its tables are always OneLake's. One named <lakehouse>.<schema>.<table>
  // is in the model's workspace, which the file doesn't say: the one this file was opened in before, if
  // it still holds those lakehouses, else `workspace` is null and `choices` are the workspaces whose
  // kept listing holds them all (`all` when none does). The cache alone, so it works offline.
  //
  // A file whose tables are schema.table and nothing more, as a Fabric semantic view's YAML names them, says no
  // lakehouse: Fabric reads them in the lakehouse the YAML is in. Here, the one picked for this file before
  // (`lakehouse`, kept by semviews.place), else `lakehouse` is null with `bare`, its tables, and `candidates`,
  // every cached lakehouse holding them all ({ workspace, lakehouse }), and `lakehousesAll`, every cached one.
  async function modelFile(path) {
    const name = basename(path);
    const text = await fsp.readFile(path, 'utf8').catch(e => { throw new Error(`${name} could not be read: ${e.message}`); });
    const { semantic, compiler } = await modules();
    // What dax-sql's formatOf says is no model (a dbt schema.yml, one file of a Power BI project) opens as text.
    if (/\.(ya?ml|tmdl)$/i.test(path) && !compiler.formatOf(path, text)) {
      throw Object.assign(new Error(/\.tmdl$/i.test(path)
        ? `${name} is one file of a TMDL definition, not a whole model: open the model's folder in Power BI, or a TMDL script`
        : `${name} is not an Apache Ossie model: it has no top-level version and datasets`), { notModel: true });
    }
    const bim = semantic.bimOf(path, text, compiler);
    const lakes = semantic.lakehousesOf(bim);
    const model = modelNameOf(path);
    const byId = [...new Set(lakes.filter(l => l.workspace).map(l => l.workspace))];
    const byName = [...new Map(lakes.filter(l => !l.workspace).map(l => [l.itemName.toLowerCase(), l.itemName])).values()];
    const bare = semantic.bareTables(bim);
    if (!lakes.length && bare.length) return placeBare({ path, text, model, bare });
    if (!lakes.length) throw new Error(`${name} reads no lakehouse: its tables are named <lakehouse>.<schema>.<table>, or read through a Direct Lake expression`);
    if (byId.length > 1) throw new Error(`${name} reads ${byId.length} workspaces, and a model is in one`);
    const holds = async ws => {
      const items = await onelake.cached.items(ws);
      const have = new Set(((items && items.value) || []).filter(i => sqlKind(i.kind)).map(i => displayName(i.name).toLowerCase()));
      return byName.every(n => have.has(n.toLowerCase()));
    };
    if (byId.length) {
      const it = await onelake.itemNamed(byId[0], lakes.find(l => l.workspace).item)
        .catch(e => { throw new Error(`the name of ${name}'s workspace could not be read: ${e.message}`); });
      if (!await holds(it.workspace)) throw new Error(`${name} names a lakehouse its workspace ${it.workspace} doesn't hold: ${byName.join(', ')}`);
      return { text, model, workspace: it.workspace };
    }
    const kept = (await semviews.list()).find(v => v.schema && samePath(v.path, path));
    if (kept && await holds(kept.schema)) return { text, model: kept.name, workspace: kept.schema };
    const listed = await onelake.cached.workspaces();
    const all = (listed && listed.value) || [];
    const choices = [];
    for (const ws of all) if (await holds(ws)) choices.push(ws);
    return { text, model, workspace: null, lakehouses: byName, choices, all };
  }

  // modelFile's schema.table case. The cache alone: a lakehouse whose tables were never listed here is
  // only in `lakehousesAll`, to be picked by hand.
  async function placeBare({ path, text, model, bare }) {
    const kept = await semviews.placement(path);
    const all = [];
    const candidates = [];
    const tree = await walkCached(onelake.cached);
    for (const w of (tree && tree.workspaces) || []) {
      for (const it of w.items) {
        if (sqlKind(it.kind) !== 'lakehouse') continue;
        const at = { workspace: w.name, lakehouse: displayName(it.name) };
        all.push(at);
        const have = new Set((it.tables || []).map(t => `${(t.schema || 'dbo').toLowerCase()}.${String(t.table).toLowerCase()}`));
        if (bare.every(b => have.has(`${b.schema.toLowerCase()}.${b.entity.toLowerCase()}`))) candidates.push(at);
      }
    }
    if (kept) {
      return { text, model, workspace: kept.workspace, lakehouse: kept.lakehouse, bare, candidates, lakehousesAll: all, kept: true };
    }
    return { text, model, workspace: null, lakehouse: null, bare, candidates, lakehousesAll: all };
  }

  // What Go to can name, from the cache alone (cachedSqlTables, below): every cached table
  // with its columns, every semantic model, and the measures of a model kept as a view (its
  // local file; one in OneLake gives its name only). Read again after a minute.
  function completionNames() {
    if (namesKept && Date.now() - namesKept.at < 60_000) return namesKept.value;
    const value = (async () => {
      const found = await walkTables();
      const tables = found.filter(f => f.kind !== MODEL_KIND && f.table).map(f => ({ ...f, columns: f.columns || [] }));
      const models = new Map();
      for (const f of found) {
        if (f.kind !== MODEL_KIND) continue;
        const key = `${f.workspace}|${f.model}`.toLowerCase();
        const m = models.get(key);
        if (m) m.modelId = m.modelId || f.modelId;
        else models.set(key, { workspace: f.workspace, model: f.model, modelId: f.modelId, measures: [] });
      }
      for (const v of await semviews.list().catch(() => [])) {
        const m = v.schema && v.path && models.get(`${v.schema}|${v.name}`.toLowerCase());
        if (!m) continue;
        try {
          const { semantic, compiler } = await modules();
          const bim = semantic.bimOf(v.path, await fsp.readFile(v.path, 'utf8'), compiler);
          for (const t of (bim.model || bim).tables || []) for (const x of t.measures || []) m.measures.push(x.name);
        } catch (_) { /* a file in OneLake, or one that cannot be read: its name alone */ }
      }
      return { tables, models: [...models.values()] };
    })();
    namesKept = { at: Date.now(), value };
    value.catch(() => { namesKept = null; });
    return value;
  }

  // A Fabric Python notebook's local copy, the one VS Code opens, edits and runs: notebookCopyPath, beside its
  // workspace's models. Beside it, <copy>.sync.json says what the copy and Fabric held when they last agreed (a
  // read, or a Publish), as hashes: `local`, the copy's text then, and `fabric`, Fabric's definition then.
  // Fewest Fabric calls: a definition is read once and kept, whoever read it (the tree's check of what a notebook
  // runs on keeps it too, keepNotebook), and served from here after.
  // - A click opens the copy kept, with no call. It reads Fabric only when there is none, or a Refresh of the
  //   workspace's notebooks marked it `stale`; never over changes made here (edits, or a run's outputs), which stay
  //   until they are published or given up.
  // - Publish writes the copy to Fabric, unless Fabric's definition changed since they last agreed: then the person
  //   picks, overwrite theirs or take theirs (what the check read, kept with no second read). With no record of
  //   agreeing, Fabric's differing from the copy is a change.
  const notebookPath = n => notebookCopyPath(modelsFolder(), account(), n.workspace, n.notebook);
  const cachedNotebook = n => (existsSync(notebookPath(n)) ? notebookPath(n) : null);
  const syncPath = path => `${path}.sync.json`;
  // An .ipynb's hash, as its JSON says it: its whitespace is no change. Text that is not JSON hashes as it is.
  const hashOf = text => {
    let s = String(text);
    try { s = JSON.stringify(JSON.parse(stripBom(s))); } catch (_) { /* as it is */ }
    return createHash('sha256').update(s).digest('hex');
  };
  const readSync = path => { try { return JSON.parse(readFileSync(syncPath(path), 'utf8')); } catch (_) { return null; } };
  const writeSync = (path, local, fabricHash) => writeWhole(syncPath(path), JSON.stringify({ local: hashOf(local), fabric: fabricHash }));
  // Whether the copy has changes Fabric does not: true, false, or null with no copy.
  function notebookEdited(n) {
    const path = notebookPath(n);
    let text;
    try { text = readFileSync(path, 'utf8'); } catch (_) { return null; }
    const sync = readSync(path);
    return !!sync && hashOf(text) !== sync.local;
  }
  // Fabric's .ipynb as the copy, over whatever the copy held.
  async function writeCopy(path, nb) {
    const text = JSON.stringify(nb, null, 1);
    await fsp.mkdir(dirname(path), { recursive: true });
    await writeWhole(path, text);
    await writeSync(path, text, hashOf(JSON.stringify(nb)));
  }
  const sparkError = n => Object.assign(
    new Error(`${n.notebook} is a Spark notebook: it runs on Fabric's Spark only, not on this machine`), { spark: true });
  // { path, fresh, edited }: `fresh` when just read from Fabric, `edited` when the copy's own changes were kept.
  // `discard`: Fabric's version over the copy, changes and all (Take theirs); `theirs`, that version as already read.
  async function fetchNotebook(n, { offline = false, discard = false, theirs = null } = {}) {
    const path = notebookPath(n);
    if (!discard) {
      if (notebookEdited(n)) return { path, fresh: false, edited: true };
      const sync = readSync(path);
      if (existsSync(path) && (offline || !(sync && sync.stale))) return { path, fresh: false, edited: false };
    }
    if (offline && !theirs) {
      if (existsSync(path)) return { path, fresh: false, edited: false };
      throw new Error(`${n.notebook} was never opened here, and reading it from Fabric needs a connection`);
    }
    const nb = theirs || await fabric.getNotebook(n.workspace, n.notebookId);
    if (notebookKind(nb) === 'spark') throw sparkError(n);
    await writeCopy(path, nb);
    return { path, fresh: true, edited: false };
  }
  // A definition read for another reason (what the notebook runs on), kept as its copy: a Python notebook's, and
  // never over changes made here.
  async function keepNotebook(n, nb) {
    if (notebookKind(nb) !== 'python' || notebookEdited(n)) return;
    await writeCopy(notebookPath(n), nb);
  }
  // Refresh of a workspace's notebooks: each copy kept with no changes of its own is read from Fabric again on its
  // next click, not before (no call now).
  async function staleNotebooks(workspace) {
    const dir = dirname(notebookCopyPath(modelsFolder(), account(), workspace, 'x'));
    const names = await fsp.readdir(dir).catch(() => []);
    for (const name of names.filter(f => f.endsWith('.ipynb.sync.json'))) {
      const at = resolve(dir, name);
      try {
        const sync = JSON.parse(await fsp.readFile(at, 'utf8'));
        if (!sync.stale) await writeWhole(at, JSON.stringify({ ...sync, stale: true }));
      } catch (_) { /* one that cannot be read is read again anyway */ }
    }
  }
  // The copy, to Fabric. { conflict: true, theirs } when Fabric changed since they last agreed and `overwrite` is not
  // set: nothing is written, and `theirs` is Fabric's version, for Take theirs. Else { published: true }.
  async function publishNotebook(n, { overwrite = false } = {}) {
    const path = notebookPath(n);
    const text = await fsp.readFile(path, 'utf8').catch(() => null);
    if (text == null) throw new Error(`${n.notebook} has no copy here to publish: open it first`);
    let nb;
    try { nb = JSON.parse(stripBom(text)); } catch (e) { throw new Error(`${n.notebook} is not a valid .ipynb: ${e.message}`); }
    if (!overwrite) {
      const sync = readSync(path);
      const theirs = await fabric.getNotebook(n.workspace, n.notebookId);
      if (hashOf(JSON.stringify(theirs)) !== (sync ? sync.fabric : hashOf(text))) return { conflict: true, theirs };
    }
    await fabric.updateNotebook(n.workspace, n.notebookId, nb);
    // What Fabric holds now, as it says it: the next Publish compares with this.
    const now = await fabric.getNotebook(n.workspace, n.notebookId).catch(e => {
      log(`${n.workspace}/${n.notebook}: published, and could not be read back — ${e.message}`);
      return nb;
    });
    await writeSync(path, text, hashOf(JSON.stringify(now)));
    return { published: true };
  }

  return {
    adoptModels, adopted: () => modelsAdopted,
    modelPath, modelKey, cachedModel, unsupportedModels, unsupportedNote,
    notebookPath, cachedNotebook, notebookEdited, fetchNotebook, keepNotebook, staleNotebooks, publishNotebook,
    fetchModel, walkTables, openSqlModel, completionNames, modelFile,
    forgetNames: () => { namesKept = null; },
  };
}

module.exports = { createModels, modelNameOf };
