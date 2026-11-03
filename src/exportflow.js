'use strict';
// =============================================================================
// exportflow.js — Export to Fabric, from the first question to the published app
// =============================================================================
// Every question goes through `ui`, so whoever is showing this decides how it is asked.
// =============================================================================

const { join, basename, dirname } = require('node:path');
const os = require('node:os');
const { existsSync } = require('node:fs');
const fsp = require('node:fs/promises');
const { modelFileName } = require('./fabric');
const { PINS } = require('./vendored');
const { planExport, writeExport, buildDist, writeMarker, readMarker, fingerprint, localChanges, vendorSize, zip, rayfinYml } = require('./exportapp');
const { createFabricApp, tenantOf } = require('./fabricapp');
const { createOneLakeWriter } = require('./onelakewrite');

/**
 * @param {object} o
 * @param {object} o.connectivity  connectivity.js
 * @param {() => Promise<object>} o.modules  the compiler and the page's modules (agent.js)
 * @param {Function} o.hostToken  OneLake's token (signin.js)
 * @param {Function} o.appToken  the Fabric API's own audience (signin.js)
 * @param {object} o.fabric  fabric.js
 * @param {object} o.onelake  onelake.js
 * @param {object} o.catalog  catalog.js
 * @param {{ get: Function, update: Function }} o.memento  the folder approved last time
 * @param {string} o.extensionDir  where this install's files are
 * @param {() => Promise<string>} o.pageDir  where the page's files are
 * @param {object} o.ui  info, warn, pickFolder, openFolder, withProgress, openExternal, reveal
 * @param {(node: object) => void} o.onRefresh  this part of the tree changed
 * @param {(line: string) => void} o.log
 */
