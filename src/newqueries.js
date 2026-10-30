'use strict';
// =============================================================================
// newqueries.js — which untitled editors are new queries
// =============================================================================
// New Query opens an untitled document; only those get Run, Plan, Save Query and the lenses.
// Nothing about an untitled document says it is one, so its URI is kept here, for as long as it
// has a tab: VS Code restores the tab across a reload, and it is still the same query. Another
// SQL extension that takes over its language closes and reopens the document, and the tab stays.
// A tab closed for good frees its URI for the next new query.
//
// The URI is picked before the document opens, and the window hears it through onChange (the
// title bar's buttons and the keys read the list), so nothing on screen waits for this host.
//
// No `vscode` import: the extension passes in what it owns.
// =============================================================================

const KEY = 'onelakeStudio.newQueries';

// As VS Code writes it (a Uri's toString), since the window compares the two as text.
const queryUri = n => `untitled:Query%20${n}.sql`;

/**
 * @param {{ get(key: string, fallback: string[]): string[], update(key: string, value: string[]): unknown }} state
 *        the window's storage (context.workspaceState)
 * @param {() => string[]} openTabs  the URIs every open tab shows
 * @param {(uris: string[]) => unknown} [onChange]  the list, at the start and whenever it moves
 */
function createNewQueries(state, openTabs, onChange = () => {}) {
  const uris = new Set(state.get(KEY, []));
  const keep = () => state.update(KEY, [...uris]);
  const changed = () => onChange([...uris]);
  // Tabs closed while nothing was listening. No tabs at all says nothing: they may not be
  // restored yet, and a query forgotten is worse than a stale name.
  const atStart = new Set(openTabs());
  if (atStart.size) {
    for (const uri of uris) if (!atStart.has(uri)) uris.delete(uri);
    keep();
  }
  changed();
  return {
    has: uri => uris.has(uri),
    // The first "Query N" nothing holds. `inUse`: documents open with no tab of their own.
    nextUri(inUse = []) {
      const taken = new Set([...uris, ...openTabs(), ...inUse]);
      let n = 1;
      while (taken.has(queryUri(n))) n++;
      return queryUri(n);
    },
    // What onChange answers, so a caller can wait for the window to have heard.
    add(uri) { uris.add(uri); keep(); return changed(); },
    // Tabs were closed: their URIs are free unless another tab still shows the document.
    tabsClosed(closed) {
      const open = new Set(openTabs());
      const gone = closed.filter(uri => uris.has(uri) && !open.has(uri));
      gone.forEach(uri => uris.delete(uri));
      if (gone.length) { keep(); changed(); }
    },
  };
}

module.exports = { createNewQueries };
