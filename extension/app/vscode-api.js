// acquireVsCodeApi() may be called exactly ONCE per webview — a second call throws, and
// the handle cannot be recovered afterwards. Two things need it now (app.js for the tree
// bridge, data.js for the native engine), so it is acquired here and shared.
//
// Outside a webview — the browser build, and every headless test that drives the page
// directly — there is no such function, and a no-op postMessage keeps those paths running
// without a `typeof` guard at each call site.
let api = null;

export function vscodeApi() {
  if (!api) {
    api = typeof acquireVsCodeApi === "function"
      ? acquireVsCodeApi()
      : { postMessage() {} };
  }
  return api;
}

export const inWebview = () => typeof acquireVsCodeApi === "function";
