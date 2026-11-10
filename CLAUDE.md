# OneLake Studio: rules for agents

Read [docs/NAMING.md](docs/NAMING.md), then [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), before
changing code.

## Releases

F5 (the Extension Development Host) is how changes are tested day to day. It never counts as
testing a release.

**Only when the user says a release is ready:** the build that will ship is installed and tested
locally first. Never install a vsix for ordinary testing.

1. **Get the build, with its version.** Bump the patch version in `package.json` and
   `package-lock.json`, and give the CHANGELOG's *Unreleased* items that version's heading, before
   anything is built: the release publishes this build as it is and builds nothing. Push to `main`
   and run the full build on it (`gh workflow run extension.yml --ref main`: every platform and the
   installer; a push builds only win32-x64 and linux-x64). Wait for that run to be green, and the
   push's "Lake tables" run too (the release asks for both), and download its vsix for this machine:

   ```sh
   gh run download <run-id> -n vsix-win32-x64 -D <scratch dir>
   ```

2. **Install it** over the installed extension:

   ```sh
   code --install-extension <scratch dir>/onelake-studio-*.vsix --force
   ```

3. **Test it.** The user reloads VS Code (*Developer: Reload Window*) and tests the installed build.
4. **Release only on the user's explicit OK.** Then push the `ext-v<version>` tag on that same
   commit. `release.yml` publishes that run's vsix and installer in a few minutes; it fails if the
   commit has no green run, or the run's artifacts are older than 14 days (run "Extension" on the
   commit again first). Never push a tag on your own initiative, and never treat a green CI run or
   a working F5 as that OK.
