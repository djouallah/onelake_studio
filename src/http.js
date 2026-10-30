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
 * @param {number} o.timeoutMs                    each send's own timeout
 * @param {string} [o.who]                        what "not signed in" names
 * @param {number[]} [o.retry]                    statuses besides 429 to wait out
 * @param {number} [o.attempts]                   sends at most (a 401's fresh-token send aside)
 * @param {(attempt: number) => number} [o.backoffMs]  the wait when there is no Retry-After
 * @param {(send: () => Promise<Response>) => Promise<Response>} [o.through]  wraps each send
 */
async function authedFetch(url, { getToken, fetchImpl = (...a) => fetch(...a), timeoutMs, method = 'GET', headers = {},
                                  body, who = 'a Microsoft account', retry = [], attempts = 1,
                                  backoffMs = () => 5000, sleep = sleepMs, through = send => send() }) {
  let token = await getToken();
  if (!token) throw Object.assign(new Error(`Not signed in to ${who}.`), { status: 401 });
  const send = t => through(() => fetchImpl(url, {
    method, body, headers: { ...headers, authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(timeoutMs),
  }));
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

module.exports = { authedFetch, discard, retryAfterMs, fabricMessage, oneLakeMessage, listPages, limiter, mapPool };
