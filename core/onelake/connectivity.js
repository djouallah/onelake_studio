'use strict';
// =============================================================================
// connectivity.js — whether this window can ask OneLake anything right now
// =============================================================================
// Offline is noticed, never switched on: there is no internet, or no session. Then the host sends
// nothing (http.js) and answers from what this machine holds (onelake.js).
//
// One failed request does not make it offline: a request that gets no answer at all starts a probe,
// and only a probe with no answer counts. Any HTTP status is an answer, so a slow connection or a
// 500 is online. While there is no internet the probe repeats, and that is how it comes back.
//
// No `vscode` import: driven from tests with a fake probe.
// =============================================================================

const PROBE_EVERY_MS = 30_000;

/**
 * @param {object} o
 * @param {() => Promise<boolean>} o.probe      true when the internet answered
 * @param {(reason: string|null) => void} [o.onChange]  offline or back, with why
 * @param {number} [o.everyMs]
 */
// The probe: whether OneLake answers at all. A refusal or no route is known at once. No answer in time
// isn't yet: a line a download is filling can take longer than that, and that line is online, so it gets
// a longer second try before anything is called offline.
const PROBE_MS = 5_000, PROBE_AGAIN_MS = 20_000;
// A probe that failed while this process's one thread was held says nothing about the internet: its time ran
// out, or its connection was dropped, with nobody there to take the answer. In VS Code the thread is every
// extension's, and at startup it has been seen held for 15 seconds, which read as "no internet" for half a
// minute. Such a probe is asked again, PROBE_TRIES times at most.
const PROBE_TRIES = 3, HELD_TICK_MS = 500, HELD_MS = 2_000;
/** Starts watching; the answer, when asked, is whether the thread was held for HELD_MS or more since. */
function watchHeld() {
  let last = performance.now(), held = false;
  const look = () => { const at = performance.now(); if (at - last - HELD_TICK_MS >= HELD_MS) held = true; last = at; };
  const timer = setInterval(look, HELD_TICK_MS);
  if (timer.unref) timer.unref();
  return () => { clearInterval(timer); look(); return held; };
}
function probeOf(ask, { watch = watchHeld } = {}) {
  const once = async () => {
    try { await ask(PROBE_MS); return true; }
    catch (e) {
      if (!e || (e.name !== 'TimeoutError' && e.name !== 'AbortError')) return false;
    }
    return ask(PROBE_AGAIN_MS).then(() => true, () => false);
  };
  return async () => {
    for (let n = 1; ; n++) {
      const wasHeld = watch();
      const answered = await once();
      const held = wasHeld();
      if (answered || !held || n >= PROBE_TRIES) return answered;
    }
  };
}

function createConnectivity({ probe, onChange = () => {}, everyMs = PROBE_EVERY_MS }) {
  let noInternet = false;
  let hasSession = true;
  let probing = null;
  let timer = null;

  const reason = () => (noInternet ? 'no internet' : !hasSession ? 'not signed in' : null);

  function changing(fn) {
    const was = reason();
    fn();
    const now = reason();
    if (now !== was) { try { onChange(now); } catch (_) {} }
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!noInternet) return;
    timer = setTimeout(check, everyMs);
    if (timer.unref) timer.unref();
  }

  // One probe at a time: a burst of failed requests shares it.
  function check() {
    if (!probing) {
      probing = Promise.resolve().then(probe).catch(() => false).then(answered => {
        probing = null;
        changing(() => { noInternet = !answered; });
        schedule();
        return answered;
      });
    }
    return probing;
  }

  return {
    reason,
    offline: () => !!reason(),
    noInternet: () => noInternet,
    check,
    // A request got no answer at all.
    networkFailed: () => { check(); },
    setSession: value => changing(() => { hasSession = !!value; }),
    dispose: () => { clearTimeout(timer); timer = null; },
  };
}

module.exports = { createConnectivity, probeOf };
