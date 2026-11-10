'use strict';
// =============================================================================
// http.js — how the host asks OneLake and the Fabric API for anything
// =============================================================================
// One request with a bearer token (authedFetch): a fresh token once on a 401 — and only on a
// 401: a 403 means this identity may not, and a new token will not change its mind — and,
// for the callers that ask for it, a 429 or a "not ready yet" status waited out. What the
// service said when it refused (its error body), Fabric's continuation-token paging, and how
// many requests run at once. catalog.js, onelakewrite.js, fabric.js and fabricapp.js each
// take what they need; none of them writes its own.
// =============================================================================

const sleepMs = ms => new Promise(r => setTimeout(r, ms));

// Whether this window may ask anything (connectivity.js). Offline, no request is sent, and one
// that gets no answer at all is reported there.
let connectivity = null;
function useConnectivity(c) { connectivity = c; }

// `what`: what is missing, when the caller knows.
function offlineError(reason, what = 'This') {
  const why = reason === 'no internet' ? 'there is no internet' : 'you are not signed in';
  return Object.assign(new Error(`${what} is not cached on this machine, and ${why}.`), { offline: true, status: 0 });
}

// A token held for a moment, so a burst of requests asks the account provider once. An answer that
// arrives after forget() is not kept: it may be for the account just signed out of. `turn` is taken
// before asking, and `keep` says whether the answer still stood.
function createTokenHold(ttlMs, now = Date.now) {
  let held = null, turn = 0;
  return {
    recent: () => (held && now() - held.at < ttlMs ? held.token : null),
    any: () => (held ? held.token : null),
    turn: () => turn,
    keep(askedAt, token) {
      if (askedAt !== turn) return false;
      held = token ? { token, at: now() } : null;
      return true;
    },
    forget() { turn++; held = null; },
  };
}

// `asked`'s answer, or null after `ms`: activation must not wait on a provider that has stalled.
// `onLate` hears an answer that comes after that, and a failure is no answer.
function inTime(asked, ms, onLate = () => {}) {
  return new Promise(resolve => {
    let late = false;
    const timer = setTimeout(() => { late = true; resolve(null); }, ms);
    Promise.resolve(asked).then(
      value => { clearTimeout(timer); if (late) onLate(value); else resolve(value); },
      () => { clearTimeout(timer); resolve(null); });
  });
}

