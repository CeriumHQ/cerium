; How the installer puts the unpacked app in place, in place of the templates' own
; (include/extractAppPackage.nsh in app-builder-lib 26.17.0, whose extractUsing7za this repeats but for
; the moves). installer.nsh includes it in the install section, after the templates define
; extractUsing7za and before installApplicationFiles inserts it.
;
; The templates unpack into the plugins folder and copy every file from there into the install folder,
; one at a time through the shell: about 55 of an update's 85 seconds here, for 8,400 files. Here each
; unpacked entry the install folder lacks moves there in one rename instead, which after an update's
; uninstall is all of them. An install for everyone copies, so its files take the permissions of the
; folder they land in rather than those of the elevated user's temporary folder, and so does anything
; a rename couldn't move (another drive), with the templates' retries.

!macroundef extractUsing7za
!macro extractUsing7za FILE
  Push $OUTDIR
  CreateDirectory "$PLUGINSDIR\7z-out"
  ClearErrors
  SetOutPath "$PLUGINSDIR\7z-out"
  Nsis7z::Extract "${FILE}"
  Pop $R0
  SetOutPath $R0

  Push $R2
  ${if} $installMode != "all"
    FindFirst $R1 $R2 "$PLUGINSDIR\7z-out\*.*"
    ${DoWhile} $R2 != ""
      ${if} $R2 != "."
      ${andIf} $R2 != ".."
        Rename "$PLUGINSDIR\7z-out\$R2" "$OUTDIR\$R2"
      ${endif}
      FindNext $R1 $R2
    ${Loop}
    FindClose $R1
  ${endif}

  ; Looked for afresh rather than counted while moving, which renames in the folder being listed.
  StrCpy $R0 0
  FindFirst $R1 $R2 "$PLUGINSDIR\7z-out\*.*"
  ${DoWhile} $R2 != ""
    ${if} $R2 != "."
    ${andIf} $R2 != ".."
      StrCpy $R0 1
      ${Break}
    ${endif}
    FindNext $R1 $R2
  ${Loop}
  FindClose $R1
  Pop $R2
  ClearErrors
  ${if} $R0 == 0
    Goto DoneExtract7za
  ${endif}

  # Retry counter
  StrCpy $R1 0

  LoopExtract7za:
    IntOp $R1 $R1 + 1

    # Attempt to copy files in atomic way
    CopyFiles /SILENT "$PLUGINSDIR\7z-out\*" $OUTDIR
    IfErrors 0 DoneExtract7za

    DetailPrint `Can't modify "${PRODUCT_NAME}"'s files.`
    ${if} $R1 < 5
      # Try copying a few times before asking for a user action.
      Goto RetryExtract7za
    ${else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDRETRY IDCANCEL AbortExtract7za
    ${endIf}

    # As an absolutely last resort after a few automatic attempts and user
    # intervention - we will just overwrite everything with `Nsis7z::Extract`
    # even though it is not atomic and will ignore errors.

    # Clear the temporary folder first to make sure we don't use twice as
    # much disk space.
    RMDir /r "$PLUGINSDIR\7z-out"

    Nsis7z::Extract "${FILE}"
    Goto DoneExtract7za

  AbortExtract7za:
    Quit

  RetryExtract7za:
    Sleep 1000
    Goto LoopExtract7za

  DoneExtract7za:
!macroend
