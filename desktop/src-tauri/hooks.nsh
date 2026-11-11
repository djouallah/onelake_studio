; The installer and the uninstaller stop everything running from the install folder first. The window is
; not the only process: its Node process and the engines it starts are app\node.exe, and they hold the
; DuckDB extensions open, so the files can't be replaced while they run. WMI gives every process's path
; whatever the bitness, which a 32-bit installer can't read from a 64-bit process itself. Not the
; uninstaller: run in place (_?=$INSTDIR), it is in the install folder, and it would stop itself.
!macro StopRunningApp
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\'; $$p = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase) -and -not $$_.ExecutablePath.Equals($$d + 'uninstall.exe', [StringComparison]::OrdinalIgnoreCase) }); $$p | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; $$p | ForEach-Object { Wait-Process -Id $$_.ProcessId -Timeout 15 -ErrorAction SilentlyContinue }"`
  Pop $0
!macroend

; Setup installs over the version already there (installer.nsi has no "uninstall first" page), so the
; app's files go first: none the old version had and this one doesn't is left behind.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopRunningApp
  RMDir /r "$INSTDIR\app"
!macroend

; A model file, .yaml, .yml or .bim, is OneLake Studio's to open from Windows' "Open with", and never made
; its default: .fabricapp is the only file the app takes (tauri.conf.json fileAssociations). Windows lets
; only the person make it .yaml's default (Open with > Always); then a YAML that is not a model goes on to
; the program that had it, before a window shows (main.rs open_elsewhere).
!macro OpenWithModel EXT
  WriteRegStr SHCTX "Software\Classes\${EXT}\OpenWithProgids" "OneLakeStudio.Model" ""
!macroend
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\OneLakeStudio.Model" "" "Semantic model"
  WriteRegStr SHCTX "Software\Classes\OneLakeStudio.Model\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\OneLakeStudio.Model\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  !insertmacro OpenWithModel ".yaml"
  !insertmacro OpenWithModel ".yml"
  !insertmacro OpenWithModel ".bim"
  System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopRunningApp
  DeleteRegValue SHCTX "Software\Classes\.yaml\OpenWithProgids" "OneLakeStudio.Model"
  DeleteRegValue SHCTX "Software\Classes\.yml\OpenWithProgids" "OneLakeStudio.Model"
  DeleteRegValue SHCTX "Software\Classes\.bim\OpenWithProgids" "OneLakeStudio.Model"
  DeleteRegKey SHCTX "Software\Classes\OneLakeStudio.Model"
!macroend
