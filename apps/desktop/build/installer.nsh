; Cerium's additions to electron-builder's guided installer (electron-builder.ts), all for updates.
; electron-updater runs it with `--updated` once Cerium has stopped (src/updater.ts), with its window
; and `--force-run` when Cerium restarted for the update: the window skips straight to its progress
; page, says Cerium is updating, and closes by itself, starting Cerium again when it restarted. A first
; install from the website runs as it always has.

; An update keeps the install it replaces, for this user or for everyone, instead of asking again.
!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $hasPerMachineInstallation == "1"
    ${andIf} $hasPerUserInstallation == "0"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

; Looking for Cerium's processes as the templates do (include/allowOnlyOneInstallerInstance.nsh), whose
; own lines leave out getProcessInfo.nsh and $pid once this is defined. It's the one hook between the
; templates defining how the app unpacks and unpacking it, which moveIntoPlace.nsh makes faster.
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    !include "moveIntoPlace.nsh"
  !endif
!macroend

; No page of its own: the progress page, which comes next, says when it's an update and what follows.
!macro customPageAfterChangeDir
  Function ceriumInstFilesShow
    ${if} ${isUpdated}
      SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:Updating ${PRODUCT_NAME}"
      ${if} ${isForceRun}
        !insertmacro MUI_HEADER_TEXT "Updating ${PRODUCT_NAME}" "${PRODUCT_NAME} opens again when it's done."
      ${else}
        !insertmacro MUI_HEADER_TEXT "Updating ${PRODUCT_NAME}" "This window closes when it's done."
      ${endif}
    ${endif}
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ceriumInstFilesShow
!macroend

; A first install ends on the finish page, which starts Cerium when asked. An update leaves it out,
; starting Cerium itself when Cerium restarted for it.
!macro customFinishPage
  Function ceriumStartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function ceriumFinishPre
    ${if} ${isUpdated}
      ${if} ${isForceRun}
        ; Otherwise Cerium's window opens behind this one's last position.
        HideWindow
        Call ceriumStartApp
      ${endif}
      Abort
    ${endif}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE ceriumFinishPre
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION ceriumStartApp
  !insertmacro MUI_PAGE_FINISH
!macroend

; The version an update replaces leaves a folder at a time instead of a file at a time: its thousands
; of files took one rename each into the uninstaller's temporary folder, which the uninstaller then
; deletes. Each entry of the install folder moves in one rename instead; when one
; can't, because something still holds a file in it, everything goes back and the default takes over,
; which finds the busy file and gives up on the update without touching the install.
!ifdef BUILD_UNINSTALLER
  ; This file comes before the templates, which include it themselves later.
  !include "LogicLib.nsh"

  ; Leaves $R0 0 once every entry has moved, 1 when one couldn't.
  Function un.ceriumMoveAside
    Push $R1
    Push $R2
    StrCpy $R0 0
    FindFirst $R1 $R2 "$INSTDIR\*.*"
    ${DoWhile} $R2 != ""
      ${if} $R2 != "."
      ${andIf} $R2 != ".."
      ; It runs from a copy of itself, but may run from here when the copy couldn't start. Its name
      ; is common.nsh's UNINSTALL_FILENAME, which isn't defined yet.
      ${andIf} $R2 != "Uninstall ${PRODUCT_FILENAME}.exe"
        ClearErrors
        Rename "$INSTDIR\$R2" "$PLUGINSDIR\old-install\$R2"
        ${if} ${Errors}
          StrCpy $R0 1
          ${Break}
        ${endif}
      ${endif}
      FindNext $R1 $R2
    ${Loop}
    FindClose $R1
    Pop $R2
    Pop $R1
  FunctionEnd
!endif

!macro customRemoveFiles
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"
    Call un.ceriumMoveAside
    ${if} $R0 != 0
      Push ""
      Call un.restoreFiles
      Pop $R0

      Push ""
      Call un.atomicRMDir
      Pop $R0
      ${if} $R0 != 0
        DetailPrint "File is busy, aborting: $R0"
        Push ""
        Call un.restoreFiles
        Pop $R0
        Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
      ${endif}
    ${endif}
  ${endif}

  ; Out of $INSTDIR, so it can be removed.
  SetOutPath $TEMP
  RMDir /r $INSTDIR
!macroend
