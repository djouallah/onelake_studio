// =============================================================================
// ranges.js — which bytes of a table's Parquet files a query reads
// =============================================================================
// A table larger than SMALL_BYTES (data.js) is not downloaded whole: the page downloads each
// file's footer, then only the column chunks the queries read, into the store (blockcache.js),
// and DuckDB reads them there. Measured on OneLake (2026-11-10, a laptop, six requests at a time
// as the browser makes them), a Report over 2 of 22 columns of a 4 GB table came down in 12-19 s
// instead of 123 s whole, and 3 of 19 columns of a 9 GB one in 37-62 s instead of 354 s.
// OneLake answers each request in ~0.6 s whatever its size, so fewer, larger requests win: a
// file's chunks are read together when they are within GAP of each other, the bytes between
// them included. One request per chunk was the slowest way measured.
//
//   columnsIn(sql, columns)      the columns (a table's, by name) that SQL names: every word and
//                                quoted name in it, so a column is never missed (a few are read
//                                that were not needed, where a name is also an alias or a word)
//   readsAll(sql, name)          SQL reads every column of v_<name> (SELECT * FROM it, v_<name>.*)
//   columnRanges(chunks, wanted) a file's byte ranges for the columns `wanted` (lowercase names):
//                                chunks [{ col, from, to }], merged within GAP
//   tailOf(size)                 the last bytes of a file, where its footer is
//   piecesOf(path, size, ranges, runs)
//                                what to download of a file for `ranges`: each on the store's
//                                blocks, merged, without the blocks it holds (runs [[n0, n1]]
//                                of block numbers, sorted): [{ path, size, from, to }]
// Every range is [from, to], `to` included, as HTTP's Range header has it.
// =============================================================================

export const BLOCK = 256 * 1024;          // blockcache.js's block: the store keeps whole blocks
export const GAP = 8 * 1024 * 1024;       // two chunks this close are one request (measured best)
export const TAIL = 64 * 1024;            // a file's last bytes, read for its footer

const align = ([a, b], size) => [Math.floor(a / BLOCK) * BLOCK, Math.min(size - 1, Math.ceil((b + 1) / BLOCK) * BLOCK - 1)];

// Ranges merged where the gap between two is at most `gap` bytes, in order.
export function merge(ranges, gap = 0) {
  const out = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a - last[1] - 1 <= gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function columnsIn(sql, columns) {
  const words = new Set();
  for (const m of String(sql).matchAll(/"((?:[^"]|"")*)"|[A-Za-z_][A-Za-z0-9_$]*/g))
    words.add((m[1] != null ? m[1].replace(/""/g, '"') : m[0]).toLowerCase());
  return columns.filter(c => words.has(c.toLowerCase()));
}

export function readsAll(sql, name) {
  const v = `v_${name}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\bSELECT\\s+(?:DISTINCT\\s+)?\\*\\s+FROM\\s+"?${v}\\b|\\b"?${v}"?\\.\\*`, 'i').test(String(sql));
}

export function columnRanges(chunks, wanted) {
  return merge(chunks.filter(c => wanted.has(c.col.toLowerCase())).map(c => [c.from, c.to]), GAP);
}

export const tailOf = size => [Math.max(0, size - TAIL), size - 1];

// What of [from, to] (on blocks) the runs of held blocks lack.
function lacking([from, to], runs, size) {
  const out = [];
  let at = from;
  for (const [n0, n1] of runs) {
    const a = n0 * BLOCK, b = Math.min((n1 + 1) * BLOCK - 1, size - 1);
    if (b < at) continue;
    if (a > to) break;
    if (a > at) out.push([at, a - 1]);
    at = b + 1;
    if (at > to) break;
  }
  if (at <= to) out.push([at, to]);
  return out;
}

export function piecesOf(path, size, ranges, runs = []) {
  return merge(ranges.map(r => align(r, size)))
    .flatMap(r => lacking(r, runs, size))
    .map(([from, to]) => ({ path, size, from, to }));
}
