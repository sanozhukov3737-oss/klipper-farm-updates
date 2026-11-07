; Capture this at include time: inside macros __FILEDIR__ is the generated NSI
; directory. Both files below are compiled into the signed installer itself.
!define KF_INSTALLER_HOOK_DIR "${__FILEDIR__}"

; Записывает причину отказа установки в каталог установки, чтобы апдейтер мог её
; показать. $PLUGINSDIR удаляется вместе с установщиком, поэтому пишем рядом.
!macro KF_WRITE_FAILURE_REASON REASON
  ${If} $INSTDIR != ""
    FileOpen $9 "$INSTDIR\.klipper-install-failure.txt" w
    ${IfNot} ${Errors}
      FileWriteUTF16LE $9 "${REASON}"
      FileClose $9
    ${EndIf}
    ClearErrors
  ${EndIf}
!macroend

!macro KF_STOP_RUNNING_COMPONENTS
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "klipper-farmd.exe"'
  Pop $0
  Pop $1
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "klipper-farmd-x86_64-pc-windows-msvc.exe"'
  Pop $0
  Pop $1
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "klipper-farmd-x86_64-pc-windows-gnu.exe"'
  Pop $0
  Pop $1
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "klipper-farm-client.exe"'
  Pop $0
  Pop $1
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro KF_STOP_RUNNING_COMPONENTS
  ; Причина прошлого отказа больше не нужна: установка начинается заново.
  Delete "$INSTDIR\.klipper-install-failure.txt"
  ; Existing-button updates use /UPDATE, so Tauri retains the old installation
  ; here. Verify reusable engines/model before overwriting any app resources.
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=install-update-components.ps1 "${KF_INSTALLER_HOOK_DIR}\..\..\scripts\install-update-components.ps1"
  File /oname=component-manifest.json "${KF_INSTALLER_HOOK_DIR}\..\resources\update-components\component-manifest.json"
  ; CI can prohibit network access and suppress only the progress window. These
  ; options never skip integrity checks or change a trusted component pin.
  StrCpy $3 ""
  ClearErrors
  ${GetOptions} $CMDLINE "/COMPONENTSOFFLINE" $4
  ${IfNot} ${Errors}
    StrCpy $3 "-Offline"
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/COMPONENTSNOPROGRESS" $4
  ${IfNot} ${Errors}
    StrCpy $3 "$3 -NoProgressWindow"
  ${EndIf}
  DetailPrint "Klipper Farm: verifying installed offline voice components..."
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\install-update-components.ps1" -InstallRoot "$INSTDIR" -ManifestPath "$PLUGINSDIR\component-manifest.json" -LocalSource "$EXEDIR" -ResultPath "$PLUGINSDIR\component-result.txt" $3'
  Pop $0
  Pop $1
  ${If} $0 != 0
    StrCpy $1 "Не удалось проверить или установить офлайн-компоненты. Проверьте соединение и свободное место."
    ClearErrors
    FileOpen $2 "$PLUGINSDIR\component-result.txt" r
    ${IfNot} ${Errors}
      FileReadUTF16LE $2 $1
      FileClose $2
    ${EndIf}
    MessageBox MB_ICONSTOP "$1" /SD IDOK
    !insertmacro KF_WRITE_FAILURE_REASON "$1"
    SetErrorLevel 2
    Abort
  ${EndIf}
  ; Tauri copies its executable/resources relative to the current output path.
  SetOutPath "$INSTDIR"
  ; V20.3 could persist the daemon as MainBinaryName. Correct the migration
  ; value before Tauri's template decides which old executable to delete, or
  ; it can delete the freshly copied klipper-farmd sidecar during the repair.
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Always recreate the Start menu entry with the verified desktop target.
  ; Preserve the user's desktop-shortcut choice, but repair it when it exists.
  Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 != 1
    !insertmacro KF_WRITE_FAILURE_REASON "Не удалось проверить ярлык в меню Пуск."
    Abort "Klipper Farm could not verify the Start menu shortcut target."
  ${EndIf}
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 != 1
      !insertmacro KF_WRITE_FAILURE_REASON "Не удалось проверить ярлык на рабочем столе."
      Abort "Klipper Farm could not verify the desktop shortcut target."
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KF_STOP_RUNNING_COMPONENTS
  ; These directories contain only app-owned offline components. Tauri removes
  ; the small bundled resources; heavy components are managed by this hook.
  ; Preferences and the user's library remain in their existing app-data paths.
  RMDir /r "$INSTDIR\speech"
  RMDir /r "$INSTDIR\understanding"
  Delete "$INSTDIR\.klipper-component-state.json"
  Delete "$INSTDIR\.klipper-component-install-error.txt"
!macroend
