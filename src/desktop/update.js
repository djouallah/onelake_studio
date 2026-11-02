'use strict';
// =============================================================================
// update.js — is there a newer OneLake Studio than this one?
// =============================================================================
// The website's Download button is the latest release's installer, and that release's tag names its
// version: ext-v0.2.11. The app only says so; it downloads and installs nothing.
// =============================================================================

const RELEASES = 'https://api.github.com/repos/djouallah/onelake_studio/releases/latest';
const DOWNLOAD = 'https://github.com/djouallah/onelake_studio/releases/latest/download/OneLake-Studio-Setup.exe';

/** Is version a (0.2.11) newer than b (0.2.10)? */
function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** The latest release's version, from its tag. */
async function latestVersion(fetchImpl = fetch) {
  const r = await fetchImpl(RELEASES, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OneLake-Studio' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  const tag = String((await r.json()).tag_name || '');
  if (!/^ext-v\d+(\.\d+)*$/.test(tag)) throw new Error(`the latest release is ${tag || 'unnamed'}`);
  return tag.slice('ext-v'.length);
}

/** What Help › Check for Updates says, and what the status bar is told at start. */
async function checkUpdate(version, fetchImpl = fetch) {
  const latest = await latestVersion(fetchImpl);
  return { version, latest, newer: newer(latest, version), download: DOWNLOAD };
}

module.exports = { newer, latestVersion, checkUpdate, DOWNLOAD };
