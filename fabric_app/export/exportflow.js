'use strict';
// =============================================================================
// exportflow.js — Export to Fabric, from the first question to the published app
// =============================================================================
// Every question goes through `ui`, so whoever is showing this decides how it is asked.
// =============================================================================

const { join, dirname, basename } = require('node:path');
const os = require('node:os');
const { existsSync } = require('node:fs');
const fsp = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { PINS } = require('../../core/vendored');
const { planExport, modelDoc, appFiles, setModel, setModelCopy, modelCopyOf, tablesOf, readApp, writeApp, staticFiles, siteBuild, sizeOf,
        buildDist, fingerprint, zip, rayfinYml, REPORT, APP_EXT, LEGACY_EXT, SITE, DEPLOYMENTS, CONFIG, setStatic, setPage, pageChanges, oldLayout,
        setSecrets, setDeployment } = require('./exportapp');
const { createFabricApp, tenantOf } = require('./fabricapp');
const { createFabricModel } = require('./fabricmodel');
const { semanticTmsl, definitionOf } = require('./pbimodel');

// An earlier export's local copy was a folder, <app>/, with this marker in it.
const OLD_MARKER = '.onelake-studio-export.json';
const oldMarker = dir => fsp.readFile(join(dir, OLD_MARKER), 'utf8')
  .then(t => { const m = JSON.parse(t); delete m.files; return m; }, () => null).catch(() => null);