function createExport({ connectivity, modules, hostToken, appToken, fabric, onelake, catalog, memento, extensionDir, pageDir, ui, onRefresh, log }) {
  // The one OneLake writer (onelakewrite.js): Export to Fabric's .yaml, and nothing else.
  const writer = createOneLakeWriter({ getToken: hostToken });

  // Where Export to Fabric writes a model opened from its local copy: <lakehouse>/Files/
  // semantic_model/<model>.yaml, in the one lakehouse its Direct Lake expressions name (the app
  // reads it there at run time). Only worked out here; written once the export is approved.
  async function modelTarget(text, model) {
    if (!model || !model.workspace || !model.name) {
      throw new Error('Export to Fabric needs a model that is a OneLake file, or one opened from the tree');
    }
    const lakes = await lakesOf(text, modelFileName(model.name));
    if (lakes.length !== 1) {
      throw new Error(`${model.name} reads ${lakes.length} lakehouses: Export to Fabric needs a model over exactly one`);
    }
    const lh = await fabric.itemOf(lakes[0].workspace, lakes[0].item);
    if (!/\.Lakehouse$/i.test(lh.item)) throw new Error(`${model.name} reads ${lh.item}, which has no Files/ to keep its model in`);
    return { workspace: lh.workspace, item: lh.item, path: `${lh.item}/Files/semantic_model/${modelFileName(model.name)}` };
  }

  // The lakehouses a model reads, by GUIDs: the app's catalog is addressed by them. One its
  // tables name in full (lakehouse.<workspace>.<item>...) is looked up by name in Fabric.
  async function lakesOf(text, file) {
    const { semantic, compiler } = await modules();
    return Promise.all(semantic.lakehousesOf(semantic.bimOf(file, text, compiler)).map(async l => {
      if (l.workspace) return l;
      if (l.kind !== 'lakehouse') throw new Error(`${l.workspaceName}/${l.itemName} is a ${l.kind}: the app reads a lakehouse's tables`);
      const items = await fabric.listItems(l.workspaceName);
      const it = items.find(i => i.type === 'Lakehouse' && i.name.toLowerCase() === l.itemName.toLowerCase());
      if (!it) throw new Error(`workspace ${l.workspaceName} has no lakehouse ${l.itemName}`);
      return { workspace: String(await fabric.workspaceId(l.workspaceName)).toLowerCase(), item: String(it.id).toLowerCase() };
    }));
  }

  // Export to Fabric, from Explore: the model's Explore as a Fabric app (exportapp.js), its
  // local copy written to <the open folder>/<app>/ (asked for when no folder is open) —
  // and published from there over the Fabric REST API (fabricapp.js). The function's deploy
  // package ships in the vsix (fabric-function/, scripts/function-bundle.mjs). Answers what
  // Explore's info line says; a failure is thrown back to it, and logged. So is the user's No
  // (`declined`), which is no failure, but must not read as a publish on the command line.
  const exportExplore = async ({ file, name, text, state, workspace, path, model }) => {
    const declined = message => Object.assign(new Error(message), { declined: true });
    try {
      // The one thing that can't work from what is held, said before anything is asked.
      if (connectivity.offline()) {
        throw new Error(`Export to Fabric needs a connection, and ${connectivity.noInternet() ? 'there is no internet' : 'you are not signed in'}.`);
      }
      // A model opened from its local copy is not in OneLake yet: it is written into its
      // lakehouse (modelTarget) once every question below has been answered — the one write
      // to OneLake a semantic model ever gets.
      const target = path ? null : await modelTarget(text, model);
      if (target) ({ workspace, path } = target);
      const plan = planExport(text, file, name, await modules(), { workspace, path }, await lakesOf(text, file));
      const fnDir = join(extensionDir, 'fabric-function');
      const [sourceZip, deployMetaData] = await Promise.all([
        fsp.readFile(join(fnDir, 'source.zip')), fsp.readFile(join(fnDir, 'deploymetadata.json'), 'utf8'),
      ]).catch(() => { throw new Error('this build has no function package (fabric-function/): run node scripts/function-bundle.mjs'); });
      const token = await appToken({ createIfNone: true });
      if (!token) throw new Error('not signed in to the Fabric API');

      // The folder: the one approved last time for this model, or else <the folder VS Code
      // has open>/<app>/, or else a picker. Never used unapproved: where it goes is shown, and
      // the export waits for an OK or another folder.
      const open = ui.openFolder();
      const key = `exportFolder:${plan.workspace}/${plan.lakehouse}/${plan.name}`;
      const remembered = memento.get(key);
      let outDir = remembered && existsSync(remembered) ? remembered : open ? join(open, plan.name) : null;
      let prev = outDir;
      const pickFolder = async () => {
        const dir = await ui.pickFolder({
          startAt: prev ? dirname(prev) : os.homedir(),
          openLabel: 'Export Here',
          title: `Export to Fabric: the folder to keep the app's local copy (${plan.name}/) in`,
        });
        if (!dir) return null;
        // The app's own folder picked, rather than the one to put it in: used as it is.
        return basename(dir) === plan.name ? dir : join(dir, plan.name);
      };
      for (;;) {
        if (!outDir) {
          outDir = await pickFolder();
          if (!outDir) throw declined('Export cancelled.');
        }
        const pick = await ui.info(
          `Export ${plan.name} to Fabric?`,
          { modal: true, detail: `Local copy: ${outDir}${existsSync(outDir) ? '' : ' (new)'}\nWorkspace: ${workspace}\nModel: ${plan.modelPath}` },
          'Export', 'Choose Another Folder…');
        if (pick === 'Export') break;
        if (!pick) throw declined('Export cancelled.');
        prev = outDir;
        outDir = null;
      }
      // A folder Export to Fabric did not write is refused here, before anything else is asked.
      const before = await readMarker(outDir);
      await memento.update(key, outDir);
      // One client for the export. Its lines go to the log, and while publishing also to the
      // progress notification (`say`, below).
      let appLog = m => log(m);
      const fabricApp = createFabricApp({ getToken: appToken, log: m => appLog(m) });

      // Two models' names can make one app's: this folder's app is another model's.
      if (before && before.model && before.model !== plan.modelPath) {
        const pick = await ui.warn(
          `${plan.name} is the app of another model. Replace it with this one?`,
          { modal: true, detail: `Now: ${before.model}\nThis export: ${plan.modelPath}` }, 'Replace It');
        if (pick !== 'Replace It') throw declined(`Not exported: ${plan.name} is another model's app.`);
      }

      // Edited since it was last published (by you, or an agent)? Asked, never overwritten.
      let asIs = false;
      const changed = await localChanges(outDir, before);
      if (changed.length) {
        const shown = changed.slice(0, 5).join('\n') + (changed.length > 5 ? `\n…and ${changed.length - 5} more` : '');
        const pick = await ui.warn(
          `The local copy of ${plan.name} has changed since it was last published.`,
          { modal: true, detail: `${outDir}\n\n${shown}\n\nOverwrite: rewrite it from this Explore, and publish that. Publish As Is: publish the folder's site with your changes, and leave it alone. The function always comes from this version of the extension.` },
          'Overwrite Local Changes', 'Publish Folder As Is');
        if (!pick) throw declined('Not exported: the local copy has changes.');
        asIs = pick === 'Publish Folder As Is';
      }

      // Deployed again since this folder published it (another machine, rayfin up)?
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
            `${plan.name} was deployed again on ${new Date(theirs).toLocaleString()}, not from this folder. Overwrite it?`,
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

      // The model's .yaml goes into its lakehouse, where the app will read it. A different file
      // already there is replaced only when the user says so, and not being able to tell what is
      // there stops the export here, with nothing written.
      const seen = target ? await writer.stat(target.workspace, target.path) : undefined;
      // Past the cache: what's there now is the question, and a kept copy is what was there.
      const atTarget = target && await writer.compare(target.workspace, target.path, text,
        () => catalog.readBytes(target.workspace, target.path));
      if (atTarget === 'different') {
        const pick = await ui.warn(
          `${target.workspace}/${target.path} already exists.`,
          { modal: true, detail: `Replace it with ${model.name} as opened here, and publish?` }, 'Replace It');
        if (pick !== 'Replace It') throw declined(`Not exported: ${target.path} is a different file.`);
      }

      // Every question is answered: from here on it writes.
      if (target) {
        if (atTarget !== 'same') {
          await writer.writeFile(target.workspace, target.path, Buffer.from(String(text), 'utf8'), { over: seen });
          log(`export: wrote ${model.workspace}/${model.name} -> ${target.workspace}/${target.path}`);
          const lh = { workspace: target.workspace, item: target.item };
          await onelake.files(lh, 'semantic_model', { fresh: true }).catch(() => {});
          onRefresh({ kind: 'dir', ...lh, dir: 'semantic_model' });
        }
      }

      const ext = extensionDir;
      const fabricAppDir = join(ext, 'fabric_app');
      const appDir = await pageDir();
      // One publish, under a progress notification.
      const r = await ui.withProgress(`Export to Fabric: ${plan.name}`,
        async progress => {
          const say = line => { log(line); progress.report({ message: line.replace(/^app \S+: /, '') }); };
          let marker = before;
          if (asIs) say(`app ${plan.name}: publishing ${outDir} as it is`);
          else {
            say(`app ${plan.name}: writing the local copy to ${outDir}`);
            marker = await writeExport({ plan, state, outDir, fabricAppDir, appDir,
                                         daxSqlDir: join(ext, 'vendor', 'npm', PINS.daxSql),
                                         webappDir: join(ext, 'vendor', 'webapp') });
          }
          // What the page's packages weigh, there in the folder (site/vendor/) and here in the log.
          const mb = n => `${(n / 1048576).toFixed(1)} MB`;
          const size = await vendorSize(outDir);
          say(`app ${plan.name}: site/vendor/ is ${mb(size.total)}`);
          for (const [name, bytes] of size.parts) log(`  ${mb(bytes).padStart(9)}  ${name}`);
          const quiet = appLog;
          appLog = say;
          let done;
          try {
            done = await fabricApp.publish({
              workspaceId: plan.workspace, name: plan.name, tenantId: tenantOf(token),
              catalogUrl: plan.catalogUrl, modelUrl: plan.modelUrl,
              site: async config => await zip(await buildDist(outDir, config)),
              fn: { sourceZip, deployMetaData }, redirects: marker.redirects || [],
              itemId: marker.itemId || null, takeOver,
              // Kept as soon as there is one: if a later step fails, the next export must know this
              // item is its own rather than ask about an app it made.
              onItem: id => writeMarker(outDir, { ...marker, itemId: id }),
            });
          } finally { appLog = quiet; }
          // The redirects in rayfin.yml: the template's, or (as is) the folder's own.
          const yml = join(outDir, 'rayfin', 'rayfin.yml');
          const tpl = asIs && existsSync(yml) ? await fsp.readFile(yml, 'utf8')
            : await fsp.readFile(join(fabricAppDir, 'rayfin', 'rayfin.yml'), 'utf8');
          await fsp.writeFile(yml, rayfinYml(tpl, plan.name, done.redirects));
          // What was published, to compare the next export with: the folder's files, and the
          // deploy's time by Fabric's clock.
          const live = await fabricApp.deployStatus(plan.workspace, done.itemId).catch(() => null);
          await writeMarker(outDir, { ...marker, itemId: done.itemId, hostingUrl: done.hostingUrl,
                                      redirects: done.redirects, exportedAt: new Date().toISOString(),
                                      deployedAt: (live && live.lastSuccessfulDeploymentAt) || new Date().toISOString(),
                                      files: await fingerprint(outDir) });
          return done;
        });
      // The Apps of the workspace the app was published to (the lakehouse's, not always the
      // model's), re-read: the app is new, or deployed again.
      onRefresh({ kind: 'apps', workspace: plan.workspace });
      log(`exported ${plan.name} -> ${r.hostingUrl || '(no hosting URL)'} (item ${r.itemId}, model ${plan.modelPath}, local copy ${outDir})`);
      for (const w of plan.warnings) log(`  warning: ${w}`);
      const warned = plan.warnings.length ? ` ${plan.warnings.length} warning(s) in the log.` : '';
      ui.info(`${plan.name} is published to Fabric.${warned}`, 'Open App', 'Reveal Folder')
        .then(pick => {
          if (pick === 'Open App' && r.hostingUrl) ui.openExternal(r.hostingUrl);
          else if (pick === 'Reveal Folder') ui.reveal(outDir);
        });
      return `Published to Fabric${asIs ? ' (the local copy, as it is)' : ''}: ${r.hostingUrl || plan.name}`;
    } catch (e) {
      if (!(e && e.declined)) log(`export to fabric of ${file} failed — ${(e && e.stack) || e}`);
      throw e;
    }
  };

  return { exportExplore };
}

module.exports = { createExport };
