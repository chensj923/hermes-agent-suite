; =============================================================================
; Hermes Buddy — NSIS 自定义钩子
;
; 路径说明（重要，别再写错）：
;   真实 userData 是 %APPDATA%\@hermes\buddy-desktop
;   因为 package.json 的 name 是 "@hermes/buddy-desktop"，Electron 会把 scope
;   保留成一级目录。productName（"Hermes Buddy"）只用于快捷方式/窗口标题，
;   **不是** userData 目录名。
;
;   注意：%APPDATA%\Hermes 与 %LOCALAPPDATA%\hermes 是另一个 Hermes 应用，
;   本脚本一律不碰。
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
