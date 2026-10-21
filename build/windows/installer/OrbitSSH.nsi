Unicode true

; The packaging script stages these files and passes the version definitions.
!ifndef APP_VERSION
  !define APP_VERSION "2.0.0"
!endif
!ifndef VI_VERSION
  !define VI_VERSION "2.0.0.0"
!endif

!define APP_NAME "Orbit SSH"
!define APP_EXE "OrbitSSH.exe"
!define APP_PUBLISHER "Orbit"
!define APP_URL "https://github.com/xmyhhh/orbit-ssh"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\OrbitSSH"
!define UNINSTALLER "uninstall.exe"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "nsDialogs.nsh"

Name "${APP_NAME}"
BrandingText "${APP_NAME} ${APP_VERSION}"
OutFile "OrbitSSH-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
RequestExecutionLevel user
ManifestDPIAware true
SetCompressor /SOLID lzma
SetCompressorDictSize 32
CRCCheck on

VIProductVersion "${VI_VERSION}"
VIFileVersion "${VI_VERSION}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} Setup"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "Orbit"
VIAddVersionKey "ProductName" "${APP_NAME}"

!define MUI_ICON "..\icon.ico"
!define MUI_UNICON "..\icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "$(WelcomeTitle)"
!define MUI_WELCOMEPAGE_TEXT "$(WelcomeText)"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "$(LaunchApp)"
!define MUI_UNCONFIRMPAGE_TEXT_TOP "$(UninstallText)"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "payload\LICENSE.txt"
PageEx custom
  PageCallbacks CreateRunningAppPage LeaveRunningAppPage
  Caption "$(RunningPageTitle)"
PageExEnd
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

LangString WelcomeTitle ${LANG_SIMPCHINESE} "安装 ${APP_NAME}"
LangString WelcomeText ${LANG_SIMPCHINESE} "安装程序将把 ${APP_NAME} 安装到当前用户目录，并创建开始菜单快捷方式。$\r$\n$\r$\n重复运行安装程序会覆盖旧版本；主机配置、凭据和终端历史会保留。"
LangString LaunchApp ${LANG_SIMPCHINESE} "启动 ${APP_NAME}"
LangString AppRunning ${LANG_SIMPCHINESE} "${APP_NAME} 正在运行，安装程序需要先关闭它才能覆盖旧版本。$\r$\n$\r$\n继续将强制关闭所有 ${APP_NAME} 窗口，未保存的编辑内容可能丢失。是否继续？"
LangString AppStillRunning ${LANG_SIMPCHINESE} "无法关闭正在运行的 ${APP_NAME}。请从托盘菜单退出应用后重试。"
LangString ClosingApp ${LANG_SIMPCHINESE} "正在关闭 ${APP_NAME}…"
LangString RemovingPrevious ${LANG_SIMPCHINESE} "正在移除旧版本…"
LangString InstallingWebView2 ${LANG_SIMPCHINESE} "正在安装 Microsoft Edge WebView2 Runtime…"
LangString WebView2Failed ${LANG_SIMPCHINESE} "WebView2 Runtime 安装失败。应用可能无法启动；请从微软官方网站安装 Evergreen Runtime 后重试。"
LangString Requires64 ${LANG_SIMPCHINESE} "此安装包仅支持 64 位 Windows。"
LangString UninstallText ${LANG_SIMPCHINESE} "卸载将删除程序文件和快捷方式。$\r$\n$\r$\n主机配置、凭据和终端历史保存在 %APPDATA%\OrbitSSH，不会自动删除。"
LangString RunningPageTitle ${LANG_SIMPCHINESE} "${APP_NAME} 正在运行"
LangString RunningPageText ${LANG_SIMPCHINESE} "安装程序需要先关闭它，才能覆盖程序文件。$\r$\n主机配置、凭据和终端历史保存在 %APPDATA%\OrbitSSH，不会受影响。$\r$\n$\r$\n可以自己退出应用后重新检测，也可以直接强制关闭所有窗口——未保存的编辑内容会丢失。"
LangString ForceCloseApp ${LANG_SIMPCHINESE} "强制关闭并继续(&F)"
LangString RecheckApp ${LANG_SIMPCHINESE} "我已关闭，重新检测(&R)"
LangString AppClosed ${LANG_SIMPCHINESE} "已确认应用关闭，可以继续安装。"
LangString AppStillRunningPrompt ${LANG_SIMPCHINESE} "应用仍在运行。请从托盘菜单退出后重新检测，或使用「强制关闭并继续」。"
LangString ContinueInstall ${LANG_SIMPCHINESE} "继续安装(&N)"

