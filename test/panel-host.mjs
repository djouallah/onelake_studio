// The extension host the panel talks to, minus VS Code: a real native engine-host and the
// real host methods (extension/src/host.js) over a real catalog and store, pointed at
// whatever fake OneLake the harness serves. The browser harnesses install it on a page
// in place of the webview's bridge, so the page under test is answered by the same code
// panel.js answers it with.
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createEngineHost } = require("../extension/src/engine-host.js");
const { createCatalog } = require("../extension/src/catalog.js");
const { createStore } = require("../extension/src/store.js");
const { createOneLake } = require("../extension/src/onelake.js");
const { createHostMethods, answer } = require("../extension/src/host.js");

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const APP = join(root, "extension", "app");

// The landing query reads this, by path, as the packaged panel does (panel.js readmeUrl).
export const README = join(root, "README.md");

export function panelHost({ dfsOrigin, tableOrigin, engineOptions = {} } = {}) {
  const engine = createEngineHost({ allowedPaths: [README], ...engineOptions });
  const catalog = createCatalog({
    getToken: async () => "test-token", dfsOrigin, tableOrigin, backoffMs: [],
  });
  const onelake = createOneLake({ catalog, store: createStore({ dir: null }), prefetchEnabled: () => false });
  const statuses = [];
  const methods = createHostMethods({ onelake, engine, onStatus: m => statuses.push(m) });

  // window.__hostCall(msg) answers one `call`: batches are posted into the page as
  // they come, and the closing result (or error) is what the call resolves to.
  async function install(page) {
    await page.exposeBinding("__hostCall", async ({ page: p }, msg) => {
      let last = null;
      await answer({ methods, engine }, msg, m => {
        if (m.type === "batch") p.evaluate(x => window.postMessage(x, "*"), m).catch(() => {});
        else last = m;
      });
      return last;
    });
  }

  return { engine, methods, statuses, install, close: () => engine.close() };
}

// ---------------------------------------------------------------------------
// The page, as panel.js renders it: the real template, the panel's CSP shape, and a
// config pointing at this harness's own server for the page and the vendored libraries.
// ---------------------------------------------------------------------------
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
const { renderPage } = require("../extension/src/html.js");
const { PINS } = require("../extension/src/vendored.js");

const VENDOR = join(root, "extension", "vendor");
const MIME = { ".js": "text/javascript; charset=utf-8", ".html": "text/html; charset=utf-8",
               ".css": "text/css", ".json": "application/json", ".md": "text/markdown" };

export async function panelPage(origin, { nonce = "harness", config = {} } = {}) {
  const csp = [
    `default-src 'none'`, `img-src ${origin} data: blob:`, `font-src ${origin}`,
    `style-src ${origin} 'unsafe-inline'`, `script-src ${origin} 'nonce-${nonce}'`,
    `connect-src ${origin}`, `base-uri 'none'`, `form-action 'none'`,
  ].join("; ");
  return renderPage(await readFile(join(APP, "index.html"), "utf8"), {
    base: `${origin}/app`, nonce, csp,
    config: { vendorBase: `${origin}/vendor`, pins: PINS, readmeUrl: README,
              build: { version: "test", commit: "harness" }, ...config },
  });
}

// Serves "/" (the rendered page), /app/* and /vendor/*. Returns false for anything else,
// so the harness can answer it (its fake OneLake).
export async function servePanel(req, res, origin, opts) {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = null;
  if (path === "/") {
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(await panelPage(origin, opts));
    return true;
  }
  if (path.startsWith("/app/")) file = join(APP, ...path.slice(5).split("/"));
  else if (path.startsWith("/vendor/")) file = join(VENDOR, ...path.slice(8).split("/"));
  if (!file) return false;
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
  return true;
}