// A response that is not going to be read: its body let go, so its socket is free now
// rather than whenever it is collected.
function discard(r) {
  try {
    const p = r && r.body && typeof r.body.cancel === 'function' ? r.body.cancel() : null;
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {}
}

// Retry-After, in ms, capped at 30 s; `fallback` when the response gives none.
const retryAfterMs = (r, fallback) => {
  const s = Number(r.headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? Math.min(s, 30) * 1000 : fallback;
};

/**
 * @param {string} url
 * @param {object} o
 * @param {(o?: {fresh?: boolean}) => Promise<string|null>} o.getToken
 * @param {number} o.timeoutMs                    each send's own timeout, body included; 0 for none
 * @param {AbortSignal} [o.signal]                the caller has gone
 * @param {string} [o.who]                        what "not signed in" names
 * @param {number[]} [o.retry]                    statuses besides 429 to wait out
 * @param {number} [o.attempts]                   sends at most (a 401's fresh-token send aside)
 * @param {(attempt: number) => number} [o.backoffMs]  the wait when there is no Retry-After
 * @param {(send: () => Promise<Response>) => Promise<Response>} [o.through]  wraps each send
 */
async function authedFetch(url, { getToken, fetchImpl = (...a) => fetch(...a), timeoutMs, method = 'GET', headers = {},
                                  body, who = 'a Microsoft account', retry = [], attempts = 1,
                                  backoffMs = () => 5000, sleep = sleepMs, through = send => send(), signal = null }) {
  if (connectivity && connectivity.offline()) throw offlineError(connectivity.reason());
  let token = await getToken();
  if (!token) throw Object.assign(new Error(`Not signed in to ${who}.`), { status: 401 });
  const send = t => through(async () => {
    try {
      const ends = [timeoutMs ? AbortSignal.timeout(timeoutMs) : null, signal].filter(Boolean);
      return await fetchImpl(url, {
        method, body, headers: { ...headers, authorization: `Bearer ${t}` },
        ...(ends.length ? { signal: ends.length > 1 ? AbortSignal.any(ends) : ends[0] } : {}),
      });
    } catch (e) {
      // A caller that went away says nothing of the network.
      if (connectivity && !(signal && signal.aborted)) connectivity.networkFailed();
      throw e;
    }
  });
  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    const r = await send(token);
    if (r.status === 401 && !refreshed) {
      refreshed = true;
      // { fresh: true } or the retry is theatre: the extension's token cache would hand back
      // the very string that just 401'd.
      const fresh = await getToken({ fresh: true });
      if (fresh && fresh !== token) { discard(r); token = fresh; attempt--; continue; }
    }
    if (attempt >= attempts || !(r.status === 429 || retry.includes(r.status))) return r;
    discard(r);
    await sleep(retryAfterMs(r, backoffMs(attempt)));
  }
}

// What the service said, from its error body. Its messages name the missing permission, the
// unsupported model or the tenant setting, which a bare status code never does.
async function bodyMessage(r, pick) {
  try { return pick(JSON.parse(await r.text())) || ''; } catch (_) { return ''; }
}
const fabricMessage = r => bodyMessage(r, j => j && (j.message || (j.error && j.error.message)));
const oneLakeMessage = r => bodyMessage(r, j => j && j.error && j.error.message);

// What the Fabric REST clients share (models/fabric.js, and the export's fabricapp.js and fabricmodel.js).
const FABRIC_API = 'https://api.fabric.microsoft.com/v1';
/** An answer the Fabric API gave, which must be OK or one of `ok`: else `what` failed, with what it said. */
async function fabricOk(r, what, ok = []) {
  if (r.ok || ok.includes(r.status)) return r;
  const said = await fabricMessage(r);
  throw Object.assign(new Error(`${what} failed (HTTP ${r.status})` + (said ? ` — ${said}` : '')), { status: r.status });
}
// An answer's body as JSON, or as its text when it isn't JSON.
const jsonOrText = async r => { const t = await r.text(); try { return JSON.parse(t); } catch (_) { return t; } };
// Whether an item has this display name, whatever its case.
const namedLike = name => i => String(i.displayName).toLowerCase() === String(name).toLowerCase();
/**
 * A long-running operation (202 + Location), asked with `call` until it has Succeeded: every `waitMs`, or
 * as its Retry-After says, `polls` times at most.
 */
async function waitFabricOperation(r, what, { call, sleep, waitMs, polls }) {
  const location = r.headers.get('location');
  if (!location) return;
  let wait = retryAfterMs(r, waitMs);
  for (let i = 0; i < polls; i++) {
    await sleep(wait);
    const p = await call(location, { what });
    const op = await jsonOrText(p);
    if (op.status === 'Succeeded') return;
    if (op.status === 'Failed' || op.status === 'Undefined') {
      throw new Error(`${what} failed — ${(op.error && (op.error.message || op.error.errorCode)) || op.status}`);
    }
    wait = retryAfterMs(p, waitMs);
  }
  throw new Error(`${what} did not finish`);
}

// The body of an answer that said OK. One that can't be read fails, as the connection going part way
// or the timeout, which covers the body too: taken for an empty answer, it would be kept, over what was known.
// `before`: the text, changed before it is parsed.
async function okJson(r, what, before = null) {
  try { return before ? JSON.parse(before(await r.text())) : await r.json(); }
  catch (e) {
    if (connectivity) connectivity.networkFailed();
    throw new Error(`${what}: the answer was cut off — ${(e && e.message) || e}`);
  }
}

// Fabric's list calls page with continuationToken and say so in the body. `page(url)` answers
// one page's JSON.
async function listPages(firstUrl, page, { what, maxPages = 200 }) {
  const out = [];
  let cont = '', pages = 0;
  do {
    if (++pages > maxPages) throw new Error(`${what} did not finish after ${maxPages} pages — giving up`);
    const u = new URL(firstUrl);
    if (cont) u.searchParams.set('continuationToken', cont);
    const j = (await page(u.toString())) || {};
    out.push(...(j.value || []));
    cont = j.continuationToken || '';
  } while (cont);
  return out;
}

// At most `n` at once, the rest queued in order.
function limiter(n) {
  let active = 0;
  const waiting = [];
  const next = () => { if (active < n && waiting.length) { active++; waiting.shift()(); } };
  return async fn => {
    await new Promise(r => { waiting.push(r); next(); });
    try { return await fn(); } finally { active--; next(); }
  };
}

// fn over every item, `limit` at a time; the answers in the items' order.
async function mapPool(items, fn, limit) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

module.exports = { FABRIC_API, fabricOk, jsonOrText, namedLike, waitFabricOperation,
  createTokenHold, inTime, authedFetch, discard, retryAfterMs, fabricMessage, oneLakeMessage, okJson, listPages, limiter, mapPool, useConnectivity, offlineError };
