'use strict';
// Lint for mistakes, not for style: a name that is nothing, a key written twice, code no path reaches.
// Nothing here formats, and no rule is about how code looks. CI's `lint` job runs it (extension.yml),
// with ESLint installed beside the tree: `globals` is found through NODE_PATH, which only a CommonJS
// config reads, so this file is .cjs.
const globals = require('globals');

const rules = {
  'no-undef': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-async-promise-executor': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-constant-binary-expression': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-const-assign': 'error',
  'no-import-assign': 'error',
  'no-func-assign': 'error',
  'no-obj-calls': 'error',
  'no-setter-return': 'error',
  'no-sparse-arrays': 'error',
  'no-compare-neg-zero': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-loss-of-precision': 'error',
  'no-unused-private-class-members': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'getter-return': 'error',
  'for-direction': 'error',
  // A name nothing reads is often a result that was meant to be used. An argument or a caught error
  // left unread is not that.
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
};

const node = { ...globals.node };
const browser = { ...globals.browser, acquireVsCodeApi: 'readonly' };

module.exports = [
  // Built or fetched, not written here; the Fabric function is TypeScript, which its own tsc reads.
  { ignores: ['node_modules/**', 'dist/**', 'vendor/**', 'webview/**', 'duckdb-extensions/**', 'fabric-function/**',
              'fabric_app/rayfin/**', 'desktop/src-tauri/**', 'website/**', 'blog/**', '.tmp/**', '.claude/**',
              'test/fixtures/**', 'test/e2e/driver/**'] },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  // The host: CommonJS on Node.
  { files: ['core/**/*.js', 'extension/**/*.js', 'cli/**/*.js', 'xmla/**/*.js', 'desktop/node/**/*.js', 'fabric_app/export/**/*.js',
            '*.cjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: node }, rules },
  // Scripts, tests and the command line: modules on Node. A test's page-side code names the browser's too.
  { files: ['scripts/**/*.mjs', 'cli/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...node, ...browser } }, rules },
  // A tab's page, the desktop window and the Fabric app's site: modules in a browser. The command line
  // loads two of the page's files as well, so Node's names are known there.
  { files: ['page/**/*.js', 'desktop/ui/**/*.js', 'fabric_app/site/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...browser, ...node } }, rules },
];
