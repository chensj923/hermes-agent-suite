# Hermes Buddy · 服务端部署压缩包

本压缩包由 Buddy 安装包携带，包含把 **Hermes 服务端外挂组件** 一键部署到 Linux 主机所需的全部文件。

## 包含内容

| 文件 | 说明 |
|------|------|
| `buddy-inference-proxy.py` | 推理直通代理（端口 **8811**）。决策在 Buddy 客户端本地跑 ReAct 循环；本组件只把 Hermes 自己配好的上游模型原样透传，密钥不出服务器。 |
| `buddy-channel.py` | WS 工具通道（端口 **8822**）。决策在 Hermes 服务端跑 Agent 循环，把工具调用经 WebSocket 卸载给 Buddy 客户端本地执行（飞书式通道架构）。 |
| `deploy.sh` | **Hermes 侧执行脚本**：把上面两个组件部署到 `$HERMES_HOME`、注册 systemd（无 systemd 则 nohup 兜底）、探测上游、写 env、确保 API Key、重启 Gateway、健康检查并打印连接说明。 |
| `deploy.ps1` | **Windows 侧推送脚本**（可选）：用系统 OpenSSH 把本压缩包 scp 到 Hermes，再 ssh 解压并执行 `deploy.sh`。 |
| `README.md` | 本说明。 |

## 方式一：手动部署（在 Hermes 上跑，无需从 Windows 推送）

1. 把本压缩包传到 Hermes（U 盘 / scp / 下载均可）。
2. 解压：
   ```bash
   mkdir -p /tmp/hermes-buddy-deploy
   tar -xzf hermes-buddy-server-deploy.tar.gz -C /tmp/hermes-buddy-deploy
   cd /tmp/hermes-buddy-deploy
   ```
3. 以 root（或 sudo）执行：
   ```bash
   sudo bash deploy.sh
   ```
   可选环境变量：`HERMES_HOME`（默认 `/root/.hermes`）、`BUDDY_PROXY_PORT`（默认 8811）、`BUDDY_CHANNEL_PORT`（默认 8822）、`SHOW_KEYS=1`（打印完整上游密钥）。

## 方式二：从 Windows 一键推送（deploy.ps1）

需 Windows 10+ 自带 OpenSSH（或安装 PuTTY 走口令）。在 Buddy 安装目录的 `resources/deploy/` 下打开 PowerShell：

```powershell
# 密钥登录（最常见）
.\deploy.ps1 -Host 192.168.0.231 -User root -KeyPath ~\.ssh\id_rsa

# 口令登录（需 PuTTY）
.\deploy.ps1 -Host 192.168.0.231 -User root -Password "xxxxx" -UsePlink
```

脚本会 scp 压缩包到 Hermes 的 `/tmp`，再 ssh 解压并运行 `deploy.sh`。

## 部署完成后

- 本地模式（默认）：Buddy 连接向导填 `Gateway 地址: http://<HERMES_HOST>:22122` + `API Key`，推理端点留空（自动指向 `http://<HERMES_HOST>:8811`）。
- 通道模式（决策在服务器）：连接向导选「通道模式」，或填 `ws://<HERMES_HOST>:8822/api/buddy/channel`。
- **不要**填 `http://<HERMES_HOST>:22122/v1/chat/completions` —— 那是服务端 agent 端点（会忽略本地工具、在服务器本地执行命令），Buddy 用不了。

更完整的协议规范见 `docs/WS_TOOL_CHANNEL.md`，使用文档见 `docs/WINDOWS_CLIENT.md`。
