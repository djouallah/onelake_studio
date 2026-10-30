'use strict';
// =============================================================================
// history.js — the queries run from a query editor, kept per account
// =============================================================================
// One JSON line per run in <dir>/<account>.jsonl, newest last: what ran, when, how long it
// took, how many rows came back or why it failed, and how many requests the host made to
// OneLake meanwhile (catalog and metadata; DuckDB's own data reads are not counted). Each
// account its own file: a query names tables of one tenant. The newest MAX are kept.
// =============================================================================

const fsp = require('node:fs/promises');
const { join } = require('node:path');

const MAX = 1000;

function createHistory({ dir, max = MAX }) {
  let account = null;
  const file = () => (account ? join(dir, `${account}.jsonl`) : null);
  // One write at a time, so two runs finishing together do not interleave or trim each other.
  let chain = Promise.resolve();
  const serial = fn => (chain = chain.then(fn, fn));

  async function read() {
    const f = file();
    if (!f) return [];
    const text = await fsp.readFile(f, 'utf8').catch(() => '');
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_) { /* a line cut by a crash */ }
    }
    return out;
  }

  return {
    useAccount(key) { account = key || null; },
    // { sql, title, at, ms, rows, ok, error, requests }
    add(entry) {
      const f = file();
      if (!f) return Promise.resolve();
      return serial(async () => {
        await fsp.mkdir(dir, { recursive: true });
        await fsp.appendFile(f, JSON.stringify(entry) + '\n', 'utf8');
        // Trimmed now and then rather than on every run: past a fifth over, back to `max`.
        const all = await read();
        if (all.length > max * 1.2) {
          await fsp.writeFile(f, all.slice(-max).map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
        }
      });
    },
    // Newest first.
    async list() { await chain; return (await read()).reverse(); },
    clear() { const f = file(); return f ? serial(() => fsp.rm(f, { force: true })) : Promise.resolve(); },
  };
}

module.exports = { createHistory };
