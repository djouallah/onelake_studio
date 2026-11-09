'use strict';
// =============================================================================
// exportflow.js — Export to Fabric, from the first question to the published app
// =============================================================================
// Every question goes through `ui`, so whoever is showing this decides how it is asked.
// =============================================================================

const { join, dirname } = require('node:path');
const os = require('node:os');
const { existsSync } = require('node:fs');
const fsp = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { PINS } = require('./vendored');
const { planExport, planOnModel, modelDoc, appFiles, setModel, engineOf, readApp, writeApp, vendorFiles, vendorSize, buildDist,
        fingerprint, localChanges, zip, rayfinYml, REPORT } = require('./exportapp');
const { createFabricApp, tenantOf } = require('./fabricapp');
const { createFabricModel } = require('./fabricmodel');
const { semanticTmsl, definitionOf, MODES } = require('./pbimodel');

// A semantic model's storage mode, as Create Semantic Model's dialog and the command line's --mode
// name it. Neither says: Direct Lake.
const MODE_OF = { directquery: 'directQuery', directlake: 'directLake' };
// What a zip's site runs on, as the questions say it (exportapp.js engineOf).
const RUNS_ON = { duckdb: 'Client side', directLake: 'Direct Lake', directQuery: 'DirectQuery', semanticModel: 'a semantic model' };
// An earlier export's local copy was a folder, <app>/, with this marker in it.
const OLD_MARKER = '.onelake-studio-export.json';
const oldMarker = dir => fsp.readFile(join(dir, OLD_MARKER), 'utf8')
  .then(t => { const m = JSON.parse(t); delete m.files; return m; }, () => null).catch(() => null);
// Which zip a model's Report tab reads: the model by its workspace and its name, as the page knows it.
const reportKey = (workspace, model) => `exportReport:${String(workspace).toLowerCase()}/${String(model).toLowerCase()}`;
// The file a model's Report is kept in before it has a zip, in `reportDir`: by the same names.
const reportName = (workspace, model) =>
  `${createHash('sha1').update(`${String(workspace).toLowerCase()}/${String(model).toLowerCase()}`).digest('hex')}.json`;

/**
 * @param {object} o
 * @param {object} o.connectivity  connectivity.js
 * @param {() => Promise<object>} o.modules  the compiler and the page's modules (agent.js)
 * @param {Function} o.appToken  the Fabric API's own audience (signin.js)
 * @param {Function} [o.powerBiToken]  the Power BI API's (signin.js fabricToken): a semantic model's refresh, its credentials
 * @param {Function} [o.sqlToken]  the SQL endpoint's: a DirectQuery model's credentials
 * @param {object} o.fabric  fabric.js
 * @param {{ get: Function, update: Function }} o.memento  where each app's zip was approved last time
 * @param {string} o.extensionDir  where this install's files are
 * @param {string} [o.reportDir]  where a model's Report is kept until its first export (Add to report)
 * @param {() => Promise<string>} o.pageDir  where the page's files are
 * @param {object} o.ui  info, warn, pickFolder, openFolder, withProgress, openExternal, reveal
 * @param {(node: object) => void} o.onRefresh  this part of the tree changed
 * @param {(line: string) => void} o.log
 */
