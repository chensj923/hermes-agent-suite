# Hermes Buddy v3.5.0 发布说明

## 修复：完整部署后 Gateway 22122 不通（致命缺件 aiohttp）

之前「完整部署」装完 `hermes-agent` 后，Gateway 进程能起来、22122 端口也在监听，但 **不提供 HTTP 服务**，
Buddy 连上后报 `fetch failed` / `channel-gateway-degraded`。

根因（已读本机部署日志 `buddy.log` 的 journalctl 确认）：`hermes-agent` 的 **基础依赖不含 aiohttp**，
aiohttp 只出现在 `messaging`/`slack`/`matrix` 等 extras 里；而 api_server 适配器需要 aiohttp。
只 `pip install hermes-agent` 装不出 api_server 适配器。

- `install_hermes()` 在装完 hermes-agent 后**显式补齐 `aiohttp==3.14.1`**（版本对齐 hermes-agent extras 声明；
  失败回退无版本约束安装），且主安装与兜底分支都走 `HERMES_INDEX_URL`（默认清华），不会回退到裸 pypi.org。
- Gateway 健康检查窗口 24s → 90s，避免启动慢被误判失败。
- 已在 223/231 实测：`pip install aiohttp==3.14.1` + `systemctl restart hermes-gateway` 后
  `22122/health` 返回 `{"status":"ok","platform":"hermes-agent","version":"0.19.0"}`。

## 新增：完整部署写入系统级环境变量（对所有用户生效）

之前 venv 与 `HERMES_HOME` 只在部署会话内有效，重启后 / 其他用户 / cron 拿不到，导致 `hermes` 命令不可见。
现在 `install_hermes()` 收尾调用 `setup_system_env()`：

- `/etc/profile.d/hermes.sh`：`export HERMES_HOME=...` + `export PATH="<venv>/bin:$PATH"`（所有登录用户）。
- `/etc/environment.d/hermes.conf`：`HERMES_HOME=...`（systemd 全局 / cron / 非登录单元）。
- `chmod -R a+rX <venv>`：放开 venv 对其他用户的读/执行权限，使「所有用户」真能调用 `hermes` 等命令。
- 同时让当前部署会话立即 `export`，无需重开 shell。

> 说明：venv 默认位于 `/root/.hermes`（可用 `HERMES_HOME` 覆盖，如 `/opt/hermes`），profile.d 写入的是真实值。
> 若需**非 root 用户**也能穿过 `/root` 访问，请自行放宽 `/root` 目录权限——部署按 root 惯例放在 `/root/.hermes`。

## 修复：完整部署找不到 uv 的误报

内网机 uv 常装在 `~/.local/bin`，但 SSH 跑 deploy.sh 是非登录非交互 shell，`~/.local/bin` 不在 PATH 导致
`command -v uv` 找不到。现在探测前 `export PATH="$HOME/.local/bin:$PATH"`；uv 安装失败显示真实错误并
用 `pip3 install --user uv` 兜底。另修一个隐藏语法 bug（`uv --version` 少右括号）。

## 修复：uv 不安全参数名随版本变化

旧代码对 http 源统一传 `--allow-insecure`，但 uv ≥0.5 已改名 `--allow-insecure-host`，旧参数名会让 uv 提前崩溃。
现在按 `uv pip install --help` 探测正确 flag 名（优先 `--allow-insecure-host`，回退 `--allow-insecure`），
且只对 `http://` 源加（清华等 https 有效证书源不加，避免误报未知参数）。

## 完整部署成功的判断依据（三条必须全过）

1. `/root/.hermes/venv/bin/hermes --version` 退出 0（hermes 命令可用）
2. `test -f /root/.hermes/config.yaml`（配置存在）
3. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:22122/health` == 200（Gateway 在监听且提供 HTTP）

任一条不满足即「安装未完成」，客户端应返回错误并提示重新执行完整部署。
