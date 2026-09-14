!macro customInit
  ; 安装/升级前强制结束旧进程，防止文件被锁定导致新版覆盖不全
  ExecWait 'taskkill /f /im "Hermes Buddy.exe"' $R0
  Sleep 2000
!macroend

!macro customUnInstall
  ; 卸载前强制结束进程，避免文件被锁导致残留
  ExecWait 'taskkill /f /im "Hermes Buddy.exe"' $R0
  Sleep 1000
  ; 显式清理用户数据（连接配置 / 智能体 / 工作区缓存 / 日志 / 部署包）
  ; 与 deleteAppDataOnUninstall 互补，确保 %APPDATA%\Hermes Buddy 被彻底删除
  RMDir /r "$APPDATA\Hermes Buddy"
  ; 清理残留快捷方式
  Delete "$DESKTOP\Hermes Buddy.lnk"
  Delete "$SMPROGRAMS\Hermes Buddy.lnk"
  RMDir /r "$SMPROGRAMS\Hermes Buddy"
!macroend