LangString WelcomeTitle ${LANG_ENGLISH} "Install ${APP_NAME}"
LangString WelcomeText ${LANG_ENGLISH} "Setup will install ${APP_NAME} for the current user and create a Start Menu shortcut.$\r$\n$\r$\nRunning Setup again overwrites the previous version; hosts, credentials and terminal history are kept."
LangString LaunchApp ${LANG_ENGLISH} "Launch ${APP_NAME}"
LangString AppRunning ${LANG_ENGLISH} "${APP_NAME} is running. Setup must close it before the old version can be overwritten.$\r$\n$\r$\nAll ${APP_NAME} windows will be closed. Unsaved editor changes may be lost. Continue?"
LangString AppStillRunning ${LANG_ENGLISH} "Could not close ${APP_NAME}. Exit it from the tray menu and try again."
LangString ClosingApp ${LANG_ENGLISH} "Closing ${APP_NAME}..."
LangString RemovingPrevious ${LANG_ENGLISH} "Removing the previous version..."
LangString InstallingWebView2 ${LANG_ENGLISH} "Installing Microsoft Edge WebView2 Runtime..."
LangString WebView2Failed ${LANG_ENGLISH} "WebView2 Runtime installation failed. The app may not start; install the Evergreen Runtime from Microsoft and try again."
LangString Requires64 ${LANG_ENGLISH} "This installer requires 64-bit Windows."
LangString UninstallText ${LANG_ENGLISH} "Uninstall removes the program files and shortcuts.$\r$\n$\r$\nHosts, credentials and terminal history are stored in %APPDATA%\OrbitSSH and are kept."
LangString RunningPageTitle ${LANG_ENGLISH} "${APP_NAME} is running"
LangString RunningPageText ${LANG_ENGLISH} "Setup must close it before the program files can be overwritten.$\r$\nHosts, credentials and terminal history live in %APPDATA%\OrbitSSH and are not touched.$\r$\n$\r$\nExit the app yourself and check again, or close every window right now. Unsaved editor changes will be lost."
LangString ForceCloseApp ${LANG_ENGLISH} "Close it and continue(&F)"
LangString RecheckApp ${LANG_ENGLISH} "I closed it, check again(&R)"
LangString AppClosed ${LANG_ENGLISH} "The app is closed. Setup can continue."
LangString AppStillRunningPrompt ${LANG_ENGLISH} "The app is still running. Exit it from the tray menu and check again, or use Close it and continue."
LangString ContinueInstall ${LANG_ENGLISH} "Continue(&N)"

; ------------------------------------------------------------------
; Running instance helpers
; ------------------------------------------------------------------

; tasklist prints one CSV line per process, so the image name is the first
; quoted field. Comparing that field keeps the check independent of the
; system language and of the padding tasklist uses for other output.
!macro AppRunningHelpers uninstaller
Function ${uninstaller}CheckAppRunning
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${APP_EXE}" /NH /FO CSV'
  Pop $1
  Pop $2
  StrCpy $3 $2 13
  ${If} $3 == '"${APP_EXE}"'
    StrCpy $0 1
  ${Else}
    StrCpy $0 0
  ${EndIf}
FunctionEnd

Function ${uninstaller}StopRunningApp
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /IM "${APP_EXE}" /F /T'
  Pop $1
  Pop $2
  Sleep 1200
FunctionEnd
!macroend
!insertmacro AppRunningHelpers ""
!insertmacro AppRunningHelpers "un."

Var RunningStatusLabel
Var RunningForceButton
Var RunningRecheckButton

; The custom page is skipped while the app is closed, so the extra step only
; shows up when there is something to decide.
Function CreateRunningAppPage
  !insertmacro MUI_LANGDLL_DISPLAY
  Call CheckAppRunning
  ${If} $0 == 0
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 12u "$(RunningPageTitle)"
  Pop $0
  ${NSD_CreateLabel} 0 13u 100% 30u "$(RunningPageText)"
  Pop $0
  ${NSD_CreateLabel} 0 45u 100% 8u ""
  Pop $RunningStatusLabel
  ${NSD_CreateButton} 0 56u 32% 12u "$(ForceCloseApp)"
  Pop $RunningForceButton
  ${NSD_OnClick} $RunningForceButton OnForceCloseApp
  ${NSD_CreateButton} 34% 56u 32% 12u "$(RecheckApp)"
  Pop $RunningRecheckButton
  ${NSD_OnClick} $RunningRecheckButton OnRecheckApp
  ${NSD_SetText} $RunningStatusLabel "$(AppStillRunningPrompt)"

  ; The next button continues the install once the app is gone.
  GetDlgItem $0 $hWndParent 1
  ${NSD_SetText} $0 "$(ContinueInstall)"
  nsDialogs::Show
