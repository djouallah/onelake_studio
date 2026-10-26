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
    getToken: async () => "test-token", siteFsPath: APP, dfsOrigin, tableOrigin, backoffMs: [],
  });
  const onelake = createOneLake({ catalog, store: createStore({ dir: null }), prefetchEnabled: () => false });
  const statuses = [];
  const methods = createHostMethods({ onelake, engine, onStatus: m => statuses.push(m) });

  // window.__hostCall(msg) answers one engine-call: batches are posted into the page as
  // they come, and the closing result (or error) is what the call resolves to.
  async function install(page) {
    await page.exposeBinding("__hostCall", async ({ page: p }, msg) => {
      let last = null;
      await answer({ methods, engine }, msg, m => {
        if (m.type === "engine-batch") p.evaluate(x => window.postMessage(x, "*"), m).catch(() => {});
        else last = m;
      });
      return last;
    });
  }

  return { engine, methods, statuses, install, close: () => engine.close() };
}
