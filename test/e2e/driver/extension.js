'use strict';
// The test's way into the extension host: a command run and waited for, and what only the host can
// say (is the extension active, what do the tabs say). It asks for nothing OneLake Studio doesn't
// offer a user, and is never shipped: this folder is under test/, which .vscodeignore keeps out.
const http = require('node:http');
const vscode = require('vscode');

const STUDIO = 'djouallah.onelake-studio';

const ops = {
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
