---
name: windows-shell
description: 在这台 Windows 电脑上执行 PowerShell 的正确方式、常见坑与高频命令模板
---

# Windows PowerShell 执行规范

## 执行环境

- 命令通过 `run_command` 在 **PowerShell** 中执行（可能是 5.1 或 7）。
- 每条命令在**独立进程**中运行，默认工作目录已设为工作区根目录。
- 因此：上一条命令里的 `Set-Location`、临时变量都**不会**带到下一条。需要定位就用相对路径或 `-Path` 参数，不要依赖 `cd`。

## 常用命令

```powershell
# 查看目录内容
Get-ChildItem -Recurse -Depth 2

# 找文件
Get-ChildItem -Recurse -Filter *.ts

# 读文件（避免中文乱码）
Get-Content 文件.md -Encoding UTF8

# 写文件（UTF-8，不要带 BOM）
Set-Content 文件.md -Value '内容' -Encoding UTF8 -NoNewline

# 文本搜索
Select-String -Path *.js -Pattern '关键字'

# 看进程 / 端口
Get-Process node
Get-NetTCPConnection -LocalPort 3000
```

## 必须避开的坑

1. **不要用 `cat` / `ls` / `grep`**：Windows 上没有这些命令（除非装了 Git Bash 并加入 PATH）。用 `Get-Content` / `Get-ChildItem` / `Select-String`。
2. **不要用 rm / cp / mv**：用 `Remove-Item` / `Copy-Item` / `Move-Item`。
3. **中文编码**：读取含中文的文件时显式加 `-Encoding UTF8`，否则 Windows PowerShell 5.1 会按 GBK 解码导致乱码。
4. **路径分隔符**：PowerShell 里正斜杠 `/` 和反斜杠 `\` 都能用，但传给原生程序时建议用反斜杠。路径含空格必须加引号。
5. **`&&` 不可用**：PowerShell 5.1 不支持 `&&`，用 `;` 分隔，或用 `if ($?) { ... }`。
6. **不要装软件**：需要新工具时用 `winget install --id <包> -e`（Windows 11 自带 winget），装之前先向用户确认。
7. **不要用 ssh 连别的机器**：本机就是执行环境，除非用户明确要求。

## 判断工具是否可用

```powershell
Get-Command git -ErrorAction SilentlyContinue
```

返回空说明没装，别硬用。
