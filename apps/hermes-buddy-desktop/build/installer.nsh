; =============================================================================
; Hermes Buddy - NSIS 自定义钩子
;
; 路径说明（重要，别再写错）：
;   真实 userData 是 %APPDATA%\@hermes\buddy-desktop
;   因为 package.json 的 name 是 "@hermes/buddy-desktop"，Electron 会把 scope
;   保留成一级目录。productName（"Hermes Buddy"）只用于快捷方式/窗口标题，
;   **不是** userData 目录名。
;
;   注意：%APPDATA%\Hermes 与 %LOCALAPPDATA%\hermes 是另一个 Hermes 应用，
;   本脚本一律不碰。
;
; v4.0 预测模式安装向导：
;   安装完成后用 MessageBox 展示隐私承诺 + 授权询问 + 可选加 Defender 排除区。
;   纯 NSIS 原生语法（StrCmp + 标签），不依赖 LogicLib / nsDialogs。
; =============================================================================

; -----------------------------------------------------------------------------
; 只清缓存，保留用户配置
;  保留：buddy.connection（连接配置）、agents.json（智能体与模型选择）、memory/
;  清理：Chromium/Electron 各类缓存、日志、解压出来的服务端部署包
; -----------------------------------------------------------------------------
!macro BUDDY_CLEAR_CACHE ROOT
  RMDir /r "${ROOT}\Cache"
  RMDir /r "${ROOT}\Code Cache"
  RMDir /r "${ROOT}\GPUCache"
  RMDir /r "${ROOT}\DawnGraphiteCache"
  RMDir /r "${ROOT}\DawnWebGPUCache"
  RMDir /r "${ROOT}\ShaderCache"
  RMDir /r "${ROOT}\Local Storage"
  RMDir /r "${ROOT}\Session Storage"
  RMDir /r "${ROOT}\blob_storage"
  RMDir /r "${ROOT}\WebStorage"
  RMDir /r "${ROOT}\Shared Dictionary"
  RMDir /r "${ROOT}\Network"
  RMDir /r "${ROOT}\Dictionaries"
  RMDir /r "${ROOT}\Partitions"
  RMDir /r "${ROOT}\logs"
  ; 服务端部署包：从安装包解压出来的副本，下次启动会按当前版本重新解压
  RMDir /r "${ROOT}\server-deploy"
  Delete "${ROOT}\SharedStorage"
  Delete "${ROOT}\SharedStorage-wal"
  Delete "${ROOT}\DIPS"
  Delete "${ROOT}\DIPS-shm"
  Delete "${ROOT}\DIPS-wal"
  Delete "${ROOT}\lockfile"
  Delete "${ROOT}\Preferences"
  Delete "${ROOT}\Local State"
  Delete "${ROOT}\gateway-diagnostic.json"
!macroend

; electron-updater 下载缓存：单份 80MB 上下，升级几次就很可观，与配置无关
!macro BUDDY_CLEAR_UPDATER_CACHE
  RMDir /r "$LOCALAPPDATA\@hermesbuddy-desktop-updater"
  RMDir /r "$LOCALAPPDATA\hermesbuddy-desktop-updater"
  RMDir /r "$LOCALAPPDATA\@hermes\buddy-desktop-updater"
  ; 只在父目录为空时删除，非空静默失败（安全）
  RMDir "$LOCALAPPDATA\@hermes"
!macroend

!macro customInit
  ; 安装/升级前强制结束旧进程，防止文件被锁定导致新版覆盖不全
  ExecWait 'taskkill /f /im "Hermes Buddy.exe"' $R0
  Sleep 2000
!macroend

