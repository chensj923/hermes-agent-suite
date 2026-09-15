# Hermes Buddy · 服务端部署压缩包

本压缩包由 Buddy 安装包携带，包含把 **Hermes 服务端外挂组件** 一键部署到 Linux 主机所需的全部文件。

## 包含内容

| 文件 | 说明 |
|------|------|
| `buddy-inference-proxy.py` | 推理直通代理（端口 **8811**）。决策在 Buddy 客户端本地跑 ReAct 循环；本组件只把 Hermes 自己配好的上游模型原样透传，密钥不出服务器。 |
| `buddy-channel.py` | WS 工具通道（端口 **8822**）。决策在 Hermes 服务端跑 Agent 循环，把工具调用经 WebSocket 卸载给 Buddy 客户端本地执行（飞书式通道架构）。 |
| `deploy.sh` | **Hermes 侧执行脚本**：把上面两个组件部署到 `$HERMES_HOME`、注册 systemd（无 systemd 则 nohup 兜底）、探测上游、写 env、确保 API Key、重启 Gateway、健康检查并打印连接说明。 |
| `deploy.ps1` | **Windows 侧推送脚本**（可选）：用系统 OpenSSH 把本压缩包 scp 到 Hermes，再 ssh 解压并执行 `deploy.sh`。 |
| `start-channel.sh` | **独立启动脚本**（Docker / 手动）：不依赖 systemd，前台（容器主进程）或 `--daemon` 后台启动 `buddy-channel.py`。给「Hermes 跑在 Docker / 轻量 VM、没有 systemd」的客户用。 |
| `docker-compose.example.yml` / `Dockerfile.example` | Docker 通道部署示例：用 sidecar 容器或独立镜像跑 8822 通道，与 Hermes 共享 `HERMES_HOME` 卷。 |
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

## 方式三：Docker / 无 systemd 环境（start-channel.sh）

有些客户把 Hermes 跑在 **Docker 容器**里，没有 systemd，`deploy.sh` 的 systemd 分支用不上。这种场景只需要在能读到 Hermes 配置（含 `API_SERVER_KEY` / `config.yaml`）的环境里启动 `buddy-channel.py`：

```bash
# 把 buddy-channel.py 和 start-channel.sh 放到同一目录后：
bash start-channel.sh                 # 前台运行（推荐作为容器 CMD / 主进程）
bash start-channel.sh --daemon        # 普通 VM 上 nohup 后台运行
```

环境变量（均可选，脚本自动探测）：
`HERMES_HOME`（默认 `/root/.hermes`）、`BUDDY_CHANNEL_HOST`（默认 `0.0.0.0`）、`BUDDY_CHANNEL_PORT`（默认 `8822`）、`API_SERVER_KEY`（默认从 `.env` 探测）。
本地找不到 `buddy-channel.py` 时，可设 `BUDDY_CHANNEL_DOWNLOAD=1` 从 GitHub 对应版本标签自动下载。

更完整的 Docker 编排见同目录 `docker-compose.example.yml`（sidecar 容器）与 `Dockerfile.example`（烤进镜像）。
启动后在 Buddy 客户端「通道模式」填 `ws://<宿主机IP>:8822/api/buddy/channel`。

## 部署完成后

- 本地模式（默认）：Buddy 连接向导填 `Gateway 地址: http://<HERMES_HOST>:22122` + `API Key`，推理端点留空（自动指向 `http://<HERMES_HOST>:8811`）。
- 通道模式（决策在服务器）：连接向导选「通道模式」，或填 `ws://<HERMES_HOST>:8822/api/buddy/channel`。
- **不要**填 `http://<HERMES_HOST>:22122/v1/chat/completions` —— 那是服务端 agent 端点（会忽略本地工具、在服务器本地执行命令），Buddy 用不了。

更完整的协议规范见 `docs/WS_TOOL_CHANNEL.md`，使用文档见 `docs/WINDOWS_CLIENT.md`。
