'use strict';
// =============================================================================
// diaglog.js — this window's own log, readable from the command line
// =============================================================================
// Wraps the Output channel: each line gets the time, and the last few thousand are kept in memory so
// `log` on the command line can answer with them, with nobody having to find the channel's file, whose
// path changes every session. `mark` is a step of starting up, in ms since the extension host started:
// the difference between two of them says whose time it was. `status` reads those back too.
//
// This is what the extension did, for debugging it. What the engine ran is the Logs tab (logfile.js).
//
// No `vscode` import: the extension passes in the channel.
// =============================================================================

const KEEP = 2000;

const stampOf = d => `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;

/**
 * @param {{ appendLine: (line: string) => void, show?: Function, dispose?: Function }} channel
 * @param {object} [o]
 * @param {number} [o.keep]  lines kept for `lines`
 * @param {() => Date} [o.now]
 * @param {() => number} [o.upMs]  how long the process has been up
 */
function createDiagLog(channel, { keep = KEEP, now = () => new Date(), upMs = () => Math.round(process.uptime() * 1000) } = {}) {
  const ring = [];
  const steps = [];
  function appendLine(line) {
    const text = `${stampOf(now())} ${line}`;
    ring.push(text);
    if (ring.length > keep) ring.shift();
    channel.appendLine(text);
  }
  return {
    appendLine,
    show: (...a) => channel.show && channel.show(...a),
    dispose: () => channel.dispose && channel.dispose(),
    mark(step) {
      const ms = upMs();
      steps.push({ step, ms });
      appendLine(`start: ${step} at ${ms}ms`);
    },
    timeline: () => [...steps],
    /** The newest `limit`, oldest first, of the lines holding `text`, whatever its case. */
    lines({ limit = 200, text = '' } = {}) {
      const wanted = String(text).toLowerCase();
      return (wanted ? ring.filter(l => l.toLowerCase().includes(wanted)) : ring).slice(-limit);
    },
  };
}

module.exports = { createDiagLog };
