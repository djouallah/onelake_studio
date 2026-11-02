; The installer and the uninstaller stop everything running from the install folder first. The window is
; not the only process: its Node process and the engines it starts are app\node.exe, and they hold the
; DuckDB extensions open, so the files can't be replaced while they run. WMI gives every process's path
; whatever the bitness, which a 32-bit installer can't read from a 64-bit process itself.
!macro StopRunningApp
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\'; $$p = @(Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase) }); $$p | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; $$p | ForEach-Object { Wait-Process -Id $$_.ProcessId -Timeout 15 -ErrorAction SilentlyContinue }"`
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopRunningApp
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopRunningApp
!macroend
