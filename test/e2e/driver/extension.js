'use strict';
// The test's way into the extension host: a command run and waited for, a query's text set, and
// what only the host can say (diagnostics, tabs). It asks for nothing OneLake Studio doesn't offer
// a user, and is never shipped: this folder is under test/, which .vscodeignore keeps out.
const http = require('node:http');
const vscode = require('vscode');

const STUDIO = 'djouallah.onelake-studio';
const isQuery = doc => /[\\/]OneLakeStudio[\\/]queries[\\/]/i.test(doc.uri.path);

// The query being driven: the last one opened or shown here. The panel can have the focus, and
// then VS Code has no active text editor.
let current = null;

// In the group that holds it, as a click on its tab does: the panel's group can be the active one.
async function focus() {
  if (!current) throw new Error('no query is open');
  const uri = current.uri.toString();
  const group = vscode.window.tabGroups.all.find(g => g.tabs.some(t => t.input && t.input.uri && t.input.uri.toString() === uri));
  return vscode.window.showTextDocument(current, { preview: false, preserveFocus: false, viewColumn: group && group.viewColumn });
}

async function setText({ text, cursor = null, selection = null }) {
  const editor = await focus();
  const doc = editor.document;
  await editor.edit(b => b.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text));
  const pos = n => doc.positionAt(n);
  editor.selection = selection ? new vscode.Selection(pos(selection[0]), pos(selection[1]))
    : new vscode.Selection(pos(cursor ?? 0), pos(cursor ?? 0));
  return { uri: doc.uri.toString() };
}

const ops = {
  // The command's own promise is the answer: a query's command settles when the panel has answered.
  async exec({ command, args = [], timeoutMs = 60000 }) {
    const t0 = Date.now();
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    const settled = await Promise.race([
      vscode.commands.executeCommand(command, ...args).then(() => 'settled', e => `threw: ${e && e.message}`),
      late,
    ]);
    clearTimeout(timer);
    return { settled, ms: Date.now() - t0 };
  },
  async newQuery() {
    await vscode.commands.executeCommand('onelakeStudio.newQuery');
    current = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
    if (!current || !isQuery(current)) throw new Error('New Query opened no query');
    return { uri: current.uri.toString() };
  },
  async openFile({ path }) {
    current = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
    await focus();
    return { uri: current.uri.toString() };
  },
  async show({ uri }) {
    current = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri);
    await focus();
    return {};
  },
  setText,
  diagnostics() {
    if (!current) return [];
    return vscode.languages.getDiagnostics(current.uri).map(d => ({ line: d.range.start.line, character: d.range.start.character, message: d.message }));
  },
  state() {
    const ext = vscode.extensions.getExtension(STUDIO);
    return {
      installed: !!ext,
      active: !!(ext && ext.isActive),
      tabs: vscode.window.tabGroups.all.flatMap(g => g.tabs).map(t => t.label),
    };
  },
};

function activate(context) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { op, ...args } = JSON.parse(body);
        const answer = await ops[op](args);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer ?? null));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (e && e.message) || String(e) }));
      }
    });
  });
  server.listen(Number(process.env.E2E_DRIVER_PORT), '127.0.0.1');
  context.subscriptions.push({ dispose: () => server.close() });
}

module.exports = { activate };
