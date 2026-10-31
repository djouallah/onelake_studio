'use strict';
// =============================================================================
// catalogsnapshot.js — the engine's catalog, kept as one entry
// =============================================================================
// Listing the catalog walks the cache: an entry per table, and a first SHOW ALL TABLES would wait
// for all of them. So the last list is kept as one entry. A store's first listing
// answers from it at once and walks behind the caller; if the walk finds something else, onMoved
// says so, and the next statement that reads the catalog lists it again.
//
// No `vscode` import: driven from tests.
// =============================================================================

/**
 * @param {object} o
 * @param {() => Promise<object[]>} o.walk       the list, from the cache itself
 * @param {() => Promise<object[]|undefined>} o.read   the kept list
 * @param {(list: object[]) => Promise<void>} o.write  keep this list
 * @param {() => void} [o.onMoved]               what was answered is not what the cache holds
 * @param {(e: Error) => void} [o.onError]       a walk behind the caller failed
 */
function createCatalogSnapshot({ walk, read, write, onMoved = () => {}, onError = () => {} }) {
  let mayUseKept = true;
  let answered = null;   // the kept list, while the walk behind it is under way
  let walking = null;
  let turn = 0;

  // One walk at a time, and only the latest store's result is kept.
  function walkAndKeep() {
    if (!walking) {
      const mine = turn;
      const run = (async () => {
        const list = await walk();
        if (mine === turn) await write(list);
        return list;
      })().finally(() => { if (walking === run) walking = null; });
      walking = run;
    }
    return walking;
  }

  async function list() {
    if (mayUseKept) {
      mayUseKept = false;
      const mine = turn;
      const kept = await read();
      if (kept && mine === turn) {
        answered = kept;
        const before = JSON.stringify(kept);
        walkAndKeep().then(
          found => { if (mine === turn && JSON.stringify(found) !== before) onMoved(); },
          onError,
        ).finally(() => { if (mine === turn) answered = null; });
        return kept;
      }
    }
    return answered || walkAndKeep();
  }

  return {
    list,
    // The cache changed under it: the next listing walks, and keeps what it finds.
    moved() { mayUseKept = false; answered = null; },
    // Another account's store: its own kept list is the answer again.
    reset() { turn++; mayUseKept = true; answered = null; walking = null; },
  };
}

module.exports = { createCatalogSnapshot };
