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

!macro customInit
  ; 安装/升级前强制结束旧进程，防止文件被锁定导致新版覆盖不全
  ExecWait 'taskkill /f /im "Hermes Buddy.exe"' $R0
  Sleep 2000
!macroend

!macro customInstall
  DetailPrint "正在清理旧版本缓存与配置…"

  ; 二次兜底：customInit 之后可能又被自启动项拉起
  ExecWait 'taskkill /f /im "Hermes Buddy.exe"' $R0
  Sleep 1000

  ClearErrors

  ; ---- Electron userData：连接配置 / 智能体 / 日志 / 服务端部署包 / 各类缓存 ----
  ; 全清，保证新版本从干净状态启动（旧的连接配置、解压过的 server-deploy 都不要留）
  RMDir /r "$APPDATA\@hermes\buddy-desktop"
  ; 父目录空了就顺手删掉；非空则静默失败，不影响
  RMDir "$APPDATA\@hermes"

  ; 早期版本用过的目录名，兜底清理
  RMDir /r "$APPDATA\hermesbuddy-desktop"
  RMDir /r "$APPDATA\Hermes Buddy"

  ; ---- electron-updater 下载缓存：单份 80MB 上下，升级几次就很可观 ----
  RMDir /r "$LOCALAPPDATA\@hermesbuddy-desktop-updater"
  RMDir /r "$LOCALAPPDATA\hermesbuddy-desktop-updater"
  RMDir /r "$LOCALAPPDATA\@hermes\buddy-desktop-updater"
  RMDir "$LOCALAPPDATA\@hermes"

  DetailPrint "旧版本缓存与配置已清理"
!macroend

!macro customUnInstall
  ; 卸载前强制结束进程，避免文件被锁导致残留
  ExecWait 'taskkill /f /im "Hermes Buddy.exe"' $R0
  Sleep 1000

  ClearErrors

  ; 显式清理用户数据（连接配置 / 智能体 / 工作区缓存 / 日志 / 部署包）
  RMDir /r "$APPDATA\@hermes\buddy-desktop"
  RMDir "$APPDATA\@hermes"
  RMDir /r "$APPDATA\hermesbuddy-desktop"
  RMDir /r "$APPDATA\Hermes Buddy"

  ; 清理更新缓存
  RMDir /r "$LOCALAPPDATA\@hermesbuddy-desktop-updater"
  RMDir /r "$LOCALAPPDATA\hermesbuddy-desktop-updater"
  RMDir /r "$LOCALAPPDATA\@hermes\buddy-desktop-updater"
  RMDir "$LOCALAPPDATA\@hermes"

  ; 清理残留快捷方式
  Delete "$DESKTOP\Hermes Buddy.lnk"
  Delete "$SMPROGRAMS\Hermes Buddy.lnk"
  RMDir /r "$SMPROGRAMS\Hermes Buddy"
!macroend