// The local copy's name before its extension: the model file's own name with no model extension
// (sales.ossie.yaml is sales), less what Windows refuses in a file name.
// The app's name in Fabric is plan.name, and stays so.
const localName = s => String(s || '').split(/[\\/]/).pop()
  .replace(/(\.ossie)?\.(ya?ml|bim)$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim() || 'model';
// The apps this computer published, each with the file it was published from (memento, item id -> path): an
// app's file names the item it is published over, so a file from elsewhere could otherwise name any app its
// reader may write, and replace it unasked.
const PUBLISHED = 'exportedItems';
const samePath = (a, b) => String(a || '').replace(/\\/g, '/').toLowerCase() === String(b || '').replace(/\\/g, '/').toLowerCase();
// One write of a zip at a time, by its path: a tile saved while an export writes its record would otherwise
// be read before that write and written after it, and one of the two would be gone.
const turns = new Map();
function inTurn(path, run) {
  const key = String(path).replace(/\\/g, '/').toLowerCase();
  const next = (turns.get(key) || Promise.resolve()).then(run, run);
  const settled = next.catch(() => {});
  turns.set(key, settled);
  settled.then(() => { if (turns.get(key) === settled) turns.delete(key); });
  return next;
}
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
 * @param {Function} [o.powerBiToken]  the Power BI API's (signin.js fabricToken): a semantic model's refresh
 * @param {object} o.fabric  fabric.js
 * @param {{ get: Function, update: Function }} o.memento  where each app's zip was approved last time
 * @param {string} o.extensionDir  where this install's files are
 * @param {string} [o.reportDir]  where a model's Report is kept until its first export (Add to report)
 * @param {() => Promise<string>} o.pageDir  where the page's files are
 * @param {object} o.ui  info, warn, saveFile, openFolder, withProgress, openExternal, reveal
 * @param {(node: object) => void} o.onRefresh  this part of the tree changed
 * @param {(line: string) => void} o.log
 */
function createExport({ connectivity, modules, appToken, powerBiToken = appToken, fabric,
                        memento, extensionDir, reportDir = null, pageDir, ui, onRefresh, log, maxRows = () => null,
                        fabricModel = createFabricModel({ getToken: appToken, powerBiToken, log: m => log(m) }),
                        fabricAppOf = createFabricApp }) {

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
  // its local copy one file, <model>.fabricator (a Rayfin project, zipped), saved where the Save dialog says —
  // and published from it over the Fabric REST API (fabricapp.js). The function's deploy
  // package ships in the vsix (fabric-function/, scripts/function-bundle.mjs). Answers what
  // Explore's info line says; a failure is thrown back to it, and logged. So is the user's No
  // (`declined`), which is no failure, but must not read as a publish on the command line.
  // The app runs on a model file: one in OneLake (`workspace`, `path`), or one from disk (`onDisk`). DuckDB
  // in the browser reads its lakehouse's tables.
  // `appFile`: an app's .fabricator (or an earlier .fabricapp) opened from disk (openApp), its own model.yaml the
  // `text`: the file is published as it is, with no Save dialog and no question about its changes.
  // `onDisk`: a model file from disk (extension.js openPath), in the workspace its tables are in, read
  // like a OneLake file: the app runs on its copy of the model, so no OneLake path is needed.
  const exportExplore = async ({ file, name, text, state, workspace, path, appFile = null, onDisk = false }) => {
    const declined = message => Object.assign(new Error(message), { declined: true });
    try {
      // The one thing that can't work from what is held, said before anything is asked.
      if (connectivity.offline()) {
        throw new Error(`Export to Fabric needs a connection, and ${connectivity.noInternet() ? 'there is no internet' : 'you are not signed in'}.`);
      }
      if (!path && !(onDisk && workspace)) {
        throw new Error('Export to Fabric needs a model file: one in OneLake, or one from disk in a workspace');
      }
      const mods = await modules();
      // `definition`: the model the page runs on (site/public/model.json), the model file as it is now.
      const definition = modelDoc(text, file, mods).doc;
      const plan = planExport(text, file, name, mods, onDisk ? { workspace, onDisk: true, path } : { workspace, path }, await lakesOf(text, file, workspace));
      // The function reads the tables' metadata and signs their SAS.
      const fnDir = join(extensionDir, 'fabric-function');
      const fn = await Promise.all([
        fsp.readFile(join(fnDir, 'source.zip')), fsp.readFile(join(fnDir, 'deploymetadata.json'), 'utf8'),
      ]).then(([sourceZip, deployMetaData]) => ({ sourceZip, deployMetaData }),
              () => { throw new Error('this build has no function package (fabric-function/): run node scripts/function-bundle.mjs'); });
      const token = await appToken({ createIfNone: true });
      if (!token) throw new Error('not signed in to the Fabric API');

      // The local copy, <model>.fabricator, where the person saves it: the Save dialog is the export's one
      // question, opened where this app was saved last, else in Documents. Saving over the file is
      // the dialog's own question; Cancel is a refusal, with nothing written. One an earlier export
      // saved as <app>.zip or <model>.fabricapp is offered under its new name, and renamed when saved there.
      const appKey = `${plan.workspace}/${plan.lakehouse}/${plan.name}`;
      const asApp = p => String(p).replace(/\.(zip|fabricapp)$/i, APP_EXT);
      const remembered = memento.get(`exportZip:${appKey}`);
      const zipName = `${localName(file)}${APP_EXT}`;
      const oldZip = remembered && /\.(zip|fabricapp)$/i.test(remembered) && existsSync(remembered) ? remembered : null;
      const documents = join(os.homedir(), 'Documents');
      // An earlier .fabricapp opened from disk is published as it is, from its .fabricator.
      const legacyFile = appFile && appFile.toLowerCase().endsWith(LEGACY_EXT) ? appFile : null;
      const outZip = (appFile && asApp(appFile)) || await ui.saveFile({
        defaultPath: oldZip ? asApp(oldZip) : remembered && existsSync(dirname(remembered)) ? asApp(remembered)
          : join(existsSync(documents) ? documents : os.homedir(), zipName),
        title: `Export ${zipName} to Fabric`, saveLabel: 'Export', filters: { 'Fabricator project': [APP_EXT.slice(1)] },
      });
      if (!outZip) throw declined('Export cancelled.');
      const earlier = legacyFile || oldZip;
      // An earlier export's folder, <app>/ with its marker: no longer written, but what it published
      // is the app's, and a zip not written yet starts from it.
      const open = ui.openFolder();
      const oldDir = [memento.get(`exportFolder:${appKey}`), open && join(open, plan.name)]
        .find(d => d && existsSync(join(d, OLD_MARKER)));
      // The earlier export's .zip or .fabricapp becomes the .fabricator, if it is one Export to Fabric wrote
      // (its marker): the next write lays it out as a .fabricator is.
      if (earlier && samePath(asApp(earlier), outZip) && !existsSync(outZip) && await readApp(earlier).catch(() => null)) {
        await fsp.rename(earlier, outZip);
        log(`export: ${earlier} is ${outZip} now`);
      }
      // A file Export to Fabric did not write is refused here, before anything else is asked.
      const local = await readApp(outZip);
      const before = local ? local.marker : oldDir ? await oldMarker(oldDir) : null;
      await memento.update(`exportZip:${appKey}`, outZip);
      // Where the Report tab drew this model's Report from until now: an earlier zip (this export saved to another
      // file), or Studio's own file before the model had one. A zip with no Report of its own starts from it:
      // pointed at a new file, the Report tab would otherwise draw an empty one.
      const reportWas = await reportHome({ workspace: workspace, model: name });
      // Studio's Report tab for this model draws this zip's report (reportOf).
      await memento.update(reportKey(workspace, name), outZip);
      // One client for the export. Its lines go to the log, and while publishing also to the
      // progress notification (`say`, below).
      let appLog = m => log(m);
      const fabricApp = fabricAppOf({ getToken: appToken, log: m => appLog(m) });

      // Two models' names can make one app's: this zip's app is another model's.
      if (before && before.model && before.model !== plan.modelPath) {
        const pick = await ui.warn(
          `${plan.name} is the app of another model. Replace it with this one?`,
          { modal: true, detail: `Now: ${before.model}\nThis export: ${plan.modelPath}` }, 'Replace It');
        if (pick !== 'Replace It') throw declined(`Not exported: ${plan.name} is another model's app.`);
      }

      // Saved over, the file is rewritten from this Explore, its report kept: saving is what changes it.
      // An app's file opened from disk (appFile) is published as it is, its own edits included.
      const asIs = !!appFile;

      // The file says which app it is published over, and which sign-in redirects that app keeps. Both are
      // taken at its word only for an app this computer published: a file from someone else is asked about,
      // since it would replace an app of yours with its own pages. Asked once: published, it is this
      // computer's.
      // By the file too, not the item alone: a file someone sends can name an app this computer did publish.
      // And a file that names no app yet can still carry redirects, which the app it makes would keep.
      const published = () => {
        const kept = memento.get(PUBLISHED);
        // (An earlier build of this kept the ids alone.)
        return Array.isArray(kept) ? Object.fromEntries(kept.map(id => [String(id), null])) : { ...(kept || {}) };
      };
      const redirects = (before && Array.isArray(before.redirects) ? before.redirects : []).map(String);
      const id = before && before.itemId ? String(before.itemId) : null;
      // Where this computer published that app from, when it did (null: by a build that kept no path).
      const from = id && Object.hasOwn(published(), id) ? published()[id] : undefined;
      // (A .fabricapp it was published from is this .fabricator now.)
      const ours = id ? from !== undefined && (from === null || samePath(asApp(from), outZip)) : !redirects.length;
      if (before && !ours) {
        const over = before.itemId ? ` Publish it over the app it names (${before.name || plan.name})?` : ' Publish it?';
        const pick = await ui.warn(
          `OneLake Studio has not published ${basename(outZip)} from this computer before.${over}`,
          { modal: true, detail: (before.itemId ? `The app in ${workspace} is replaced by ${asIs ? 'the pages in this file' : 'this Explore'}.` : `A new app is made in ${workspace}.`) +
              (redirects.length ? `\nSign-in redirects in the file: ${redirects.join(', ')}` : '') }, 'Publish It');
        if (pick !== 'Publish It') throw declined(`Not exported: ${basename(outZip)} was not published from this computer before.`);
      }
      const publishedHere = id => memento.update(PUBLISHED, { ...published(), [String(id)]: outZip });

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

      const ext = extensionDir;
      const fabricAppDir = join(ext, 'fabric_app');
      const appDir = await pageDir();
      // The project this build writes for the app, its Report `kept`.
      const projectOf = (kept, redirects) => appFiles({
        plan, state, model: definition, modelText: text, modelFile: file, kept, redirects, fabricAppDir, appDir, maxRows: maxRows(),
        daxSqlDir: join(ext, 'vendor', 'npm', PINS.daxSql), agentFiles: join(ext, 'fabric-function', 'agent-files.json') });
      // A file published as it is takes this build's page, where its own is the one an export wrote (an earlier
      // build's, or an earlier layout's). A page someone changed is not OneLake Studio's to publish: it runs no
      // npm, and uploads its own build of the page with the file's Report and model. Asked, and the file's page
      // is then kept as it is, for a publish that builds it; an earlier layout's cannot be built, and is replaced.
      // A file whose page was kept so says it (its record's page: 'own'): from then on its page is compared with
      // this build's, not with what the record kept, and asked about at each publish.
      let pageOf = null, keepPage = false;
      if (asIs) {
        pageOf = await projectOf(local.files.get(REPORT) || null, (before && before.redirects) || []);
        const changed = pageChanges(local.files, before && before.page === 'own' ? { files: {} } : before, pageOf);
        if (changed.length) {
          const pick = await ui.warn(
            `The page in ${basename(outZip)} was changed, and OneLake Studio publishes its own page with this file's Report and model. Publish it so?`,
            { modal: true, detail: `Changed: ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? `, and ${changed.length - 8} more` : ''}\n` +
                'Fabricator, or npm run rayfin:up in the project, publishes a changed page.' }, 'Publish It');
          if (pick !== 'Publish It') throw declined(`Not exported: the page in ${basename(outZip)} was changed.`);
          keepPage = !oldLayout(local.files);
        }
      }
      // Every question is answered: from here on it writes.
      // One publish, under a progress notification.
      const r = await ui.withProgress(`Export to Fabric: ${plan.name}`,
        async progress => {
          const say = line => { log(line); progress.report({ message: line.replace(/^app \S+: /, '') }); };
          let files, marker = before || {}, fromStudio = null;
          if (asIs) {
            say(`app ${plan.name}: publishing ${outZip} as it is`);
            files = local.files;
            if (!keepPage) setPage(files, pageOf);
            marker = { ...marker, page: keepPage ? 'own' : undefined };
            // The app runs on its own model.yaml, an edit to it included; a zip from before it had one gets one.
            if (!modelCopyOf(files)) setModelCopy(files, file, text);
            const copy = modelCopyOf(files);
            setModel(files, modelDoc(copy.text, copy.name, mods).doc);
            // A file from before export.json named its report keeps the names the Report tab knows it by.
            if (!marker.report) marker = { ...marker, report: { workspace: workspace, model: name } };
          } else {
            say(`app ${plan.name}: writing the local copy to ${outZip}`);
            // The zip's Report, else the one the Report tab drew before this export (reportWas): an earlier zip's,
            // or the one Studio kept for this model before it had a zip.
            const was = local && local.files.get(REPORT) ? null : reportWas;
            const wasReport = !was || !was.st ? null
              : was.zipPath ? ((await readApp(was.zipPath).catch(() => null))?.files.get(REPORT) || null)
              : await fsp.readFile(was.file).catch(() => null);
            const studioReport = was && was.file && wasReport ? was.file : null;
            const kept = (local && local.files.get(REPORT)) || wasReport || null;
            files = await projectOf(kept, marker.redirects || []);
            fromStudio = kept && studioReport ? studioReport : null;
            // The app `rayfin up` would update, kept while this publishes: a publish that fails leaves the file naming it.
            for (const p of [DEPLOYMENTS, CONFIG]) if (local && local.files.has(p)) files.set(p, local.files.get(p));
            // `report`: the names Studio's Report tab knows the model by (reportKey), for opening the file.
            marker = { ...marker, name: plan.name, model: plan.modelPath, workspaceId: plan.workspace,
                       lakehouseId: plan.lakehouse, page: undefined,
                       report: { workspace, model: name } };
          }
          // The Report as the file holds it now: a tile added while this publishes (reportSave) is in the
          // file, not in `files`, and a write from `files` alone would take it out again.
          const reportNow = async () => {
            const now = await readApp(outZip).catch(() => null);
            const report = now && now.files.get(REPORT);
            if (report) files.set(REPORT, report);
          };
          // The site's files npm has not, the extension's own, in the file (so it builds where it is unpacked);
          // and the page as Vite built it when the extension was packaged, which is what is uploaded: what it
          // weighs, here in the log.
          setStatic(files, await staticFiles(join(ext, 'vendor', 'webapp')));
          const page = await siteBuild(join(ext, 'fabric-site'));
          const mb = n => `${(n / 1048576).toFixed(1)} MB`;
          const size = sizeOf(page);
          say(`app ${plan.name}: the page is ${mb(size.total)}`);
          for (const [name, bytes] of size.parts) log(`  ${mb(bytes).padStart(9)}  ${name}`);
          // The tables the function may sign: the ones the model the app runs on names.
          const tables = tablesOf(JSON.parse(files.get(`${SITE}model.json`).toString('utf8'))).join(',');
          setSecrets(files, { catalogUrl: plan.catalogUrl, tables });
          // Kept before anything is published: a failure from here leaves the zip as it is.
          await writeApp(outZip, files, marker);
          // The zip holds the Report now, and is where it is kept from here on.
          if (fromStudio) await fsp.rm(fromStudio, { force: true }).catch(() => {});
          const quiet = appLog;
          appLog = say;
          let done;
          try {
            done = await fabricApp.publish({
              workspaceId: plan.workspace, name: plan.name, tenantId: tenantOf(token),
              catalogUrl: plan.catalogUrl, tables,
              site: async config => await zip(buildDist(files, config, page)),
              fn, redirects: marker.redirects || [],
              itemId: marker.itemId || null, takeOver,
              // Kept as soon as there is one: if a later step fails, the next export must know this
              // item is its own rather than ask about an app it made.
              onItem: async id => {
                await publishedHere(id);
                await inTurn(outZip, async () => { await reportNow(); await writeApp(outZip, files, { ...marker, itemId: id }); });
              },
            });
          } finally { appLog = quiet; }
          // The redirects in rayfin.yml: the template's, or (as is) the zip's own.
          const tpl = asIs && files.has('rayfin/rayfin.yml') ? files.get('rayfin/rayfin.yml').toString('utf8')
            : await fsp.readFile(join(fabricAppDir, 'rayfin', 'rayfin.yml'), 'utf8');
          files.set('rayfin/rayfin.yml', Buffer.from(rayfinYml(tpl, plan.name, done.redirects), 'utf8'));
          // What was published, to compare the next export with: the zip's entries, and the
          // deploy's time by Fabric's clock.
          const live = await fabricApp.deployStatus(plan.workspace, done.itemId).catch(() => null);
          const deployedAt = (live && live.lastSuccessfulDeploymentAt) || new Date().toISOString();
          await publishedHere(done.itemId);
          // The app as `rayfin up` records one, and its site's backend: Fabricator's publish updates this app.
          setDeployment(files, { config: done.config, name: plan.name, workspace: workspace, hostingUrl: done.hostingUrl, deployedAt });
          await inTurn(outZip, async () => { await reportNow(); await writeApp(outZip, files, { ...marker, itemId: done.itemId, hostingUrl: done.hostingUrl,
                                          redirects: done.redirects, exportedAt: new Date().toISOString(), deployedAt,
                                          files: fingerprint(files) }); });
          return done;
        });
      // The Apps of the workspace the app was published to (the lakehouse's, not always the
      // model's), re-read: the app is new, or deployed again.
      onRefresh({ kind: 'apps', workspace: plan.workspace });
      log(`exported ${plan.name} -> ${r.hostingUrl || '(no hosting URL)'} (item ${r.itemId}, model ${plan.modelPath}, local copy ${outZip})`);
      for (const w of plan.warnings) log(`  warning: ${w}`);
      const warned = plan.warnings.length ? ` ${plan.warnings.length} warning(s) in the log.` : '';
      ui.info(`${plan.name} is published to Fabric.${warned}`, 'Open App', 'Reveal Folder')
        .then(pick => {
          if (pick === 'Open App' && r.hostingUrl) ui.openExternal(r.hostingUrl);
          else if (pick === 'Reveal Folder') ui.reveal(outZip);
        });
      return `Published to Fabric${asIs ? ' (the local copy, as it is)' : ''}: ${r.hostingUrl || plan.name}`;
    } catch (e) {
      if (!(e && e.declined)) log(`export to fabric of ${file} failed — ${(e && e.stack) || e}`);
      throw e;
    }
  };

  // The Report a model's Report tab draws (page/explore/report.js), and Add to report and a tile's
  // ✕ save (reportSave): the site/public/report.json of the zip its last export was approved into; before
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
      catch (e) { throw new Error(`${from}${home.zipPath ? `: ${REPORT}` : ''} is not JSON: ${e.message}`); }
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
    if (!spec || typeof spec !== 'object' || (Array.isArray(spec.pages)
      ? !spec.pages.every(p => p && typeof p === 'object' && Array.isArray(p.tiles)) : !Array.isArray(spec.tiles))) {
      throw new Error('a report is { "pages": [{ "name": "…", "tiles": [...] }] }');
    }
    const home = await reportHome({ workspace, model });
    if (stamp != null && stamp !== (home.st ? home.st.mtimeMs : 0)) {
      throw new Error('the report changed since it was drawn: it is drawn again as it is now, so try once more');
    }
    const bytes = Buffer.from(JSON.stringify(spec, null, 2) + '\n', 'utf8');
    if (home.zipPath) {
      await inTurn(home.zipPath, async () => {
        const app = await readApp(home.zipPath);
        if (!app) throw new Error(`${home.zipPath} is gone`);
        app.files.set(REPORT, bytes);
        await writeApp(home.zipPath, app.files, app.marker);
      });
    } else {
      if (!home.file) throw new Error('the Report is not kept here');
      await fsp.mkdir(dirname(home.file), { recursive: true });
      const tmp = `${home.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, bytes);
      await fsp.rename(tmp, home.file);
    }
    return { stamp: await reportStamp({ workspace, model }) };
  }

  // A .fabricator (or an earlier .fabricapp) opened from disk (extension.js openPath): what it holds, and where its model is. Its
  // Report is this file from now on (reportKey), and its next export saves here (exportZip), so the
  // Report tab, Add to report and Export to Fabric all use it.
  // Answers { report: { workspace, model }, modelPath, copy }: `copy` its own model ({ name, text }), which
  // the app runs on.
  async function openApp(path) {
    const app = await readApp(path);
    if (!app) throw new Error(`${path} is gone`);
    const { marker, files } = app;
    const where = String(marker.model || '').split('/');
    const onFile = /\/Files\//i.test(String(marker.model || ''));
    // A file from before export.json named its report: its names, from where its model was.
    const report = marker.report || { workspace: where[0],
      model: onFile ? (await modules()).semantic.modelName(where[where.length - 1]) : where.slice(1).join('/') };
    if (!report.workspace || !report.model) throw new Error(`${path} names no model`);
    await memento.update(reportKey(report.workspace, report.model), path);
    if (marker.workspaceId && marker.name) {
      await memento.update(`exportZip:${marker.workspaceId}/${marker.lakehouseId}/${marker.name}`, path);
    }
    return { report, modelPath: String(marker.model || ''), copy: modelCopyOf(files) };
  }

  // Create Semantic Model, from the tree (a .bim or Ossie .yaml in a lakehouse's Files/) or the
  // command line's `semanticmodel`: a Power BI semantic model of the file, and nothing else (no app,
  // no zip, no Report). Named for the file (`name`, else its name), in the file's workspace, on
  // Direct Lake, and refreshed once made. A model of that name is replaced only on the user's OK.
  // Answers what to say when it is done; a No is thrown as `declined`.
  async function createSemanticModel({ file, name, text, workspace, path }) {
    const declined = message => Object.assign(new Error(message), { declined: true });
    try {
      if (connectivity.offline()) {
        throw new Error(`Create Semantic Model needs a connection, and ${connectivity.noInternet() ? 'there is no internet' : 'you are not signed in'}.`);
      }
      if (!workspace || !path) throw new Error('Create Semantic Model needs a model file in a lakehouse\'s Files/');
      const mods = await modules();
      const modelName = name || mods.semantic.modelName(file);
      const plan = planExport(text, file, modelName, mods, { workspace, path }, await lakesOf(text, file, workspace));
      const workspaceId = String(await fabric.workspaceId(workspace)).toLowerCase();
      const existing = await fabricModel.find(workspaceId, modelName);
      if (existing) {
        const pick = await ui.warn(`Update the semantic model ${modelName}?`,
          { modal: true, detail: `Workspace: ${workspace}\nFrom: ${path}\n\n${workspace} already has a semantic model of this name: its definition is replaced.` }, 'Update');
        if (pick !== 'Update') throw declined(`Not created: ${modelName} already exists in ${workspace}.`);
      }
      const tmsl = semanticTmsl(mods.semantic.bimOf(file, text, mods.compiler), {
        name: modelName, tables: plan.tables, lake: { workspace: plan.workspace, item: plan.lakehouse } });
      await ui.withProgress(`Create Semantic Model: ${modelName}`, async progress => {
        const say = line => { log(`semantic model ${workspace}/${modelName}: ${line}`); progress.report({ message: line }); };
        say(`${existing ? 'updating' : 'creating'} it`);
        const { id } = await fabricModel.write(workspaceId, modelName, definitionOf(tmsl), existing && existing.id);
        say('refreshing it');
        await fabricModel.frame(workspaceId, id);
      });
      // The workspace's semantic models, listed again: it is there now.
      onRefresh({ kind: 'models', workspace });
      const done = `Semantic model ${modelName} ${existing ? 'updated' : 'created'} in ${workspace} (Direct Lake).`;
      log(done);
      return done;
    } catch (e) {
      if (!(e && e.declined)) log(`create semantic model from ${path || file} failed — ${(e && e.stack) || e}`);
      throw e;
    }
  }

  return { exportExplore, openApp, reportOf, reportStamp, reportSave, createSemanticModel };
}

module.exports = { createExport };