!macro customInstall
  DetailPrint "正在清理旧版本缓存（保留连接与智能体配置）…"

  ; 二次兜底：customInit 之后可能又被自启动项拉起
  ExecWait 'taskkill /f /im "Hermes Buddy.exe"' $R0
  Sleep 1000

  ClearErrors

  ; 当前 userData：只清缓存
  !insertmacro BUDDY_CLEAR_CACHE "$APPDATA\@hermes\buddy-desktop"
  ; 早期版本遗留目录，同样只清缓存
  !insertmacro BUDDY_CLEAR_CACHE "$APPDATA\hermesbuddy-desktop"
  !insertmacro BUDDY_CLEAR_CACHE "$APPDATA\Hermes Buddy"

  !insertmacro BUDDY_CLEAR_UPDATER_CACHE

  DetailPrint "旧版本缓存已清理"

  ; ---------------------------------------------------------------
  ; v4.0 预测模式授权向导（安装后弹窗）
  ;   静默安装跳过；交互安装弹 MessageBox 询问用户是否授权。
  ;   纯 NSIS 原生语法（MessageBox + IDYES 标签跳转），不依赖 LogicLib。
  ; ---------------------------------------------------------------
  ; 检查是否静默安装：IfSilent 跳过向导
  IfSilent predict_wizard_done

  MessageBox MB_YESNO|MB_ICONQUESTION "Hermes Buddy v4.0 预测模式$\r$\n$\r$\nHermes 可以在你工作时主动递上一步建议。$\r$\n$\r$\n隐私承诺：$\r$\n  - 键盘只记录节奏（打字间隔），不记录按键内容$\r$\n  - 截图仅在内存中处理一帧，绝不落盘$\r$\n  - 行为日志只存模式元数据，不存任何文本$\r$\n  - 所有数据 7 天后自动清理，可随时一键关闭$\r$\n$\r$\n是否授权启用预测模式？（可随时在设置中关闭）" IDYES authorize_predict

  ; 用户选「否」：不授权，继续安装
  DetailPrint "预测模式未授权（默认关闭，可在设置中授权启用）"
  Goto predict_wizard_done

  authorize_predict:
  ; 用户选「是」：写授权文件
  CreateDirectory "$APPDATA\@hermes\buddy-desktop\predict"
  FileOpen $0 "$APPDATA\@hermes\buddy-desktop\predict\install-auth.json" w
  FileWrite $0 '{"authorized":true,"defenderExcluded":false}'
  FileClose $0
  DetailPrint "预测模式已授权（可在设置中随时关闭）"

  ; 询问是否加 Defender 排除区
  MessageBox MB_YESNO|MB_ICONQUESTION "是否将 Hermes Buddy 安装目录加入 Windows Defender 排除区？$\r$\n（推荐：防止全局钩子被 Defender 误拦）" IDYES add_defender_exclusion
  Goto predict_wizard_done

  add_defender_exclusion:
  DetailPrint "正在添加 Windows Defender 排除区..."
  ExecWait 'powershell -NoProfile -NonInteractive -Command "Add-MpPreference -ExclusionPath \"$INSTDIR\""' $0
  ; $0 == 0 成功（NSIS ExecWait 返回 exit code）
  StrCmp $0 0 defender_exclusion_ok
  DetailPrint "Defender 排除区添加失败（可能需要管理员权限），请手动添加"
  Goto predict_wizard_done

  defender_exclusion_ok:
  DetailPrint "Defender 排除区已添加: $INSTDIR"
  ; 更新授权文件中的 defenderExcluded 为 true
  FileOpen $0 "$APPDATA\@hermes\buddy-desktop\predict\install-auth.json" w
  FileWrite $0 '{"authorized":true,"defenderExcluded":true}'
  FileClose $0

  predict_wizard_done:
!macroend

!macro customUnInstall
  ; 卸载前强制结束进程，避免文件被锁导致残留
  ExecWait 'taskkill /f /im "Hermes Buddy.exe"' $R0
  Sleep 1000

  ClearErrors

  ; 卸载是彻底走人，userData 整个删掉（连接配置也没必要留了）
  RMDir /r "$APPDATA\@hermes\buddy-desktop"
  RMDir "$APPDATA\@hermes"
  RMDir /r "$APPDATA\hermesbuddy-desktop"
  RMDir /r "$APPDATA\Hermes Buddy"

  !insertmacro BUDDY_CLEAR_UPDATER_CACHE

  ; 清理残留快捷方式
  Delete "$DESKTOP\Hermes Buddy.lnk"
  Delete "$SMPROGRAMS\Hermes Buddy.lnk"
  RMDir /r "$SMPROGRAMS\Hermes Buddy"
!macroend