FunctionEnd

Function LeaveRunningAppPage
  Call CheckAppRunning
  ${If} $0 == 1
    ${NSD_SetText} $RunningStatusLabel "$(AppStillRunningPrompt)"
    Abort
  ${EndIf}
FunctionEnd

Function OnForceCloseApp
  Pop $0
  DetailPrint "$(ClosingApp)"
  Call StopRunningApp
  Call CheckAppRunning
  ${If} $0 == 1
    ${NSD_SetText} $RunningStatusLabel "$(AppStillRunning)"
  ${Else}
    ${NSD_SetText} $RunningStatusLabel "$(AppClosed)"
    Call ContinueInstaller
  ${EndIf}
FunctionEnd

Function OnRecheckApp
  Pop $0
  Call CheckAppRunning
  ${If} $0 == 1
    ${NSD_SetText} $RunningStatusLabel "$(AppStillRunningPrompt)"
  ${Else}
    ${NSD_SetText} $RunningStatusLabel "$(AppClosed)"
    Call ContinueInstaller
  ${EndIf}
FunctionEnd

Function ContinueInstaller
  GetDlgItem $0 $hWndParent 1
  SendMessage $0 ${BM_CLICK} 0 0
FunctionEnd

!macro CloseRunningApp uninstaller
Function ${uninstaller}CloseRunningApp
  Call ${uninstaller}CheckAppRunning
  ${If} $0 == 0
    Return
  ${EndIf}
  IfSilent close_running_app
  MessageBox MB_YESNO|MB_ICONEXCLAMATION "$(AppRunning)" IDYES close_running_app
  Abort
  close_running_app:
  DetailPrint "$(ClosingApp)"
  Call ${uninstaller}StopRunningApp
  Call ${uninstaller}CheckAppRunning
  ${If} $0 != 0
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "$(AppStillRunning)"
    Abort
  ${EndIf}
FunctionEnd
!macroend
!insertmacro CloseRunningApp "un."

Function InstallWebView2
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $0 != ""
    ${AndIf} $0 != "0.0.0.0"
    Return
  ${EndIf}

  DetailPrint "$(InstallingWebView2)"
  InitPluginsDir
  File /oname=$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe "payload\MicrosoftEdgeWebview2Setup.exe"
  ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install' $1
  ${If} $1 != 0
    IfSilent +2
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(WebView2Failed)"
  ${EndIf}
FunctionEnd

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "$(Requires64)"
    Abort
  ${EndIf}
  SetRegView 64
  ${If} $INSTDIR == "$LOCALAPPDATA\Programs\${APP_NAME}"
    ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
    ${If} $0 != ""
      StrCpy $INSTDIR $0
    ${EndIf}
  ${EndIf}
  !insertmacro MUI_LANGDLL_DISPLAY

  ; Silent installs have nobody to answer a prompt, so the running instance is
  ; closed right away. Interactive installs decide on the dedicated page.
  Call CheckAppRunning
  ${If} $0 == 1
    IfSilent +1
    Goto init_done
    DetailPrint "$(ClosingApp)"
    Call StopRunningApp
    Call CheckAppRunning
    ${If} $0 == 1
      MessageBox MB_OK|MB_ICONSTOP "$(AppStillRunning)"
      Abort
    ${EndIf}
  ${EndIf}
  init_done:
FunctionEnd

Function un.onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "$(Requires64)"
    Abort
  ${EndIf}
  SetRegView 64
  Call un.CloseRunningApp
FunctionEnd

Section "Orbit SSH" SecMain
  SetShellVarContext current
  SetRegView 64
  SetOverwrite on

  IfFileExists "$INSTDIR\${UNINSTALLER}" 0 no_previous_install
  IfFileExists "$INSTDIR\${APP_EXE}" 0 no_previous_install
    DetailPrint "$(RemovingPrevious)"
    ExecWait '"$INSTDIR\${UNINSTALLER}" /S _?=$INSTDIR'
    RMDir /r "$INSTDIR"
  no_previous_install:

  SetOutPath "$INSTDIR"
  File "/oname=${APP_EXE}" "payload\${APP_EXE}"
  File "/oname=LICENSE.txt" "payload\LICENSE.txt"

  Call InstallWebView2

  WriteUninstaller "$INSTDIR\${UNINSTALLER}"

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0 SW_SHOWNORMAL
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk" "$INSTDIR\${UNINSTALLER}"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0 SW_SHOWNORMAL

  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER}"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINSTALLER}" /S'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "${APP_URL}"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "uninstall"
  SetShellVarContext current
  SetRegView 64

  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  RMDir /r "$INSTDIR"
SectionEnd
