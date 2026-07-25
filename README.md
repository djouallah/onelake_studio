# OneLake Iceberg Viewer

A **serverless, in-browser** tool to run read-only SQL against **any Apache Iceberg table in OneLake**.
You type a lakehouse path — `workspace/lakehouse.Lakehouse` — the app lists that lakehouse's Iceberg
tables, lets you **preview** any of them, and run **DuckDB SQL** directly in your browser. No backend,
no data copied to a server, and **no Entra app registration** when deployed to Microsoft Fabric via Rayfin.

It's built by generalizing two references:
- [rayfin-duckdb-wasm](https://github.com/djouallah/rayfin-duckdb-wasm) — Rayfin static hosting on Fabric, DuckDB-WASM, config-injected MSAL auth.
- [dbt_fabric_python_iceberg dashboard](https://github.com/djouallah/dbt_fabric_python_iceberg/blob/main/dashboard/index.html) — reading Iceberg (`read_avro` manifests → `read_parquet` data files) in DuckDB-WASM.

## How it works

```
type: workspace/lakehouse.Lakehouse
   │  (OneLake storage token from your Entra identity)
   ▼
list tables   → DFS list of Tables/  (finds folders with a metadata/ dir = Iceberg)
select table  → resolve current metadata.json → snapshot → manifest-list (Avro)
              → read manifests with read_avro → parquet data-file paths
              → fetch each parquet (Bearer token) → register in DuckDB
              → CREATE VIEW "schema"."table" AS read_parquet([...])
preview/query → read-only SQL in your browser → results table + CSV export
```

Everything runs client-side. Data files are fetched with your token and read by DuckDB-WASM; the table
size you can query is bounded by your browser's memory.

## Deploy to Fabric (Rayfin)

No app registration needed — Rayfin's managed auth (`services.auth.fabric.enabled` in
[`rayfin/rayfin.yml`](rayfin/rayfin.yml)) provisions the Entra app and injects `clientId`/`tenantId`
into `window.RAYFIN_WASM_CONFIG` at serve time; you sign in with your own Entra identity and get a
OneLake (`storage.azure.com`) token.

```bash
npm install
npx rayfin up
```

After the first deploy, copy the printed webapp URL into `allowedRedirectUris` in `rayfin/rayfin.yml`
and run `npx rayfin up` again.

> **Open it standalone, not inside the Fabric portal iframe.** The Microsoft sign-in is blocked in the
> embedded frame; the app detects this and shows an "Open in new tab" prompt.

## Local development

There's no Rayfin host on `localhost` to inject config, so register a throwaway Entra **SPA** app
(public client) with redirect URI `http://localhost:5173` and the delegated permission
**Azure Storage → user_impersonation**, then:

```bash
cp site/config.example.js site/config.js   # fill in clientId + tenantId
# serve the site/ folder over http://localhost:5173 with any static server, e.g.
npx serve site -l 5173
```

`site/config.js` is gitignored.

## Usage

1. Sign in.
2. Type a lakehouse path, e.g. `Sales/Analytics.Lakehouse`, and press **Connect**.
3. Pick a table in the sidebar → it loads and auto-previews (`SELECT * … LIMIT 100`).
4. Edit the SQL and press **Run** (or `Ctrl/Cmd+Enter`). Loaded tables can be joined together.
5. **Download CSV** exports the current result.

## Notes & limitations

- **Iceberg only.** Delta tables are listed but greyed out (not queryable here yet).
- **Read-only.** Only `SELECT` / `WITH` / `DESCRIBE` / `SHOW` / `EXPLAIN` / `SUMMARIZE` are allowed; there is no write path to OneLake.
- **Whole data files are downloaded** for a loaded table (no snapshot pruning). Very large tables may exceed browser memory.
- **Copy-on-write** Iceberg tables work directly; merge-on-read *delete files* are not applied.
- The target folder must be a real Iceberg table (has a `Tables/…/metadata/` directory).

## Project layout

```
site/
  index.html            UI shell (lakehouse bar, table sidebar, SQL editor, results)
  app.js                DOM wiring + auth gate
  auth.js               MSAL provider (config-injected, storage scope, redirect flow)
  data.js               Iceberg engine on DuckDB-WASM (list/resolve/manifest/load/query)
  coi-serviceworker.js  COOP/COEP shim for DuckDB multithreading
  config.example.js     local-dev config template (copy to config.js)
build.mjs               static build: copies site/ -> dist/
rayfin/rayfin.yml       Rayfin service config (managed Fabric auth + static hosting)
```
