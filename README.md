# OneLake Studio for VS Code

A Visual Studio Code extension to browse Microsoft Fabric OneLake: workspaces, lakehouses,
warehouses, tables, files and Power BI semantic models, read only, signed in with the Microsoft
account VS Code already uses.

![The OneLake explorer](docs/summary.png)

**Install:** in VS Code open Extensions (`Ctrl+Shift+X`), search **OneLake Studio**, then click Install.
You can also install it from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=djouallah.onelake-studio)
or run `code --install-extension djouallah.onelake-studio`. It needs desktop VS Code 1.90 or later on Windows, macOS or Linux (x64 or arm64).

**Use:** click the OneLake Studio icon in the activity bar and sign in. Query tables and `Files/` with SQL, and open a
semantic model to explore it — Model, Pivot (Show SQL, Show plan with a query profile) and Logs — or query it with `AGG(measure)`. Right-click an Ossie model in `Files/` and choose **Generate Report…**
to get a Fabric app (DuckDB-WASM over its lakehouse's Iceberg catalog) in a folder, ready for an agent to grow. **Export to Fabric**, on the Pivot,
publishes that Explore as a protected Fabric app that reads the model and its tables from the lakehouse (and keeps a local copy) — the only thing that ever writes to Fabric, and only on its click.
**Install Agent Skill** lets Claude Code or GitHub Copilot answer questions about your data. Nothing is ever written to OneLake.

Commands, settings, how it works and release notes: [docs/](https://github.com/djouallah/onelake_studio/tree/main/docs).

> A personal learning project — not a Microsoft product or supported by Microsoft, and DAX compiled
> to SQL here is not guaranteed to match Power BI.
