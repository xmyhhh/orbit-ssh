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

!macro CloseRunningApp uninstaller
Function ${uninstaller}IsAppRunning
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${APP_EXE}" /NH'
  Pop $0
  Pop $1
  StrCpy $2 $1 12
  ${If} $2 == "${APP_EXE}"
    StrCpy $3 1
  ${Else}
    StrCpy $3 0
  ${EndIf}
FunctionEnd

Function ${uninstaller}CloseRunningApp
  Call ${uninstaller}IsAppRunning
  ${If} $3 == 0
    Return
  ${EndIf}
  IfSilent close_running_app
  MessageBox MB_YESNO|MB_ICONEXCLAMATION "$(AppRunning)" IDYES close_running_app
  Abort
  close_running_app:
  DetailPrint "$(ClosingApp)"
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /IM "${APP_EXE}" /F /T'
  Pop $0
  Pop $1
  Sleep 1000
  Call ${uninstaller}IsAppRunning
  ${If} $3 != 0
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "$(AppStillRunning)"
    Abort
  ${EndIf}
FunctionEnd
!macroend
!insertmacro CloseRunningApp ""
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
  Call CloseRunningApp
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
  File "/oname=${APP_EXE}" "payload\OrbitSSH.exe"
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
