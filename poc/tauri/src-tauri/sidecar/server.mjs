// The app's Node process: DuckDB, node:sqlite and the sign-in. One line of JSON in, one line out.
// Nothing here prints a token: a probe reports only what the token says about itself.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { DuckDBInstance } from '@duckdb/node-api';
import { PublicClientApplication } from '@azure/msal-node';

// The public client Microsoft's own ADOMD library signs in with. No app registration is ours.
const CLIENT_ID = 'cf710c6e-dfcc-4fa8-a093-d47294e44c66';
const AUTHORITY = 'https://login.microsoftonline.com/organizations';

const ONELAKE = 'https://storage.azure.com/.default';
const POWERBI = 'https://analysis.windows.net/powerbi/api/.default';
const FABRIC = 'https://api.fabric.microsoft.com/.default';

const FABRIC_WORKSPACES = 'https://api.fabric.microsoft.com/v1/workspaces';

// What the extension needs: OneLake's listing, and both ways it reaches the Fabric API.
const PROBES = [
  { name: 'OneLake workspaces', scope: ONELAKE, url: 'https://onelake.dfs.fabric.microsoft.com/?resource=account' },
  { name: 'Fabric API, Fabric token', scope: FABRIC, url: FABRIC_WORKSPACES },
  { name: 'Fabric API, Power BI token', scope: POWERBI, url: FABRIC_WORKSPACES },
  { name: 'Power BI API, Power BI token', scope: POWERBI, url: 'https://api.powerbi.com/v1.0/myorg/groups?$top=5' },
];

let duck = null;
const connection = async () => {
  if (!duck) duck = await (await DuckDBInstance.create(':memory:')).connect();
  return duck;
};

async function brokerPlugin() {
  const { NativeBrokerPlugin } = await import('@azure/msal-node-extensions');
  return new NativeBrokerPlugin();
}

async function engine() {
  const started = performance.now();
  const conn = await connection();
  const [{ version }] = (await conn.runAndReadAll('SELECT version() AS version')).getRowObjectsJson();
  const sqlite = new DatabaseSync(':memory:').prepare('SELECT sqlite_version() AS v').get().v;
  const broker = await brokerPlugin().then(p => p.isBrokerAvailable, e => `failed: ${e.message}`);
  return {
    ok: true,
    duckdb: version,
    sqlite,
    node: process.version,
    broker,
    engineMs: Math.round(performance.now() - started),
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
  };
}

async function sql({ sql }) {
  const reader = await (await connection()).runAndReadAll(sql);
  return { ok: true, rows: reader.getRowObjectsJson().slice(0, 1000) };
}

const openBrowser = async url => {
  spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
};

const failure = e => e.errorMessage || e.message || String(e);

// What a token says about itself: its header and signature stay out of it.
function claims(accessToken) {
  const { aud, scp, tid } = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
  return { aud, scp, tid };
}

function countOf(body) {
  try {
    const json = JSON.parse(body);
    return (json.fileSystems || json.value || []).length;
  } catch { return null; }
}

async function probe(pca, account, interactive, { name, scope, url }) {
  let token;
  try {
    token = await pca.acquireTokenSilent({ scopes: [scope], account })
      .catch(() => pca.acquireTokenInteractive({ scopes: [scope], loginHint: account.username, ...interactive }));
  } catch (e) {
    return { name, token: 'refused', error: failure(e) };
  }
  const answer = { name, token: 'granted', ...claims(token.accessToken) };
  try {
    const r = await fetch(url, { headers: { authorization: `Bearer ${token.accessToken}` } });
    const body = await r.text();
    return { ...answer, status: r.status, count: r.ok ? countOf(body) : undefined, body: r.ok ? undefined : body.slice(0, 300) };
  } catch (e) {
    return { ...answer, error: e.message };
  }
}

async function signIn({ mode, hwnd }) {
  const broker = mode === 'broker';
  const pca = new PublicClientApplication({
    auth: { clientId: CLIENT_ID, authority: AUTHORITY },
    ...(broker ? { broker: { nativeBrokerPlugin: await brokerPlugin() } } : {}),
  });
  const handle = Buffer.alloc(8);
  handle.writeBigInt64LE(BigInt(hwnd));
  const interactive = broker ? { windowHandle: handle } : { openBrowser };
  const first = await pca.acquireTokenInteractive({ scopes: [ONELAKE], ...interactive });
  const probes = [];
  for (const p of PROBES) probes.push(await probe(pca, first.account, interactive, p));
  return { ok: true, mode, account: first.account.username, probes };
}

const METHODS = { engine, sql, signIn };

for await (const line of createInterface({ input: process.stdin })) {
  let answer;
  try {
    const request = JSON.parse(line);
    answer = await METHODS[request.method](request);
  } catch (e) {
    answer = { ok: false, error: failure(e) };
  }
  process.stdout.write(`${JSON.stringify(answer)}\n`);
}
process.exit(0);
