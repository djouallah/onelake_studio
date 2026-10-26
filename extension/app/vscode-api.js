// acquireVsCodeApi() may be called exactly ONCE per webview — a second call throws, and
// the handle cannot be recovered afterwards. Two things need it (app.js and the host
// channel, host.js), so it is acquired here and shared.
let api = null;

export function vscodeApi() {
  if (!api) api = acquireVsCodeApi();
  return api;
}
