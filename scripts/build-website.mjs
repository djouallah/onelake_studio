// Builds the public website into .tmp/site: website/ as it is, the icon and the screenshot copied
// in so neither is stored twice, and docs/*.md rendered to docs/*.html so the markdown stays the
// only copy. A broken link or anchor in a doc fails the build, so it never deploys.
//
// marked is installed by .github/workflows/pages.yml, not package.json: nothing else needs it.
// Run: node scripts/build-website.mjs
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, ".tmp", "site");
const GITHUB = "https://github.com/djouallah/onelake_studio";

const DOCS = [
  { md: "README.md", page: "index.html", title: "Overview" },
  { md: "NAMING.md", page: "naming.html", title: "Naming" },
  { md: "ARCHITECTURE.md", page: "architecture.html", title: "Architecture" },
  { md: "CATALOG.md", page: "catalog.html", title: "Catalog" },
  { md: "CHANGELOG.md", page: "changelog.html", title: "Changelog" },
];

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const plainText = html => html.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, m => ENTITIES[m]);
const escapeHtml = text => text.replace(/[&<>"]/g, c => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

// GitHub's rule, so a doc's anchors work the same here and there.
const slug = text => text.toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

// A link between docs becomes a link between pages; a link into the code goes to the code on GitHub.
function rewrite(href, doc, broken) {
  if (/^[a-z]+:/i.test(href)) return href;
  const [path, anchor] = href.split("#");
  if (!path) {
    doc.links.push({ page: doc.page, anchor });
    return href;
  }
  const target = DOCS.find(d => d.md === path);
  if (target) {
    doc.links.push({ page: target.page, anchor });
    return target.page + (anchor ? `#${anchor}` : "");
  }
  const inRepo = posix.normalize(posix.join("docs", path));
  if (inRepo.startsWith("..") || !existsSync(join(ROOT, inRepo))) {
    broken.push(`${doc.md}: ${href}`);
    return href;
  }
  const kind = path.endsWith("/") ? "tree" : "blob";
  return `${GITHUB}/${kind}/main/${inRepo}${anchor ? `#${anchor}` : ""}`;
}

function render(doc, source, broken) {
  doc.links = [];
  doc.anchors = new Set();
  doc.sections = [];
  const seen = new Map();
  const marked = new Marked({
    gfm: true,
    walkTokens(token) {
      if (token.type === "link") token.href = rewrite(token.href, doc, broken);
    },
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        const text = plainText(html);
        const base = slug(text);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        const id = count ? `${base}-${count}` : base;
        doc.anchors.add(id);
        if (depth === 2) doc.sections.push({ id, text });
        return `<h${depth} id="${id}">${html}</h${depth}>\n`;
      },
    },
  });
  doc.html = marked.parse(source);
}

function page(doc) {
  const docLinks = DOCS.map(d =>
    `<a href="${d.page}"${d === doc ? ' aria-current="page"' : ""}>${d.title}</a>`).join("\n          ");
  const sections = doc.sections.map(s =>
    `<a href="#${s.id}">${escapeHtml(s.text)}</a>`).join("\n          ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${doc.title}: OneLake Studio docs</title>
  <link rel="icon" href="../icon.png">
  <link rel="stylesheet" href="../style.css">
</head>
<body>
  <header class="site-header">
    <div class="wrap">
      <a class="brand" href="../"><img src="../icon.png" alt="" width="28" height="28">OneLake Studio</a>
      <nav class="site-nav" aria-label="Main">
        <a href="../how-it-works.html">How it works</a>
        <a href="./" aria-current="page">Docs</a>
        <a href="${GITHUB}">GitHub</a>
      </nav>
    </div>
  </header>

  <div class="wrap wide doc-layout">
    <aside class="doc-side">
      <nav class="doc-nav" aria-label="Docs">
          ${docLinks}
      </nav>
      ${sections ? `<nav class="doc-sections" aria-label="On this page">
          ${sections}
      </nav>` : ""}
    </aside>
    <main class="doc">
${doc.html}
    </main>
  </div>

  <footer class="site-footer">
    <div class="wrap">
      <p>A personal project, not a Microsoft product or supported by Microsoft. Results computed from a semantic model aren't guaranteed to match Power BI. MIT License.</p>
    </div>
  </footer>
</body>
</html>
`;
}

const broken = [];
for (const doc of DOCS) render(doc, await readFile(join(ROOT, "docs", doc.md), "utf8"), broken);
for (const doc of DOCS) {
  for (const { page: target, anchor } of doc.links) {
    const to = DOCS.find(d => d.page === target);
    if (anchor && !to.anchors.has(anchor)) broken.push(`${doc.md}: ${to.md}#${anchor}`);
  }
}
if (broken.length) {
  console.error(`Broken links in docs/:\n  ${broken.join("\n  ")}`);
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
await cp(join(ROOT, "website"), OUT, { recursive: true });
await cp(join(ROOT, "media", "icon.png"), join(OUT, "icon.png"));
await cp(join(ROOT, "docs", "summary.png"), join(OUT, "summary.png"));
await mkdir(join(OUT, "docs"), { recursive: true });
for (const doc of DOCS) await writeFile(join(OUT, "docs", doc.page), page(doc));
console.log(`Built ${DOCS.length} docs into ${OUT}`);
