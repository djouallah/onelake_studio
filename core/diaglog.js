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

const { readdirSync } = require('node:fs');
const { join } = require('node:path');

const KEEP = 2000;
const FREEZE_EVERY_MS = 100;
const FREEZE_OVER_MS = 500;
const FREEZE_FOR_MS = 3 * 60_000;

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
    /** `ms` when the step happened before there was a log to say it in. */
    mark(step, ms = upMs()) {
      steps.push({ step, ms });
      appendLine(`start: ${step} at ${ms}ms`);
    },
    timeline: () => [...steps],
    /**
     * Says when the extension host's one thread was held, by anyone, while starting up: a timer that
     * should fire every `everyMs` and fired late. That says when, not who, so it is read beside the
     * other steps. It stops by itself once starting up is long over.
     */
    watchFreezes({ everyMs = FREEZE_EVERY_MS, overMs = FREEZE_OVER_MS, forMs = FREEZE_FOR_MS } = {}) {
      const began = performance.now();
      let last = began;
      const timer = setInterval(() => {
        const at = performance.now();
        const late = at - last - everyMs;
        last = at;
        if (late >= overMs) this.mark(`the extension host was frozen for ${Math.round(late)}ms, ending`);
        if (at - began >= forMs) clearInterval(timer);
      }, everyMs);
      if (timer.unref) timer.unref();
      return () => clearInterval(timer);
    },
    /** The newest `limit`, oldest first, of the lines holding `text`, whatever its case. */
    lines({ limit = 200, text = '' } = {}) {
      const wanted = String(text).toLowerCase();
      return (wanted ? ring.filter(l => l.toLowerCase().includes(wanted)) : ring).slice(-limit);
    },
  };
}

/**
 * The Output channel's file, or null. VS Code numbers it and dates its folder afresh each session, under
 * the extension host's log folder.
 * @param {string} exthostDir  the parent of `context.logUri`
 * @param {string} name  the channel's name
 */
function outputLogOf(exthostDir, name) {
  const inside = dir => { try { return readdirSync(dir); } catch (_) { return []; } };
  for (const dir of inside(exthostDir).filter(d => d.startsWith('output_logging_')).sort().reverse()) {
    const file = inside(join(exthostDir, dir)).find(f => f.endsWith(`-${name}.log`));
    if (file) return join(exthostDir, dir, file);
  }
  return null;
}

module.exports = { createDiagLog, outputLogOf };
