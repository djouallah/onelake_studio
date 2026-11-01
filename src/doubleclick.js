'use strict';
// =============================================================================
// doubleclick.js — a double click on a tree item is one click
// =============================================================================
// VS Code has no such event: a TreeItem's command runs for the first click and again for the double
// click. So a repeat on the same item within `windowMs` is not a new click, and one tab or one
// browser is what opens. The webviews hold the same rule with the click's own `detail`.
// =============================================================================

function firstClicks(windowMs = 500, now = Date.now) {
  let last = null, at = 0;
  return key => {
    const t = now();
    const first = key !== last || t - at > windowMs;
    last = key;
    at = t;
    return first;
  };
}

module.exports = { firstClicks };
