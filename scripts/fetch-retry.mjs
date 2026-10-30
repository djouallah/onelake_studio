// Fetch with retry, for the build scripts (vendor.mjs, fetch-extensions.mjs): up to three
// tries, one then two seconds apart, each bounded by `timeoutMs`. A 404 is an answer, not a
// hiccup, so it is not tried again: null when `missingOk`, else an error. Any other failure
// that outlasts the tries is an error.
export async function fetchRetry(url, { missingOk = false, tries = 3, timeoutMs = 300_000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let failure;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      if (r.status === 404) {
        if (missingOk) return null;
        throw Object.assign(new Error(`${url}: HTTP 404`), { final: true });
      }
      failure = `HTTP ${r.status}`;
    } catch (e) {
      if (e.final) throw e;
      failure = e.message;
    }
    if (attempt >= tries) throw new Error(`${url}: ${failure}`);
    await new Promise(res => setTimeout(res, 1000 * attempt));
  }
}
