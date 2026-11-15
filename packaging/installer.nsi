; loudness-tool installer, NSIS 3.13.
;
; Installs loudness-tool.exe for the current user to %LOCALAPPDATA%\loudness-tool, or to the folder of an existing
; installation, and adds that folder to the user PATH. Installing over an existing installation upgrades it in place;
; installing to another folder removes the previous folder's files and its PATH entry, or reports a previous
; loudness-tool.exe in use and leaves it and its PATH entry.
;
; scripts/package.mjs defines VERSION, ARCH (x64 or arm64), BINARY, NOTICES, LICENSE and OUTFILE.
;
; Installer exit codes:
;   0  installed
;   1  cancelled by the user
;   2  writing a file failed, e.g. over a running loudness-tool.exe; the registration and PATH are left as they were
;   3  installed, but adding the install folder to the user PATH failed
;   4  this Windows cannot run the installer's executable; nothing changed
;
; UninstallString runs the uninstaller the standard way: it copies itself to %TEMP% and returns at once. A caller that
; must wait for the result runs a copy of uninstall.exe from outside the install folder with _?=<install folder> last
; and unquoted, which returns its exit code (uninstall.exe run in place with _?= leaves itself and the folder):
;   0  removed
;   1  cancelled by the user
;   2  loudness-tool.exe is in use; nothing was removed
;   3  removed, but removing the install folder from the user PATH failed

Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!ifndef VERSION | ARCH | BINARY | NOTICES | LICENSE | OUTFILE
	!error "VERSION, ARCH, BINARY, NOTICES, LICENSE and OUTFILE must be defined; build with node scripts/package.mjs"
!endif

!include MUI2.nsh
!include LogicLib.nsh
!include x64.nsh
!include FileFunc.nsh
!include WinVer.nsh

!define PRODUCT "loudness-tool"
!define PUBLISHER "Matt Cavender"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT}"
!define PRODUCTKEY "Software\${PRODUCT}"

Name "${PRODUCT} ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\${PRODUCT}"
InstallDirRegKey HKCU "${PRODUCTKEY}" ""
BrandingText "${PRODUCT} ${VERSION}"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "FileDescription" "${PRODUCT} ${VERSION} installer"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "LegalCopyright" "Copyright (c) ${PUBLISHER}, MIT License"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TEXT "${PRODUCT} ${VERSION} is installed in $INSTDIR. Open a new terminal and run ${PRODUCT} --help."
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; The PATH is edited through PowerShell so a PATH longer than NSIS_MAX_STRLEN is read and written whole. PowerShell is
; named by its full path so a powershell.exe beside the installer never runs. The directory reaches PowerShell through
; the environment, and the throwaway user variable broadcasts WM_SETTINGCHANGE so new terminals see the change.
!define PATH_ADD `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference='Stop';$$d=$$env:LOUDNESS_TOOL_INSTALL_DIR;if(-not $$d){throw 'LOUDNESS_TOOL_INSTALL_DIR was empty'};$$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$$true);$$p=[string]$$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if(($$p -split ';') -notcontains $$d){$$k.SetValue('Path',(($$p.TrimEnd(';')+';'+$$d).TrimStart(';')),[Microsoft.Win32.RegistryValueKind]::ExpandString)};$$q=[string]$$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);$$k.Close();if(($$q -split ';') -notcontains $$d){throw 'the user PATH is missing the install directory'};[Environment]::SetEnvironmentVariable('LOUDNESS_TOOL_PATH_REFRESH','1','User');[Environment]::SetEnvironmentVariable('LOUDNESS_TOOL_PATH_REFRESH',$$null,'User')"`
!define PATH_REMOVE `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference='Stop';$$d=$$env:LOUDNESS_TOOL_INSTALL_DIR;if(-not $$d){throw 'LOUDNESS_TOOL_INSTALL_DIR was empty'};$$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$$true);$$p=[string]$$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);$$k.SetValue('Path',((($$p -split ';') | Where-Object { $$_ -and $$_ -ne $$d }) -join ';'),[Microsoft.Win32.RegistryValueKind]::ExpandString);$$q=[string]$$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);$$k.Close();if(($$q -split ';') -contains $$d){throw 'the user PATH still holds the install directory'};[Environment]::SetEnvironmentVariable('LOUDNESS_TOOL_PATH_REFRESH','1','User');[Environment]::SetEnvironmentVariable('LOUDNESS_TOOL_PATH_REFRESH',$$null,'User')"`

; Writes a message to the console a silent run was started from, and to the details view.
!macro Report Message
	DetailPrint "${Message}"
	${If} ${Silent}
		System::Call 'kernel32::AttachConsole(i -1)i.r1'
		${If} $1 != 0
			System::Call 'kernel32::GetStdHandle(i -11)i.r1'
			FileWrite $1 "${Message}$\r$\n"
		${EndIf}
	${EndIf}
!macroend

