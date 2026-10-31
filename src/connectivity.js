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

module.exports = { createConnectivity };
