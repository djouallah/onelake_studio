'use strict';
// =============================================================================
// theme.js — the colours a tab's page and the window draw with
// =============================================================================
// The page (page/index.html) is written against VS Code's theme variables, so the app defines those
// names rather than the page having two ways of asking. Dark, whatever Windows is set to.
// =============================================================================

const SHARED = {
  'font-family': "'Segoe UI', system-ui, sans-serif",
  'font-size': '13px',
  'editor-font-family': "Consolas, 'Courier New', monospace",
  'editor-font-size': '14px',
  'charts-blue': '#3794ff', 'charts-green': '#89d185', 'charts-yellow': '#cca700', 'charts-orange': '#d18616', 'charts-red': '#f14c4c',
};

const DARK = {
  foreground: '#cccccc', descriptionForeground: '#9d9d9d', disabledForeground: '#6e6e6e', errorForeground: '#f85149',
  focusBorder: '#0078d4', contrastBorder: 'transparent', 'widget-shadow': 'rgba(0,0,0,.36)',
  'editor-background': '#1f1f1f', 'editorWidget-background': '#202020', 'editorWidget-border': '#454545',
  'editorGroupHeader-tabsBackground': '#181818', 'editorWarning-foreground': '#cca700',
  'sideBar-background': '#181818', 'panel-border': '#2b2b2b', 'menu-background': '#1f1f1f',
  'input-background': '#313131', 'input-foreground': '#cccccc', 'input-border': '#3c3c3c',
  'dropdown-background': '#313131', 'dropdown-foreground': '#cccccc', 'dropdown-border': '#3c3c3c',
  'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1', 'button-border': 'rgba(255,255,255,.07)',
  'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc', 'button-secondaryHoverBackground': '#3c3c3c',
  'list-activeSelectionBackground': '#04395e', 'list-activeSelectionForeground': '#ffffff', 'list-hoverBackground': '#2a2d2e',
  'keybindingTable-headerBackground': 'rgba(204,204,204,.04)', 'tree-tableOddRowsBackground': 'rgba(204,204,204,.04)',
  'testing-iconPassed': '#73c991', 'textCodeBlock-background': '#2b2b2b', 'textLink-foreground': '#4daafc',
  'debugTokenExpression-name': '#c586c0', 'debugTokenExpression-string': '#ce9178', 'debugTokenExpression-number': '#b5cea8', 'debugTokenExpression-boolean': '#4e94ce',
  'list-warningForeground': '#cca700', 'list-errorForeground': '#f88070', 'statusBar-background': '#181818', 'statusBar-foreground': '#cccccc',
};

function themeCss() {
  const all = { ...SHARED, ...DARK };
  const vars = Object.entries(all).map(([k, v]) => `--vscode-${k}: ${v};`).join(' ');
  return `:root { color-scheme: dark; ${vars} }`;
}

// What VS Code puts in every webview, which the page was written on top of.
const PAGE_DEFAULTS = `body { background: transparent; color: var(--vscode-foreground); font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size); margin: 0; padding: 0 20px; }
a { color: var(--vscode-textLink-foreground); }
code { font-family: var(--vscode-editor-font-family); }`;

module.exports = { themeCss, PAGE_DEFAULTS };
