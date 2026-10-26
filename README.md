# OneLake Studio

> A personal learning project — not a Microsoft product or supported by Microsoft, and DAX compiled
> to SQL here is not guaranteed to match Power BI.

Browse Microsoft Fabric OneLake and query it with DuckDB — read only, signed in as yourself.

This repository holds separate front ends for that idea. They share **no code**: each folder is a
self-contained app with its own dependencies, tests, docs and CI.

| Folder | App | Engine | Get it |
| --- | --- | --- | --- |
| [`vscode/`](vscode/) | VS Code extension | native DuckDB in the extension host | [Marketplace](https://marketplace.visualstudio.com/items?itemName=djouallah.onelake-studio) |
| [`web/`](web/) | Web app | DuckDB-WASM in the browser tab | [studio.projectscontrols.com](https://studio.projectscontrols.com/), or host your own |

A Microsoft Fabric app may follow as `fabric/`.

MIT licensed — see [LICENSE](LICENSE).