function createExport({ connectivity, modules, appToken, powerBiToken = appToken, sqlToken = async () => null, fabric,
                        memento, extensionDir, reportDir = null, pageDir, ui, onRefresh, log,
                        fabricModel = createFabricModel({ getToken: appToken, powerBiToken, sqlToken, log: m => log(m) }) }) {

  // DirectQuery: the semantic model reads the lakehouse through its SQL endpoint, by the
  // lakehouse's name there.
  async function sqlEndpointOf(plan) {
    const lh = await fabric.itemOf(plan.workspace, plan.lakehouse);
    const name = lh.item.replace(/\.Lakehouse$/i, '');
    const ep = (await fabric.sqlEndpoints(plan.workspace)).find(e => e.type === 'Lakehouse' && e.name.toLowerCase() === name.toLowerCase());
    if (!ep) throw new Error(`the lakehouse ${name} has no SQL endpoint yet: open it in Fabric once, or export it as Direct Lake`);
    return { host: String(ep.host).replace(/,\d+$/, ''), database: ep.name };
  }

  // The lakehouses a model reads, by GUIDs: the app's catalog is addressed by them. One its
  // tables name <lakehouse>.<schema>.<table> is in `workspace` (the model's, or the file's), and
  // is looked up by name in Fabric.
  async function lakesOf(text, file, workspace) {
    const { semantic, compiler } = await modules();
    return Promise.all(semantic.lakehousesOf(semantic.bimOf(file, text, compiler), workspace).map(async l => {
      if (l.workspace) return l;
      if (!l.workspaceName) throw new Error(`${file} names its lakehouse ${l.itemName} with no workspace`);
      const items = await fabric.listItems(l.workspaceName);
      const it = items.find(i => i.type === 'Lakehouse' && i.name.toLowerCase() === l.itemName.toLowerCase());
      if (!it) throw new Error(`workspace ${l.workspaceName} has no lakehouse ${l.itemName}`);
      return { workspace: String(await fabric.workspaceId(l.workspaceName)).toLowerCase(), item: String(it.id).toLowerCase() };
    }));
  }

  // Export to Fabric, from Explore: the model's Report and Explore as a Fabric app (exportapp.js),
  // its local copy one zip, <the open folder>/<app>.zip (asked for when no folder is open) —
  // and published from it over the Fabric REST API (fabricapp.js). The function's deploy
  // package ships in the vsix (fabric-function/, scripts/function-bundle.mjs). Answers what
  // Explore's info line says; a failure is thrown back to it, and logged. So is the user's No
  // (`declined`), which is no failure, but must not read as a publish on the command line.
  // What the app runs on is what was opened, and nothing is asked: a model file in OneLake
  // (`workspace`, `path`) is read client side, DuckDB in the browser over its lakehouse's tables; a
  // Power BI semantic model opened from the tree (`model`, its local copy) is queried as it is,
  // Direct Lake, DirectQuery or Import, and the export writes nothing to it and nothing for it. A
  // semantic model of a model file is Create Semantic Model's, then exported as it is.
  const exportExplore = async ({ file, name, text, state, workspace, path, model }) => {
    const declined = message => Object.assign(new Error(message), { declined: true });
    try {
      // The one thing that can't work from what is held, said before anything is asked.
      if (connectivity.offline()) {
        throw new Error(`Export to Fabric needs a connection, and ${connectivity.noInternet() ? 'there is no internet' : 'you are not signed in'}.`);
      }
      const onItself = !path;
      if (onItself && !(model && model.workspace && model.name)) {
        throw new Error('Export to Fabric needs a model that is a OneLake file, or one opened from the tree');
      }
      // The semantic model's workspace and name: the model's own (semanticmodel.<ws>.<model>).
      const pbi = { workspace: model ? model.workspace : workspace, name: model ? model.name : name };
      if (onItself) workspace = model.workspace;
      const mods = await modules();
      // `definition`: on a semantic model, its local copy, which the page writes its DAX from (site/model.json).
      let plan, definition = null;
      if (onItself) {
        definition = modelDoc(text, file, mods).doc;
        pbi.workspaceId = String(await fabric.workspaceId(pbi.workspace)).toLowerCase();
        const existing = await fabricModel.find(pbi.workspaceId, pbi.name);
        if (!existing) throw new Error(`${pbi.workspace} has no semantic model ${pbi.name} any more: Refresh the workspace`);
        plan = planOnModel(definition, name, { ...pbi, id: existing.id });
      } else {
        plan = planExport(text, file, name, mods, { workspace, path }, await lakesOf(text, file, workspace));
        plan.engine = 'duckdb';
      }
      // The function reads the tables client side; on a semantic model the page calls none, and none is deployed.
      const fnDir = join(extensionDir, 'fabric-function');
      const fn = onItself ? null : await Promise.all([
        fsp.readFile(join(fnDir, 'source.zip')), fsp.readFile(join(fnDir, 'deploymetadata.json'), 'utf8'),
      ]).then(([sourceZip, deployMetaData]) => ({ sourceZip, deployMetaData }),
              () => { throw new Error('this build has no function package (fabric-function/): run node scripts/function-bundle.mjs'); });
      const token = await appToken({ createIfNone: true });
      if (!token) throw new Error('not signed in to the Fabric API');

      // The local copy, <app>.zip: the one approved last time for this model, or else in the
      // folder VS Code has open, or else in a folder picked. Never used unapproved: where it goes
      // is shown, and the export waits for an OK or another folder.
      const open = ui.openFolder();
      const appKey = `${plan.workspace}/${plan.lakehouse ?? 'semanticmodel'}/${plan.name}`;
      const remembered = memento.get(`exportZip:${appKey}`);
      const zipName = `${plan.name}.zip`;
      let outZip = remembered && existsSync(dirname(remembered)) ? remembered : open ? join(open, zipName) : null;
      // An earlier export's folder, <app>/ with its marker: no longer written, but what it published
      // is the app's, and a zip not written yet starts from it.
      const oldDir = [memento.get(`exportFolder:${appKey}`), open && join(open, plan.name)]
        .find(d => d && existsSync(join(d, OLD_MARKER)));
      let prev = outZip;
      const pickFolder = async () => {
        const dir = await ui.pickFolder({
          startAt: prev ? dirname(prev) : os.homedir(),
          openLabel: 'Export Here',
          title: `Export to Fabric: the folder to keep the app's local copy (${zipName}) in`,
        });
        return dir ? join(dir, zipName) : null;
      };
      for (;;) {
        if (!outZip) {
          outZip = await pickFolder();
          if (!outZip) throw declined('Export cancelled.');
        }
        const pick = await ui.info(
          `Export ${plan.name} to Fabric?`,
          { modal: true, detail: `Local copy: ${outZip}${existsSync(outZip) ? '' : ' (new)'}\nWorkspace: ${workspace}\n` +
            (onItself ? `Semantic model: ${pbi.name}, as it is (not changed)` : `Model: ${plan.modelPath}\nRuns on: DuckDB in the browser`) +
            (oldDir ? `\n\nThe app is one file now: the folder ${oldDir} is no longer used, and can be deleted.` : '') },
          'Export', 'Choose Another Folder…');
        if (pick === 'Export') break;
        if (!pick) throw declined('Export cancelled.');
        prev = outZip;
        outZip = null;
      }
      // A file Export to Fabric did not write is refused here, before anything else is asked.
      const local = await readApp(outZip);
      const before = local ? local.marker : oldDir ? await oldMarker(oldDir) : null;
      await memento.update(`exportZip:${appKey}`, outZip);
      // Studio's Report tab for this model draws this zip's report (reportOf).
      await memento.update(reportKey(pbi.workspace, name), outZip);
      // One client for the export. Its lines go to the log, and while publishing also to the
      // progress notification (`say`, below).
      let appLog = m => log(m);
      const fabricApp = createFabricApp({ getToken: appToken, log: m => appLog(m) });

      // Two models' names can make one app's: this zip's app is another model's.
      if (before && before.model && before.model !== plan.modelPath) {
        const pick = await ui.warn(
          `${plan.name} is the app of another model. Replace it with this one?`,
          { modal: true, detail: `Now: ${before.model}\nThis export: ${plan.modelPath}` }, 'Replace It');
        if (pick !== 'Replace It') throw declined(`Not exported: ${plan.name} is another model's app.`);
      }

      // Edited since it was last published (by you, or an agent)? Asked, never overwritten. As Is
      // publishes the zip's site, which runs on what it was made for, DuckDB in the browser or a
      // semantic model: not offered for an export to the other. Its report is never at stake.
      let asIs = false;
      const changed = local ? localChanges(local.files, before) : [];
      if (changed.length) {
        const shown = changed.slice(0, 5).join('\n') + (changed.length > 5 ? `\n…and ${changed.length - 5} more` : '');
        const made = engineOf(local.files, before);
        const sameSite = (made === 'duckdb') === (plan.engine === 'duckdb');
        const asIsSays = sameSite ? "Publish As Is: publish the zip's site with your changes, and leave it alone."
          : `Publish As Is is not offered: the zip was made for ${RUNS_ON[made] || made}, and this export is ${RUNS_ON[plan.engine]}, so only Overwrite changes what the app runs on.`;
        const pick = await ui.warn(
          `The local copy of ${plan.name} has changed since it was last published.`,
          { modal: true, detail: `${outZip}\n\n${shown}\n\nOverwrite: rewrite it from this Explore, its report kept, and publish that. ${asIsSays} The function always comes from this version of the extension.` },
          'Overwrite Local Changes', ...(sameSite ? ['Publish As Is'] : []));
        if (!pick) throw declined('Not exported: the local copy has changes.');
        asIs = sameSite && pick === 'Publish As Is';
      }

      // Deployed again since this zip published it (another machine, rayfin up)?
      // Asked before it is replaced.
      if (before && before.itemId) {
        const live = await fabricApp.deployStatus(plan.workspace, before.itemId)
          .catch(e => { log(`export: the app's last deploy could not be read — ${e.message}`); return null; });
        const ours = before.deployedAt ? Date.parse(before.deployedAt)
          // A marker from before deployedAt was kept: this machine's clock, with slack.
          : before.exportedAt ? Date.parse(before.exportedAt) + 5 * 60_000 : NaN;
        const theirs = live && Date.parse(live.lastSuccessfulDeploymentAt);
        // A marker saying neither is a publish that never finished: any deploy is someone else's.
        if (theirs && !(theirs <= ours)) {
          const pick = await ui.warn(
            `${plan.name} was deployed again on ${new Date(theirs).toLocaleString()}, not from this local copy. Overwrite it?`,
            { modal: true, detail: live.hostingUrl || '' }, 'Overwrite It');
          if (pick !== 'Overwrite It') throw declined(`Not exported: ${plan.name} was deployed from elsewhere since.`);
        }
      }

      // An app of that name that no export created may be someone's own: never replaced unasked.
      let takeOver = false;
      const taken = await fabricApp.takenName(plan.workspace, plan.name, before && before.itemId);
      if (taken) {
        const pick = await ui.warn(
          `An app named "${taken.displayName}" already exists in this workspace, and Export to Fabric did not create it. Replace it with this Explore?`,
          { modal: true }, 'Replace It');
        if (pick !== 'Replace It') throw declined(`Not exported: an app named ${taken.displayName} already exists.`);
        takeOver = true;
      }

      // Every question is answered: from here on it writes.
      const ext = extensionDir;
      const fabricAppDir = join(ext, 'fabric_app');
      const appDir = await pageDir();
      // One publish, under a progress notification.
      const r = await ui.withProgress(`Export to Fabric: ${plan.name}`,
        async progress => {
          const say = line => { log(line); progress.report({ message: line.replace(/^app \S+: /, '') }); };
          let files, marker = before || {}, fromStudio = null;
          if (asIs) {
            say(`app ${plan.name}: publishing ${outZip} as it is`);
            files = local.files;
            // On a semantic model, the page's copy of it is the local copy as it is now.
            if (definition) setModel(files, definition);
          } else {
            say(`app ${plan.name}: writing the local copy to ${outZip}`);
            // The zip's Report, else the one Studio kept for this model before it had a zip.
            const studioReport = local && local.files.get(REPORT) ? null : reportDir && join(reportDir, reportName(pbi.workspace, name));
            const kept = (local && local.files.get(REPORT)) || (studioReport && await fsp.readFile(studioReport).catch(() => null)) || null;
            files = await appFiles({ plan, state, model: definition, kept,
                                     redirects: marker.redirects || [], fabricAppDir, appDir,
                                     daxSqlDir: join(ext, 'vendor', 'npm', PINS.daxSql) });
            fromStudio = kept && studioReport ? studioReport : null;
            marker = { ...marker, name: plan.name, model: plan.modelPath, workspaceId: plan.workspace,
                       lakehouseId: plan.lakehouse, engine: plan.engine || 'duckdb' };
          }
          // Kept before anything is published: a failure from here leaves the zip as it is.
          await writeApp(outZip, files, marker);
          // The zip holds the Report now, and is where it is kept from here on.
          if (fromStudio) await fsp.rm(fromStudio, { force: true }).catch(() => {});
          // The page's packages, the extension's own: what they weigh, here in the log.
          const vendor = await vendorFiles(join(ext, 'vendor', 'webapp'), plan.engine);
          const mb = n => `${(n / 1048576).toFixed(1)} MB`;
          const size = vendorSize(vendor);
          say(`app ${plan.name}: the packages are ${mb(size.total)}`);
          for (const [name, bytes] of size.parts) log(`  ${mb(bytes).padStart(9)}  ${name}`);
          const quiet = appLog;
          appLog = say;
          let done;
          try {
            done = await fabricApp.publish({
              workspaceId: plan.workspace, name: plan.name, tenantId: tenantOf(token),
              catalogUrl: plan.catalogUrl, modelUrl: plan.modelUrl, semanticModel: plan.semanticModel || null,
              site: async config => await zip(buildDist(files, config, vendor)),
              fn, redirects: marker.redirects || [],
              itemId: marker.itemId || null, takeOver,
              // Kept as soon as there is one: if a later step fails, the next export must know this
              // item is its own rather than ask about an app it made.
              onItem: id => writeApp(outZip, files, { ...marker, itemId: id }),
            });
          } finally { appLog = quiet; }
          // The redirects in rayfin.yml: the template's, or (as is) the zip's own.
          const tpl = asIs && files.has('rayfin/rayfin.yml') ? files.get('rayfin/rayfin.yml').toString('utf8')
            : await fsp.readFile(join(fabricAppDir, 'rayfin', 'rayfin.yml'), 'utf8');
          files.set('rayfin/rayfin.yml', Buffer.from(rayfinYml(tpl, plan.name, done.redirects, plan.semanticModel), 'utf8'));
          // What was published, to compare the next export with: the zip's entries, and the
          // deploy's time by Fabric's clock.
          const live = await fabricApp.deployStatus(plan.workspace, done.itemId).catch(() => null);
          await writeApp(outZip, files, { ...marker, engine: plan.engine, itemId: done.itemId, hostingUrl: done.hostingUrl,
                                          redirects: done.redirects, exportedAt: new Date().toISOString(),
                                          deployedAt: (live && live.lastSuccessfulDeploymentAt) || new Date().toISOString(),
                                          files: fingerprint(files) });
          return done;
        });
      // The Apps of the workspace the app was published to (the lakehouse's, not always the
      // model's), re-read: the app is new, or deployed again.
      onRefresh({ kind: 'apps', workspace: plan.workspace });
      log(`exported ${plan.name} -> ${r.hostingUrl || '(no hosting URL)'} (item ${r.itemId}, model ${plan.modelPath}, local copy ${outZip})`);
      for (const w of plan.warnings) log(`  warning: ${w}`);
      const warned = plan.warnings.length ? ` ${plan.warnings.length} warning(s) in the log.` : '';
      const on = onItself ? `, on the semantic model ${pbi.name}` : '';
      ui.info(`${plan.name} is published to Fabric${on}.${warned}`, 'Open App', 'Reveal Folder')
        .then(pick => {
          if (pick === 'Open App' && r.hostingUrl) ui.openExternal(r.hostingUrl);
          else if (pick === 'Reveal Folder') ui.reveal(outZip);
        });
      return `Published to Fabric${asIs ? ' (the local copy, as it is)' : ''}${on}: ${r.hostingUrl || plan.name}`;
    } catch (e) {
      if (!(e && e.declined)) log(`export to fabric of ${file} failed — ${(e && e.stack) || e}`);
      throw e;
    }
  };

  // The Report a model's Report tab draws (app/explore/report.js), and Add to report and a tile's
  // ✕ save (reportSave): the site/report.json of the zip its last export was approved into; before
  // there is one, the file Studio keeps for the model (reportDir); else no tiles. { spec, stamp,
  // from }: `stamp` changes when the tiles do (reportStamp),
  // `from` is the zip or the file, or null.
  // Where the model's Report is kept, and what the disk says of it: { zipPath, st } once it has a
  // zip, else { file, st } (st null: nothing written yet).
  async function reportHome({ workspace, model }) {
    const zipPath = memento.get(reportKey(workspace, model));
    const st = zipPath ? await fsp.stat(zipPath).catch(() => null) : null;
    if (st) return { zipPath, st };
    const file = reportDir ? join(reportDir, reportName(workspace, model)) : null;
    return { file, st: file ? await fsp.stat(file).catch(() => null) : null };
  }
  async function reportOf({ workspace, model }) {
    const home = await reportHome({ workspace, model });
    const from = home.zipPath || home.file;
    const bytes = !home.st ? null : home.zipPath ? (await readApp(home.zipPath).catch(() => null))?.files.get(REPORT)
      : await fsp.readFile(home.file).catch(() => null);
    if (bytes) {
      let spec;
      try { spec = JSON.parse(bytes.toString('utf8')); }
      catch (e) { throw new Error(`${from}${home.zipPath ? ': site/report.json' : ''} is not JSON: ${e.message}`); }
      return { spec, stamp: home.st.mtimeMs, from };
    }
    return { spec: { tiles: [] }, stamp: home.st ? home.st.mtimeMs : 0, from: null };
  }
  async function reportStamp(m) {
    const { st } = await reportHome(m);
    return st ? st.mtimeMs : 0;
  }
  // The tiles written where the Report is kept (reportHome): into the zip, whose report.json no
  // export writes over and no fingerprint counts, or Studio's file. Refused when they changed
  // since `stamp`, the one they were drawn from: a person's or an agent's edit is never lost.
  // Answers { stamp }.
  async function reportSave({ workspace, model, spec, stamp }) {
    if (!spec || typeof spec !== 'object' || !Array.isArray(spec.tiles)) throw new Error('a report is { "tiles": [...] }');
    const home = await reportHome({ workspace, model });
    if (stamp != null && stamp !== (home.st ? home.st.mtimeMs : 0)) {
      throw new Error('the report changed since it was drawn: it is drawn again as it is now, so try once more');
    }
    const bytes = Buffer.from(JSON.stringify(spec, null, 2) + '\n', 'utf8');
    if (home.zipPath) {
      const app = await readApp(home.zipPath);
      if (!app) throw new Error(`${home.zipPath} is gone`);
      app.files.set(REPORT, bytes);
      await writeApp(home.zipPath, app.files, app.marker);
    } else {
      if (!home.file) throw new Error('the Report is not kept here');
      await fsp.mkdir(dirname(home.file), { recursive: true });
      const tmp = `${home.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, bytes);
      await fsp.rename(tmp, home.file);
    }
    return { stamp: await reportStamp({ workspace, model }) };
  }

  // Create Semantic Model, from the tree (a .bim or Ossie .yaml in a lakehouse's Files/) or the
  // command line's `semanticmodel`: a Power BI semantic model of the file, and nothing else (no app,
  // no zip, no Report). Named for the file (`name`, else its name), in the file's workspace, on
  // Direct Lake (refreshed once made) or DirectQuery (its SQL endpoint signed in to by SSO). With no
  // `mode` (the tree) one dialog asks which, and says whether one of that name is replaced; with one
  // (the command line) a model of that name is replaced only on the user's OK. Answers what to say
  // when it is done; a No is thrown as `declined`.
  async function createSemanticModel({ file, name, text, workspace, path, mode }) {
    const declined = message => Object.assign(new Error(message), { declined: true });
    try {
      if (connectivity.offline()) {
        throw new Error(`Create Semantic Model needs a connection, and ${connectivity.noInternet() ? 'there is no internet' : 'you are not signed in'}.`);
      }
      let engine = mode == null ? null : MODE_OF[String(mode).toLowerCase()];
      if (mode != null && !engine) throw new Error(`no mode ${mode}: directlake or directquery`);
      if (!workspace || !path) throw new Error('Create Semantic Model needs a model file in a lakehouse\'s Files/');
      const mods = await modules();
      const modelName = name || mods.semantic.modelName(file);
      const plan = planExport(text, file, modelName, mods, { workspace, path }, await lakesOf(text, file, workspace));
      const workspaceId = String(await fabric.workspaceId(workspace)).toLowerCase();
      const existing = await fabricModel.find(workspaceId, modelName);
      const where = `Workspace: ${workspace}\nFrom: ${path}`;
      const replaced = `${workspace} already has a semantic model of this name: its definition is replaced.`;
      if (!engine) {
        const pick = await (existing ? ui.warn : ui.info)(`${existing ? 'Update' : 'Create'} the semantic model ${modelName}?`,
          { modal: true, detail: `${where}\n\n${existing ? `${replaced}\n` : ''}` +
            `Direct Lake reads the lakehouse's tables from OneLake.\nDirectQuery queries the lakehouse's SQL endpoint.` },
          MODES.directLake, MODES.directQuery);
        engine = Object.keys(MODES).find(k => MODES[k] === pick);
        if (!engine) throw declined(`Not ${existing ? 'updated' : 'created'}: ${modelName}.`);
      } else if (existing) {
        const pick = await ui.warn(`Update the semantic model ${modelName}?`,
          { modal: true, detail: `${where}\n\n${replaced}\n${MODES[engine]}` }, 'Update');
        if (pick !== 'Update') throw declined(`Not created: ${modelName} already exists in ${workspace}.`);
      }
      plan.engine = engine;
      if (engine === 'directQuery') plan.sqlEndpoint = await sqlEndpointOf(plan);
      const tmsl = semanticTmsl(mods.semantic.bimOf(file, text, mods.compiler), engine, {
        name: modelName, tables: plan.tables, lake: { workspace: plan.workspace, item: plan.lakehouse }, sqlEndpoint: plan.sqlEndpoint });
      await ui.withProgress(`Create Semantic Model: ${modelName}`, async progress => {
        const say = line => { log(`semantic model ${workspace}/${modelName}: ${line}`); progress.report({ message: line }); };
        say(`${existing ? 'updating' : 'creating'} it (${MODES[engine]})`);
        const { id } = await fabricModel.write(workspaceId, modelName, definitionOf(tmsl), existing && existing.id);
        if (engine === 'directLake') {
          say('refreshing it');
          await fabricModel.frame(workspaceId, id);
        } else {
          say('setting its SQL endpoint sign-in (SSO)');
          await fabricModel.bindSso(workspaceId, id);
        }
      });
      // The workspace's semantic models, listed again: it is there now.
      onRefresh({ kind: 'models', workspace });
      return `Semantic model ${modelName} ${existing ? 'updated' : 'created'} in ${workspace} (${MODES[engine]}).`;
    } catch (e) {
      if (!(e && e.declined)) log(`create semantic model from ${path || file} failed — ${(e && e.stack) || e}`);
      throw e;
    }
  }

  return { exportExplore, reportOf, reportStamp, reportSave, createSemanticModel };
}

module.exports = { createExport };
