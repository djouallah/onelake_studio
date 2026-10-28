# OneLake Studio: rules for agents

## Releases

F5 (the Extension Development Host) is for debugging only. It never counts as testing a release.

**Before any release, the build that will ship is installed and tested locally first.**

1. **Get the build.** Push to `main` and wait for the green CI run ("Extension"). Download that
   run's vsix for this machine:

   ```sh
   gh run download <run-id> -n vsix-win32-x64 -D <scratch dir>
   ```

2. **Install it** over the installed extension:

   ```sh
   code --install-extension <scratch dir>/onelake-studio-*.vsix --force
   ```

3. **Test it.** The user reloads VS Code (*Developer: Reload Window*) and tests the installed build.
4. **Release only on the user's explicit OK.** Then bump the version and push the `ext-v*` tag.
   Never push a tag on your own initiative, and never treat a green CI run or a working F5 as that
   OK.
