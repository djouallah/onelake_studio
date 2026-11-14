# Security

## Reporting a problem

Report a vulnerability privately, through
[GitHub's security advisories for this repository](https://github.com/djouallah/onelake_studio/security/advisories/new).
Please don't open a public issue for one. Say what you did, what happened, and which version it was.

This is a personal project. Reports are read, and fixed in the next release when they hold.

## What is protected, and from what

OneLake Studio runs on your machine, signed in as you. It holds your OneLake token and reads what you may read.

**Inside the trust boundary: your own user account on this machine.** Any program running as you can already
read your files and your token caches. Nothing here tries to stop such a program. The command line's pipe, the
engine's control pipe and its local port are open to your account only, and a session token keeps other accounts
out of the port.

**Outside it, and guarded against:**

- **SQL from a tab or an agent.** One statement at a time. It reads, or it writes to a lakehouse when the
  *Writes* settings allow it. DuckDB may touch the disk only in its own temp and cache folders.
- **Content from OneLake.** Table names, column names, cell values, file names and documents are shown as text,
  never run. A table's own metadata may name files only on OneLake.
- **A web page in your browser.** Excel's endpoint and the desktop app's server listen on `127.0.0.1`, need a
  token, and refuse a request with an `Origin` or another `Host`.
- **A file someone sends you.** A `.fabricapp`, `.bim`, `.yaml` or `.sql` file is read as data. Publishing a
  `.fabricapp` asks first unless this computer published that app from that same file. The question shows the
  sign-in redirects the file would add. It is a question to read, not a proof of where a file came from.
- **What the build downloads.** Libraries and DuckDB's extensions are held to a recorded hash, and the native
  binding to the lockfile.

## Known limits

- **A statement can read any `https://` address.** A query written by someone else, or by an agent that read
  hostile text, can therefore send data out in a URL. Read SQL you didn't write before you run it.
- **The guard on SQL runs in the window, not in the engine's process.** A program holding the engine's session
  token can send it any SQL. That token is in VS Code's secret storage for the extension, and in a file in your
  profile for the command line and the desktop app.
- **On a computer several people sign in to at once,** another account could take a pipe's name before
  OneLake Studio does. The pipes don't yet prove who owns them.
- **The desktop app's installer is not signed.**
