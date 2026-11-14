// Random input for the tests that try to break a parser, from a seed: a failure says its seed, and the same
// seed makes the same input again. FUZZ_SEED runs one seed; FUZZ_RUNS says how many inputs a test tries.

/** A generator of 32-bit integers from `seed` (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
  const r = {
    int: n => next() % n,
    bool: () => (next() & 1) === 1,
    pick: list => list[next() % list.length],
    bytes: n => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = next() & 0xff; return b; },
    /** `n` pieces of `alphabet` (strings), joined. */
    text: (alphabet, n) => { let s = ""; for (let i = 0; i < n; i++) s += alphabet[next() % alphabet.length]; return s; },
  };
  return r;
}

export const RUNS = Number(process.env.FUZZ_RUNS) || 300;
const FIRST = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : 20261114;

/**
 * Runs `check(r, seed)` on RUNS seeds (one, with FUZZ_SEED). What it throws is thrown again with the seed in
 * front, so the input can be made again.
 */
export function eachSeed(check, runs = RUNS) {
  const n = process.env.FUZZ_SEED ? 1 : runs;
  for (let i = 0; i < n; i++) {
    const seed = FIRST + i;
    try { check(rng(seed), seed); }
    catch (e) {
      e.message = `[FUZZ_SEED=${seed}] ${e.message}`;
      throw e;
    }
  }
}

/** `buf` with a few of its bytes changed, cut short, or with random bytes put in. */
export function mutate(r, buf) {
  const out = Buffer.from(buf);
  const how = r.int(4);
  if (how === 0 && out.length) { for (let i = 0, n = 1 + r.int(8); i < n; i++) out[r.int(out.length)] = r.int(256); return out; }
  if (how === 1) return out.subarray(0, r.int(out.length + 1));
  if (how === 2 && out.length) { const at = r.int(out.length); return Buffer.concat([out.subarray(0, at), r.bytes(1 + r.int(64)), out.subarray(at)]); }
  if (out.length >= 4) out.writeUInt32LE(r.pick([0, 1, 0x7fffffff, 0xffffffff, out.length, out.length + 1]), r.int(out.length - 3));
  return out;
}