Function .onInit
	SetShellVarContext current
	SetRegView 64
	!if "${ARCH}" == "arm64"
		${IfNot} ${IsNativeARM64}
			!insertmacro Report "${PRODUCT}: this installer carries the Windows arm64 executable; use the x64 installer on this PC"
			${IfNot} ${Silent}
				MessageBox MB_ICONSTOP "This installer carries the Windows arm64 build of ${PRODUCT}. Use the x64 installer on this PC."
			${EndIf}
			SetErrorLevel 4
			Quit
		${EndIf}
	!else
		${IfNot} ${IsNativeAMD64}
		${AndIfNot} ${IsNativeARM64}
			!insertmacro Report "${PRODUCT}: the x64 executable needs 64-bit Windows on an x64 or arm64 processor"
			${IfNot} ${Silent}
				MessageBox MB_ICONSTOP "${PRODUCT} needs 64-bit Windows on an x64 or arm64 processor."
			${EndIf}
			SetErrorLevel 4
			Quit
		${EndIf}
		; Windows on arm64 runs x64 programs from Windows 11, build 22000.
		${If} ${IsNativeARM64}
		${AndIfNot} ${AtLeastBuild} 22000
			!insertmacro Report "${PRODUCT}: this Windows on arm64 runs no x64 programs; use the arm64 installer"
			${IfNot} ${Silent}
				MessageBox MB_ICONSTOP "This version of Windows on arm64 runs no x64 programs. Use the arm64 installer of ${PRODUCT}."
			${EndIf}
			SetErrorLevel 4
			Quit
		${EndIf}
	!endif
FunctionEnd

Section Install
	ReadRegStr $R9 HKCU "${PRODUCTKEY}" ""

	SetOutPath $INSTDIR
	ClearErrors
	File "/oname=${PRODUCT}.exe" "${BINARY}"
	File "/oname=LICENSE.txt" "${LICENSE}"
	File "/oname=THIRD-PARTY-NOTICES.txt" "${NOTICES}"
	WriteUninstaller "$INSTDIR\uninstall.exe"
	${If} ${Errors}
		!insertmacro Report "${PRODUCT}: writing to $INSTDIR failed; close any running ${PRODUCT} and run the installer again"
		SetErrorLevel 2
		Abort
	${EndIf}

	; The previous folder is another folder when a file just written here is absent there, whatever the spelling of the
	; two paths.
	FileOpen $0 "$INSTDIR\${PRODUCT}.install-probe" w
	FileClose $0
	${If} $R9 != ""
	${AndIfNot} ${FileExists} "$R9\${PRODUCT}.install-probe"
	${AndIf} ${FileExists} "$R9\${PRODUCT}.exe"
		ClearErrors
		Delete "$R9\${PRODUCT}.exe"
		${If} ${Errors}
			!insertmacro Report "${PRODUCT}: the previous ${PRODUCT}.exe in $R9 is in use; it and its PATH entry stay until you remove them"
		${Else}
			Delete "$R9\LICENSE.txt"
			Delete "$R9\THIRD-PARTY-NOTICES.txt"
			Delete "$R9\uninstall.exe"
			RMDir "$R9"
			System::Call 'kernel32::SetEnvironmentVariable(t "LOUDNESS_TOOL_INSTALL_DIR", t "$R9")i.r0'
			nsExec::ExecToLog `${PATH_REMOVE}`
			Pop $0
			${If} $0 != 0
				!insertmacro Report "${PRODUCT}: removing the previous folder $R9 from the user PATH failed with $0; remove it by hand"
			${EndIf}
		${EndIf}
	${EndIf}
	Delete "$INSTDIR\${PRODUCT}.install-probe"

	WriteRegStr HKCU "${PRODUCTKEY}" "" $INSTDIR
	WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${PRODUCT}"
	WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${PRODUCT}.exe$\""
	WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
	WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${PUBLISHER}"
	WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
	WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
	WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
	WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
	WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
	${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
	WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" $0

	System::Call 'kernel32::SetEnvironmentVariable(t "LOUDNESS_TOOL_INSTALL_DIR", t "$INSTDIR")i.r0'
	nsExec::ExecToLog `${PATH_ADD}`
	Pop $0
	${If} $0 != 0
		!insertmacro Report "${PRODUCT}: adding $INSTDIR to the user PATH failed with $0; add it by hand or run the installer again"
		${IfNot} ${Silent}
			MessageBox MB_ICONEXCLAMATION "Adding $INSTDIR to your user PATH failed with $0. Add it by hand, or run the installer again."
		${EndIf}
		SetErrorLevel 3
	${EndIf}
SectionEnd

Function un.onInit
	SetShellVarContext current
	SetRegView 64
FunctionEnd

Section Uninstall
	ClearErrors
	Delete "$INSTDIR\${PRODUCT}.exe"
	${If} ${Errors}
		!insertmacro Report "${PRODUCT}: $INSTDIR\${PRODUCT}.exe is in use; close it and run the uninstaller again"
		SetErrorLevel 2
		Abort
	${EndIf}
	Delete "$INSTDIR\LICENSE.txt"
	Delete "$INSTDIR\THIRD-PARTY-NOTICES.txt"
	Delete "$INSTDIR\uninstall.exe"
	RMDir "$INSTDIR"

	DeleteRegKey HKCU "${UNINSTKEY}"
	DeleteRegKey HKCU "${PRODUCTKEY}"

	System::Call 'kernel32::SetEnvironmentVariable(t "LOUDNESS_TOOL_INSTALL_DIR", t "$INSTDIR")i.r0'
	nsExec::ExecToLog `${PATH_REMOVE}`
	Pop $0
	${If} $0 != 0
		!insertmacro Report "${PRODUCT}: removing $INSTDIR from the user PATH failed with $0; remove it by hand"
		SetErrorLevel 3
	${EndIf}
SectionEnd
