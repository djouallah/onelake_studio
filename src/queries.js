'use strict';
// =============================================================================
// queries.js — saved queries, on disk
// =============================================================================
// Saved queries: one .sql file each in ~/OneLakeStudio/queries/<account>/, beside the
// downloaded models. They name their tables lakehouse.workspace.item.schema.table — names
// that mean something in one tenant only — so each account (and tenant, when the
// onelakeStudio.tenantId setting picks one) has its own, and signing in elsewhere shows
// that account's. The tree lists them, and each opens in the panel's SQL box.
// With no account known, there are none.
// =============================================================================

const { join } = require('node:path');
const { existsSync } = require('node:fs');
const fsp = require('node:fs/promises');

// A name as a file name: what Windows refuses becomes _, and the .sql is ours to add.
const queryStem = name => String(name).trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\.sql$/i, '');

/**
 * @param {object} o
 * @param {() => string} o.root  the folder every account's queries are under
 * @param {() => (string | null)} o.account  this account's folder there, or null with none known
 * @param {(line: string) => void} o.log
 * @param {() => void} o.onChange  what's listed changed
 */
function createQueries({ root, account, log, onChange }) {
  function queriesFolder() {
    return account() ? join(root(), account()) : null;
  }
  // Queries saved before they were kept per account sit loose in the root: they go to the
  // first account signed in, the one most likely to have saved them. Never over one there.
  async function adoptLooseQueries() {
    const dir = queriesFolder();
    if (!dir) return;
    const loose = (await fsp.readdir(root(), { withFileTypes: true }).catch(() => []))
      .filter(e => e.isFile() && /\.sql$/i.test(e.name));
    if (!loose.length) return;
    await fsp.mkdir(dir, { recursive: true });
    for (const e of loose) {
      if (existsSync(join(dir, e.name))) continue;
      await fsp.rename(join(root(), e.name), join(dir, e.name)).catch(() => {});
    }
    log(`saved queries: ${loose.length} moved into ${dir}`);
  }
  async function listQueries() {
    const dir = queriesFolder();
    if (!dir) return [];
    const files = await fsp.readdir(dir).catch(() => []);
    return files.filter(f => /\.sql$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .map(f => ({ name: f.replace(/\.sql$/i, ''), path: join(dir, f) }));
  }
  const queryPath = name => join(queriesFolder(), `${queryStem(name)}.sql`);

  // A new query kept under Queries as the next free "Query N", with nothing asked (Rename in
  // the tree names it). Answers { name, path }.
  async function saveNewQuery(sql) {
    if (!queriesFolder()) throw new Error('sign in to save queries — they are kept per account');
    await fsp.mkdir(queriesFolder(), { recursive: true });
    const taken = new Set((await listQueries()).map(q => q.name.toLowerCase()));
    let n = 1;
    while (taken.has(`query ${n}`)) n++;
    const stem = `Query ${n}`;
    const path = queryPath(stem);
    await fsp.writeFile(path, String(sql ?? ''), 'utf8');
    onChange();
    return { name: stem, path };
  }

  const saveQuery = async ({ name, sql }) => {
    if (!name || !queriesFolder()) return saveNewQuery(sql);
    const path = queryPath(name);
    await fsp.mkdir(queriesFolder(), { recursive: true });
    await fsp.writeFile(path, sql, 'utf8');
    onChange();
    return { name, path };
  };

  return { queriesFolder, adoptLooseQueries, listQueries, queryPath, saveQuery };
}

module.exports = { createQueries, queryStem };
