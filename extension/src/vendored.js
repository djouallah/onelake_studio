'use strict';
// The packages the webview loads off jsDelivr, pinned. One list, read by three places that
// must agree: vendor.mjs downloads exactly these, proxy.js's unsecreted /npm route serves
// nothing else, and panel.js's CSP names nothing else. A version bumped in one of them
// and not the others fails closed — a refused import — rather than quietly widening what
// the page may run. extension/app/cdn.js pins the same versions for the page side.
const VENDORED = [
  { name: 'sql.js', version: '1.13.0' },
  { name: 'marked', version: '18.0.7' },
  { name: 'dompurify', version: '3.4.12' },
  // Explore's charts — a classic script (dist/echarts.min.js), not a +esm closure.
  { name: 'echarts', version: '5.5.1' },
];

// GitHub repositories at a commit, by the files of each the page imports. dax-sql is the
// DAX-to-SQL compiler behind semantic models; its modules import each other by relative
// path, so they resolve beside each other under the /cdn route and need no /gh/ root route.
const VENDORED_GH = [
  { repo: 'djouallah/dax-sql@8683334f4e2a82d32630db2e382dd2c54ce0a8f1',
    include: /^\/(src\/.*\.js|formats\/tmsl\.js)$/ },
];

// `/npm/<name>@<version>/` — the path prefix every file of a vendored package lives under.
const VENDORED_PREFIXES = VENDORED.map(p => `/npm/${p.name}@${p.version}/`);
// `/gh/<owner>/<repo>@<sha>/` — the same for a pinned repository.
const VENDORED_GH_PREFIXES = VENDORED_GH.map(g => `/gh/${g.repo}/`);

module.exports = { VENDORED, VENDORED_PREFIXES, VENDORED_GH, VENDORED_GH_PREFIXES };
