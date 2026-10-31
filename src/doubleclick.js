'use strict';
// =============================================================================
// doubleclick.js — a double click on a tree item
// =============================================================================
// VS Code has no such event: a TreeItem's command runs on every click. So two clicks on the same
// item within `windowMs` are the double click. A pair is used up when it fires, since VS Code can
// run the command a third time for the double click itself, and that must not open a second one.
// =============================================================================

function doubleClicks(windowMs = 500, now = Date.now) {
  let last = null, at = 0;
  return key => {
    const t = now();
    const twice = key === last && t - at <= windowMs;
    last = twice ? null : key;
    at = t;
    return twice;
  };
}

module.exports = { doubleClicks };
