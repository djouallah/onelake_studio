'use strict';
// =============================================================================
// onscreen.js — what the panel is showing, written down for Claude Code
// =============================================================================
// "This table", "the model I have open": Claude Code cannot see a webview, so the panel says
// what is on screen and this writes it to one JSON file per window, which the skill
// (claude-skill/SKILL.md) tells Claude to read: names, the SQL or DAX last run, and the first
// rows of the result on screen. Anything more, Claude asks for through cli.mjs.
//
//   open    what the panel has open: a table, a file, or a semantic model
//   query   the last SQL the main editor ran, and its first rows
//   model   the model view: which page is in front, its SQL page's last query, Explore's DAX
//
// A new `open` drops the `query` and `model` that described the previous one. The file is
// deleted when the panel closes, and a window that died without saying so (its pid gone) has
// its file removed by the next window to start.
//
// No `vscode` import: the extension passes in where, and which window.
// =============================================================================

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { join } = require('node:path');
const { sqlSchema } = require('./agent');

const FILE = /^panel-(\d+)\.json$/;
// What the page sends is reduced to strings of a sane length: a pasted 1 MB statement has no
// business in a file meant to be read at a glance.
const MAX_TEXT = 20_000;
const str = v => (v == null ? undefined : String(v).slice(0, MAX_TEXT));
const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : undefined);
const q = s => (/^[\w.-]+$/.test(s) ? s : `"${s}"`);

// What the panel opened, with the command lines that reach the same thing.
function openOf(o) {
  if (!o || typeof o !== 'object') return null;
  const at = new Date().toISOString();
  if (o.kind === 'table') {
    const lh = { workspace: str(o.workspace), item: str(o.item) };
    const t = { schema: str(o.schema) || '', table: str(o.table) };
    const name = t.schema ? `${t.schema}.${t.table}` : t.table;
    return { kind: 'table', ...lh, ...t, opened: at, cli: {
      table: `table ${q(lh.workspace)} ${q(lh.item)} ${q(name)}`,
      sql: `sql "SELECT * FROM ${sqlSchema(lh, t)}.${t.table} LIMIT 10" --in ${q(`${lh.workspace}/${lh.item}`)}`,
    } };
  }
  if (o.kind === 'file') {
    return { kind: 'file', workspace: str(o.workspace), item: str(o.item), path: str(o.path), opened: at };
  }
  if (o.kind === 'model') {
    const m = { kind: 'model', name: str(o.name), file: str(o.file), path: str(o.path),
                workspace: str(o.workspace), model: str(o.model), opened: at };
    m.cli = { sql: `sql "SHOW SEMANTIC METRICS IN ${m.name}"` };
    if (m.workspace && m.model) m.cli.model = `model ${q(m.workspace)} ${q(m.model)}`;
    return m;
  }
  return null;
}

// The rows on screen, as the user sees them: the first SAMPLE_ROWS, each value cut short, so
// a question about "these rows" is answered without running anything again.
const SAMPLE_ROWS = 50;
const MAX_VALUE = 500;
function sampleOf(x) {
  if (!Array.isArray(x.fields) || !Array.isArray(x.sample)) return {};
  const fields = x.fields.slice(0, 200).map(f => String(f));
  const cut = v => (v == null || typeof v === 'number' || typeof v === 'boolean' ? v
    : (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, MAX_VALUE));
  const sample = x.sample.slice(0, SAMPLE_ROWS).map(r => {
    const o = {};
    for (const f of fields) o[f] = cut(r && r[f]);
    return o;
  });
  return { fields, sample };
}

const queryOf = x => (x && typeof x === 'object'
  ? { sql: str(x.sql), ident: str(x.ident), rows: num(x.rows), ms: num(x.ms), error: str(x.error), ...sampleOf(x),
      at: new Date().toISOString() }
  : null);

function modelPart(x) {
  if (!x || typeof x !== 'object') return {};
  const at = new Date().toISOString();
  const part = {};
  if (x.page) part.page = str(x.page);
  if (x.sql != null) part.sql = { sql: str(x.sql), rows: num(x.rows), error: str(x.error), ...sampleOf(x), at };
  if (x.explore) {
    const e = x.explore;
    part.explore = { dax: str(e.dax), rows: num(e.rows), error: str(e.error), ...sampleOf(e), at };
  }
  return part;
}

/**
 * @param {object} o
 * @param {string} o.dir           where the windows' files go (the extension's global storage)
 * @param {object} [o.window]      which window this is: { workspace, folder }
 * @param {number} [o.pid]         this extension host's pid, which names the file
 * @param {(m: string) => void} [o.log]
 */
function createOnScreen({ dir, window: win = {}, pid = process.pid, log = () => {} }) {
  const file = join(dir, `panel-${pid}.json`);
  let state = null;
  // Writes go one at a time, in order: two updates a few ms apart must not land backwards.
  let chain = Promise.resolve();

  function save() {
    const snapshot = state && JSON.stringify({ window: { ...win, pid }, updated: new Date().toISOString(), ...state }, null, 2);
    chain = chain.then(async () => {
      if (!snapshot) { await fsp.rm(file, { force: true }); return; }
      await fsp.mkdir(dir, { recursive: true });
      // Whole or not at all: a reader never sees half a file.
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, snapshot);
      await fsp.rename(tmp, file).catch(() => fsp.writeFile(file, snapshot));
    }).catch(e => log(`panel state not written: ${e.message}`));
    return chain;
  }

  return {
    file,
    /** One message from the page: { open }, { query } or { model }, any of them. */
    update(msg) {
      if (!msg || typeof msg !== 'object') return chain;
      if (!state) state = { open: null, query: null, model: null };
      if ('open' in msg) { state.open = openOf(msg.open); state.query = null; state.model = null; }
      if ('query' in msg) state.query = queryOf(msg.query);
      if ('model' in msg) state.model = { ...(state.model || {}), ...modelPart(msg.model) };
      return save();
    },
    /** The panel closed: nothing is on screen. */
    close() { state = null; return save(); },
    /** At shutdown, where nothing may wait. */
    closeSync() { state = null; try { fs.rmSync(file, { force: true }); } catch (_) {} },
    /** Files of windows whose extension host is gone. */
    async sweep() {
      for (const name of await fsp.readdir(dir).catch(() => [])) {
        const m = FILE.exec(name);
        if (!m || Number(m[1]) === pid || alive(Number(m[1]))) continue;
        await fsp.rm(join(dir, name), { force: true }).catch(() => {});
      }
    },
  };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // exists, but not ours to signal
}

module.exports = { createOnScreen };
