# OneLake Studio — web app

Read-only SQL over your own OneLake, running entirely in your browser. The SQL editor works the moment
the page loads — no account needed (DuckDB with the h3 spatial extension, fully local). Sign in with
your Microsoft work or school account to browse OneLake: pick a workspace and a lakehouse or warehouse,
and query its tables and files.

- **Fully local.** DuckDB-WASM runs in the tab. No backend, nothing uploaded, nothing copied.
- **Your identity, your data.** One delegated permission — Azure Storage `user_impersonation` — so you
  see exactly what you already have access to.
- **Read-only.** `SELECT` / `WITH` / `DESCRIBE` / `SHOW` / `EXPLAIN` / `SUMMARIZE`, nothing else.
- **No analytics, no telemetry.** Your token stays in this browser and goes only to Microsoft.

## Signing in

Signing in is only needed to reach OneLake — the editor and engine run without it.

The website signs in through an Entra app registration in **your own tenant**.
Create one, paste its two GUIDs into the sign-in screen, and this browser remembers them — a one-off.
They also go in the URL — and the page asks before using a registration a link proposes, because whoever
owns a registration decides what your sign-in may be used for:

```
https://studio.projectscontrols.com/?clientId=<application-id>&tenantId=<directory-id>
```

The registration needs exactly two things:

- Platform **Single-page application**, with the address you serve the app from as the redirect URI —
  `https://studio.projectscontrols.com/` for the demo, `http://localhost:5173/` for `npm run dev`, your
  own URL for your own copy. Entra matches it exactly, trailing slash included, and one registration can
  list several. The platform type matters: a *Web* entry fails with `AADSTS9002326`.
- API permission **Azure Storage → Delegated → `user_impersonation`**.

Nothing else: no client secret (SPA + PKCE doesn't use one), no Graph, no directory access, no
application permissions. Every read carries your own token, so the app reaches only what you can already
open, and it never writes.

With the Azure CLI, both GUIDs in one go — swap the redirect URIs for wherever you serve the app:

```bash
az rest --method POST --uri https://graph.microsoft.com/v1.0/applications \
  --headers "Content-Type=application/json" \
  --body '{
    "displayName": "OneLake Studio",
    "signInAudience": "AzureADMyOrg",
    "spa": { "redirectUris": ["https://studio.projectscontrols.com/", "http://localhost:5173/"] },
    "requiredResourceAccess": [{
      "resourceAppId": "e406a681-f3d4-42a8-90b6-c2b029497af1",
      "resourceAccess": [{ "id": "03e0da56-190b-40ad-a80c-ea378c433f7f", "type": "Scope" }]
    }]
  }' --query appId -o tsv                 # clientId
az account show --query tenantId -o tsv   # tenantId
```

`e406a681-…` is the Azure Storage resource and `03e0da56-…` its `user_impersonation` scope — the same
two constants in every tenant. This goes through Graph rather than `az ad app create` because that
command can only write `web` and `publicClient` redirect URIs; a `web` entry is the `AADSTS9002326`
case above, and `spa` is the one that works.

Whether that first sign-in is one click or waits on an approval is your tenant's consent policy, not this
app. A registration in your own directory isn't what the strict policy blocks, but a tenant can still
require admin consent for everything — an admin then grants it once from the registration's
*API permissions* page.

## Run it yourself

```bash
cd web
npm install
npm run dev        # serves app/ on http://localhost:5173 — add that as a redirect URI to sign in
npm test           # node --test over the engine's pure logic (paths, SQL guard, cache keys)
```

No bundler — DuckDB-WASM and MSAL come from a CDN, and `npm run build` copies `app/` → `dist/` and
stamps the commit into `version.js` (shown bottom-right in the app, so a cached build identifies itself).
[`.github/workflows/pages.yml`](https://github.com/djouallah/onelake_studio/blob/main/.github/workflows/pages.yml) runs the tests and deploys to GitHub Pages
on every push. [`test/sql-integration.html`](https://github.com/djouallah/onelake_studio/blob/main/web/test/sql-integration.html) is a manual harness that runs the
engine's generated SQL against real DuckDB-WASM — copy it into `app/`, `npm run dev`, and open it.

To host your own copy: fork it, register an SPA app with **your** URL as the redirect URI, and set
*Settings → Pages → Source: GitHub Actions*. Users can name that registration on the sign-in screen; an
internal deploy can skip the asking by putting its `clientId` — and a tenant GUID in `authority` to pin
it — in [`app/config.js`](https://github.com/djouallah/onelake_studio/blob/main/web/app/config.js), which ships empty here.

**Don't serve it from `*.github.io`.** Measured, not theoretical: Windows Enhanced Phishing Protection
blocked the `github.io` URL outright — that feature watches for Microsoft credential entry on
non-Microsoft sites, and `github.io` is a shared domain with a long phishing history. Use a hostname on a
domain you control ([`app/CNAME`](https://github.com/djouallah/onelake_studio/blob/main/web/app/CNAME) plus a DNS CNAME to `<user>.github.io`), ideally an
established one — a brand-new domain has no reputation either.

How it reads a table, semantic models and limitations: [ARCHITECTURE.md](https://github.com/djouallah/onelake_studio/blob/main/web/ARCHITECTURE.md).

> A personal learning project — not a Microsoft product or supported by Microsoft, and DAX compiled
> to SQL here is not guaranteed to match Power BI.
