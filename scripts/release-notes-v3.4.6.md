# Hermes Buddy v3.4.6

## 问题
「完整部署」（向导里的「全新部署」模式）名不副实：它只部署了 Buddy 自己的两个外挂组件
（推理代理 8811 + WS 通道 8822），**从来没有安装 Hermes 服务端本体**
（hermes-agent + Gateway 22122）。所以在 223 这类只跑了完整部署的机器上，"能连"只是两个外挂服务在起作用，
记忆系统、技能注册表、会话管理那一层服务端能力是缺失的。

## 修复：完整部署现在会真正安装 Hermes 服务端本体
针对**大部分干净的 Ubuntu 22.04+**，完整部署在执行外挂组件之前新增一个「安装 Hermes 本体」阶段
（仅 `INSTALL_HERMES=1` 时触发，由「完整部署」向导自动置位；「已有 Hermes」自动升级部署不会触发，避免重复安装）：

1. **环境引导（ensure_python_uv）**：干净机器上先确认 Python/uv/pip 就绪——
   - 没有 `python3` → `apt-get install python3 python3-venv python3-pip`；
   - 没有 `uv` → 用官方安装器（`curl -LsSf https://astral.sh/uv/install.sh`）或 `pip install --user uv` 装上；
   - 没有 `python3-venv` 模块 → 自动 `apt-get install python3-venv`（无 uv 兜底时）。
2. **隔离 venv 安装（install_hermes）**：在 `/root/.hermes/venv` 用 `uv venv` + `uv pip install --python <venv>/bin/python`
   （无 uv 时退回 `python3 -m venv` + `python -m pip`）安装 `hermes-agent`。
   **完全隔离，绝不污染系统 / CUDA / PyTorch 环境（不使用 `--break-system-packages`）。**
   索引源可在向导里填（默认 PyPI，支持私有 `--index-url` / `--extra-index-url`）。
3. **生成 config.yaml**：把完整部署时填的上游供应商（base_url / model / api_key）写进
   `$HERMES_HOME/config.yaml`，Gateway 绑定 `0.0.0.0:22122`（已存在则不覆盖）。
4. **注册并拉起 hermes-gateway.service**（systemd；无 systemd 则 nohup 兜底）。

安装失败（如网络不通、私有索引不可达）时**优雅跳过**——只部署两个外挂组件，并保留之前"能连"的能力，
不会让整次部署崩掉。

## 向导 UI 改动
- 「全新部署」模式标题更正为「**完整部署 Hermes（含服务端本体）**」，按钮「完整部署并连接」。
- 上游表单新增两个可选字段：**Hermes 安装源（pip index）** 与 **额外索引源**，
  部署到内网 / 私有 PyPI 的机器可在此填写。

## 运维脚本（server-bootstrap）
生成的「服务端准备脚本」新增「**0. Hermes 服务端本体安装状态**」检查段：
hermes 命令是否就位、config.yaml 是否存在、22122 是否在监听。

## 验证
- `deploy.sh` 语法 + 安装函数仿真：干净机器（无 python/uv/apt）优雅跳过 RC=0；
  `uv venv` + `uv pip install --python` 指向隔离 venv（修复了一处"无 virtual environment"的报错）。
- 单元测试 88/88 通过，新增 `deploy.sh` 内容回归断言（锁定"完整部署装 Hermes、用隔离 venv、禁用 --break-system-packages"）
  与 server-bootstrap 本体检查断言。

## 注意
- 这是把"完整部署"补成真正含 Hermes 本体的版本。**请在目标 Ubuntu 22.04+ 上实测一次完整部署**。
- 之前用旧版"完整部署"连上的机器（如 223）仍只有外挂组件；用本版重新走一次「完整部署」即可补装 Hermes 本体
  （重新部署会保留已有的 `buddy-proxy.env` 上游配置，不会覆盖）。
