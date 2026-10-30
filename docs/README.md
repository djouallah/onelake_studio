# OneLake Studio docs

| Doc | What's in it |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Fabric as a catalog queried with SQL, sign-in, the engine and the cache, semantic models, Explore, Export to Fabric, commands, settings, the agent skill, limitations and the source layout. |
| [NAMING.md](NAMING.md) | The naming convention: five parts for a table, three for a semantic model, and why. |
| [CHANGELOG.md](CHANGELOG.md) | Release notes, newest first. It is also the Marketplace page's Changelog tab. |

## Architecture in brief

- **Fabric is a catalog** of objects, each with a name no other object has: tables
  (`lakehouse.<ws>.<item>.<schema>.<table>`), files (their `abfss://` URL) and semantic models
  (`semanticmodel.<ws>.<model>`), which are views over tables, with measures.
- **SQL is how you ask it.** The editor, Explore, the command line and the agent skill all send
  SQL over those names. A model is queried with `AGG(measure)`, compiled from DAX by
  [dax-sql](https://github.com/djouallah/dax-sql).
- **Read only.** The extension host refuses any statement that could write. The one exception is
  Export to Fabric, after an OK: it publishes an app and writes the model's `.yaml` into its
  lakehouse's `Files/`.
- **Cache first.** Listings, table metadata, first rows, files, semantic models and table data
  are kept on this machine per Microsoft account, served from there at once and refreshed in the
  background.
- **The host does the work.** Sign-in, every OneLake read and the query engine run in the
  extension host ([`src/`](../src/)). The panel ([`app/`](../app/)) is only a view: it holds no
  token and makes no network request.

## Latest release: 0.2.4

The first release notes, covering everything since 0.1.0:

- Power BI semantic models in the explorer, opened as Model, Explore and SQL pages. `.bim` files
  and Apache Ossie `.yaml` files in `Files/` open the same way.
- An agent skill for Claude Code and GitHub Copilot that answers questions over the extension's
  read-only command line.
- An explorer with Group by Type and pinned favorite workspaces.
- A native engine in the extension host, and a panel that loads nothing from the network.
- A cache-first design that survives restarts, and platform-specific builds for Windows, macOS
  and Linux on x64 and arm64.
