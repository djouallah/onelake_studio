# OneLake Studio docs

OneLake Studio is a VS Code extension that makes a whole Microsoft Fabric tenant act as one database,
queried with SQL. Every table and semantic model has one unique name, so any statement can join across
items and workspaces with no setup. It runs on your machine, read only and cache first, and an agent
gets the same access as a person.

## Read in this order

| Doc | Read it for |
| --- | --- |
| [NAMING.md](NAMING.md) | The contract: five parts for a table, three for a semantic model, `abfss://` for a file, and why. Everything else depends on it. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The rules every change keeps, what is out of scope, how a statement runs, each feature, and where the code is. |
| [CHANGELOG.md](CHANGELOG.md) | Release notes, newest first. It is also the Marketplace page's Changelog tab. |
