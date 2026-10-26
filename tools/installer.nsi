Unicode true
!include "MUI2.nsh"

!define APP_NAME "异环乐器模拟器"
!define APP_EXE "YihuanInstrument.exe"
!define APP_VERSION "1.1.0"
!define APP_PUBLISHER "b站 @林羽empty"
!define MUI_ICON "D:\JOY\异环钢琴模拟器Zcode\build\icon.ico"
!define MUI_UNICON "D:\JOY\异环钢琴模拟器Zcode\build\icon.ico"

Name "${APP_NAME}"
OutFile "D:\JOY\异环钢琴模拟器Zcode\dist12\YihuanInstrument-Setup-1.1.0.exe"
InstallDir "$LOCALAPPDATA\Programs\YihuanInstrument"
InstallDirRegKey HKCU "Software\YihuanInstrument" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "运行 ${APP_NAME}"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "D:\JOY\异环钢琴模拟器Zcode\dist12\win-unpacked\*.*"
  WriteRegStr HKCU "Software\YihuanInstrument" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall ${APP_NAME}.exe"
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YihuanInstrument" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YihuanInstrument" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YihuanInstrument" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YihuanInstrument" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YihuanInstrument" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YihuanInstrument" "UninstallString" "$INSTDIR\Uninstall ${APP_NAME}.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YihuanInstrument" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YihuanInstrument" "NoRepair" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YihuanInstrument" "EstimatedSize" 190000
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YihuanInstrument"
  DeleteRegKey HKCU "Software\YihuanInstrument"
SectionEnd
