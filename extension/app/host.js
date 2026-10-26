// =============================================================================
// host.js — the page's one channel to the extension host
// =============================================================================
// Everything the page needs from outside itself is a `call`: a DuckDB statement or a
// OneLake read, answered by extension/src/host.js. Results are plain JSON — columns as
// { name, type } with DuckDB's own type names, rows as objects — so nothing here pretends
// to be a database driver.
//
//   call(method, args, onBatch?)   -> Promise of the call's value; a streamed call hands
//                                     each batch ({ fields, rows, numRows }) to onBatch
//
// A failure rejects with the host's message; `e.cancelled` says it was a Stop, not an error.
// =============================================================================

import { vscodeApi } from "./vscode-api.js";

let seq = 0;
let channel = null;

export function connectHost() {
  if (channel) return channel;
  const vs = vscodeApi();
  const pending = new Map();   // id -> { resolve, reject, onBatch }

  window.addEventListener("message", ev => {
    const m = ev && ev.data;
    if (!m || typeof m.id !== "number") return;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === "batch") { p.onBatch(m.batch); return; }
    if (m.type === "result") { pending.delete(m.id); p.resolve(m.value); return; }
    if (m.type === "error") {
      pending.delete(m.id);
      const e = new Error(m.message || "the host call failed");
      if (m.cancelled) e.cancelled = true;
      p.reject(e);
    }
  });

  function call(method, args = [], onBatch = () => {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onBatch });
      vs.postMessage({ type: "call", id, method, args });
    });
  }

  channel = { call };
  return channel;
}
