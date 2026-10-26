# OneLake Studio docs

| Doc | What's in it |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Commands, settings, the agent skill, sign-in, the engine and the cache, semantic models, limitations and the source layout. |
| [CHANGELOG.md](CHANGELOG.md) | Release notes, newest first. It is also the Marketplace page's Changelog tab. |

## Architecture in brief

- **Read only.** Nothing is ever written to Fabric or OneLake. The extension host refuses any
  statement that could write.
- **The host does the work.** Sign-in, every OneLake read and the query engine run in the
  extension host ([`src/`](../src/)). The panel ([`app/`](../app/)) is only a view: it holds no
  token and makes no network request.
- **Cache first.** Listings, table metadata, first rows, files and table data are kept on this
  machine per Microsoft account, served from there at once and refreshed in the background.
- **Semantic models** are downloaded once as a `.bim`, then opened from disk. They are queried
  with `AGG(measure)`, compiled from DAX by [dax-sql](https://github.com/djouallah/dax-sql).

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
