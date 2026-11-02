// A key as the window's shortcuts name it: "ctrl+shift+tab", "ctrl+=", "f5". And the browser's own keys,
// which do nothing here: in a window of tabs, F5 would reload all of them away, Ctrl+P would print the
// page, Ctrl+F would open a browser's find bar.

export function chordOf(e) {
  const key = e.key === ' ' ? 'space' : String(e.key || '').toLowerCase();
  return [e.ctrlKey && 'ctrl', e.shiftKey && 'shift', e.altKey && 'alt', key].filter(Boolean).join('+');
}

export const BROWSER_KEYS = new Set([
  'f5', 'ctrl+f5', 'shift+f5', 'ctrl+r', 'ctrl+shift+r', 'browserrefresh',
  'alt+arrowleft', 'alt+arrowright', 'browserback', 'browserforward',
  'ctrl+p', 'ctrl+shift+p', 'ctrl+s', 'ctrl+u', 'ctrl+o',
  'ctrl+f', 'ctrl+g', 'ctrl+shift+g', 'f3', 'shift+f3', 'f7',
  'ctrl+h', 'ctrl+j', 'ctrl+shift+i', 'ctrl+shift+j', 'f12',
]);
