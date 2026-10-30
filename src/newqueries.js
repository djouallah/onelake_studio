'use strict';
// =============================================================================
// newqueries.js — which untitled editors are new queries
// =============================================================================
// New Query opens an untitled document; only those get Run, Plan, Save Query and the lenses.
// Nothing about an untitled document says it is one, so its URI is kept here, for as long as it
// has a tab: VS Code restores the tab across a reload, and it is still the same query. Another
// SQL extension that takes over its language closes and reopens the document, and the tab stays.
// A tab closed for good frees its URI for the next Untitled-1, which is not a query.
//
// No `vscode` import: the extension passes in what it owns.
// =============================================================================

const KEY = 'onelakeStudio.newQueries';

/**
 * @param {{ get(key: string, fallback: string[]): string[], update(key: string, value: string[]): unknown }} state
 *        the window's storage (context.workspaceState)
 * @param {() => string[]} openTabs  the URIs every open tab shows
 */
function createNewQueries(state, openTabs) {
  const uris = new Set(state.get(KEY, []));
  const keep = () => state.update(KEY, [...uris]);
  // Tabs closed while nothing was listening. No tabs at all says nothing: they may not be
  // restored yet, and a query forgotten is worse than a stale name.
  const atStart = new Set(openTabs());
  if (atStart.size) {
    for (const uri of uris) if (!atStart.has(uri)) uris.delete(uri);
    keep();
  }
  return {
    has: uri => uris.has(uri),
    add(uri) { uris.add(uri); keep(); },
    // Tabs were closed: their URIs are free unless another tab still shows the document.
    tabsClosed(closed) {
      const open = new Set(openTabs());
      const gone = closed.filter(uri => uris.has(uri) && !open.has(uri));
      gone.forEach(uri => uris.delete(uri));
      if (gone.length) keep();
    },
  };
}

module.exports = { createNewQueries };
