# Tauri proof of concept

A throwaway. It answers whether OneLake Studio could run as a Windows app with no VS Code, and shares no code with the
extension.

| Question | Answered by |
| --- | --- |
| Does a Tauri window reach a Node process running DuckDB and `node:sqlite`? | CI, by installing the build and running it with `--smoke` |
| How big is it, and how fast does it start? | CI, in the run's summary |
| Does the Azure CLI public client get tokens with no app registration? | A person, on a real tenant: **Sign in** |
| Do those tokens read OneLake, Power BI and the Fabric API? | The same click |

The engine needs Node either way, so Tauri ships `node.exe` beside its own executable, in `src-tauri/sidecar/`. The
window speaks to it in one line of JSON per request, over stdin and stdout. No token reaches the page: only its
audience, scopes and tenant do.

Get the installer from the artifact of the **Tauri PoC** run. If the sidecar fails, its errors are in
`%TEMP%\onelake-poc-sidecar.log`.
