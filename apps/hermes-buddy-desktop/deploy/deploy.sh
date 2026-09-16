#!/usr/bin/env bash
# =============================================================================
# Hermes Buddy · 服务端部署脚本（外挂组件）
#
# 这是「服务端部署压缩包」里的执行脚本。压缩包由 Buddy 安装包携带，解开后包含：
#   buddy-inference-proxy.py   推理直通代理（端口 8811，决策在 Buddy 客户端本地）
#   buddy-channel.py           WS 工具通道（端口 8822，决策在 Hermes 服务器）
#   deploy.sh                  本脚本
#   deploy.ps1                 Windows 侧自动推送脚本（可选）
#   README.md                  说明
#
# 本脚本做什么（在 Hermes 主机上以 root 或 sudo 执行）：
#   1. 把两个 .py 部署到 $HERMES_HOME
#   2. 注册 systemd 服务（无 systemd 则 nohup 兜底）
#   3. 探测上游模型并写 buddy-proxy.env（命中正确的 chat 路径 + 验证 function calling）
#   4. 确保 .env 含 API_SERVER_KEY
#   5. 必要时重启 Gateway（不带 --host，绑定地址取自 config.yaml）
#   6. 健康检查两个端口，打印两种连接模式的填写说明
#
# 用法：
#   sudo bash deploy.sh
#   HERMES_HOME=/opt/hermes BUDDY_PROXY_PORT=8811 BUDDY_CHANNEL_PORT=8822 bash deploy.sh
#   SHOW_KEYS=1 bash deploy.sh        # 打印完整上游密钥（默认打码）
# =============================================================================
set -euo pipefail

# 需要 root 才能动 systemd；非 root 且系统有 systemd 时自动 sudo 自提权。
# 关键：sudo 默认会清除环境变量，必须用 sudo -E 或 env 传递 BUDDY_UPSTREAM_* 变量，
# 否则用户在 Buddy UI 填的上游参数会丢失，导致 buddy-proxy.env 不写入 -> "上游未配置"。
if [[ $EUID -ne 0 ]] && command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  echo "[deploy] 当前非 root，自动 sudo 重新执行 deploy.sh …"
  exec sudo -E env \
    ${BUDDY_UPSTREAM_BASE:+BUDDY_UPSTREAM_BASE="$BUDDY_UPSTREAM_BASE"} \
    ${BUDDY_UPSTREAM_KEY:+BUDDY_UPSTREAM_KEY="$BUDDY_UPSTREAM_KEY"} \
    ${BUDDY_UPSTREAM_MODEL:+BUDDY_UPSTREAM_MODEL="$BUDDY_UPSTREAM_MODEL"} \
    ${BUDDY_PROXY_PORT:+BUDDY_PROXY_PORT="$BUDDY_PROXY_PORT"} \
    ${BUDDY_CHANNEL_PORT:+BUDDY_CHANNEL_PORT="$BUDDY_CHANNEL_PORT"} \
    ${HERMES_HOME:+HERMES_HOME="$HERMES_HOME"} \
    ${SHOW_KEYS:+SHOW_KEYS="$SHOW_KEYS"} \
    ${INSTALL_HERMES:+INSTALL_HERMES="$INSTALL_HERMES"} \
    ${HERMES_INDEX_URL:+HERMES_INDEX_URL="$HERMES_INDEX_URL"} \
    ${HERMES_EXTRA_INDEX_URL:+HERMES_EXTRA_INDEX_URL="$HERMES_EXTRA_INDEX_URL"} \
    ${HERMES_PKG:+HERMES_PKG="$HERMES_PKG"} \
    "$0" "$@"
fi

HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
PROXY_PORT="${BUDDY_PROXY_PORT:-8811}"
CHANNEL_PORT="${BUDDY_CHANNEL_PORT:-8822}"
SHOW_KEYS="${SHOW_KEYS:-0}"
INSTALL_HERMES="${INSTALL_HERMES:-0}"
HERMES_INDEX_URL="${HERMES_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
HERMES_EXTRA_INDEX_URL="${HERMES_EXTRA_INDEX_URL:-}"
HERMES_PKG="${HERMES_PKG:-hermes-agent}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROXY_SRC="$SCRIPT_DIR/buddy-inference-proxy.py"
CHANNEL_SRC="$SCRIPT_DIR/buddy-channel.py"

echo "============================================================"
echo " Hermes Buddy 服务端部署"
echo " HERMES_HOME = $HERMES_HOME"
echo " 推理代理端口 = $PROXY_PORT    WS 通道端口 = $CHANNEL_PORT"
echo "============================================================"

# ---- 0. 源文件必须存在 ----
if [[ ! -f "$PROXY_SRC" ]]; then
  echo "FATAL: 找不到 $PROXY_SRC（请确认压缩包已正确解压）" >&2
  exit 1
fi
if [[ ! -f "$CHANNEL_SRC" ]]; then
  echo "FATAL: 找不到 $CHANNEL_SRC（请确认压缩包已正确解压）" >&2
  exit 1
fi

mkdir -p "$HERMES_HOME/logs"

# ---- API_SERVER_KEY 探测 ----
PROXY_KEY=$(grep -E "^API_SERVER_KEY=" "$HERMES_HOME/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\r\n" || true)
if [[ -z "$PROXY_KEY" ]]; then
  PROXY_KEY=$(grep -E "API_SERVER_KEY" "$HERMES_HOME/data/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\r\n" || true)
fi
# 也检查 .api_server_key 文件
if [[ -z "$PROXY_KEY" ]]; then
  PROXY_KEY=$(cat "$HERMES_HOME/.api_server_key" 2>/dev/null | tr -d "\r\n" || true)
fi
# 如果还是空，生成一个新的
if [[ -z "$PROXY_KEY" ]]; then
  PROXY_KEY="sk-wb-$(head -c 32 /dev/urandom 2>/dev/null | xxd -p 2>/dev/null || python3 -c "import secrets; print(secrets.hex())")"
  echo "[deploy] API_SERVER_KEY 为空，已自动生成: ${PROXY_KEY:0:8}****"
fi

# ---- 在启动通道/代理之前，先把 API_SERVER_KEY 写入 .env 和 .api_server_key ----
# 这样通道启动时 expected_token() 就能读到正确的密钥，避免 401 握手拒绝。
ENV_FILE="$HERMES_HOME/.env"
API_KEY="$PROXY_KEY"
ENV_WRITTEN=0
EXISTING_KEY=$(grep -E "^API_SERVER_KEY=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\r\n" || true)
if [[ -z "$EXISTING_KEY" ]]; then
  if [[ -f "$ENV_FILE" ]]; then
    sed -i '/^API_SERVER_KEY=/d' "$ENV_FILE" 2>/dev/null || true
    echo "  .env 的 API_SERVER_KEY 为空或缺失，正在写入…"
    echo "API_SERVER_KEY=$API_KEY" >> "$ENV_FILE"
    ENV_WRITTEN=1
  else
    echo "  .env 不存在，正在创建并写入 API_SERVER_KEY…"
    echo "API_SERVER_KEY=$API_KEY" > "$ENV_FILE"
    ENV_WRITTEN=1
  fi
else
  echo "  .env 已包含有效的 API_SERVER_KEY"
  API_KEY="$EXISTING_KEY"
  PROXY_KEY="$EXISTING_KEY"
fi
# .api_server_key 文件（ssh-check 和 channel 的 expected_token 都会读这个）
echo -n "$API_KEY" > "$HERMES_HOME/.api_server_key" 2>/dev/null || true
echo "[deploy] API_SERVER_KEY 已就绪: ${API_KEY:0:8}****"

# ---- 统一的 Gateway 重启入口（绝不给 hermes gateway run 传 --host） ----
gw_running() { pgrep -f "hermes.*gateway" >/dev/null 2>&1; }
gw_restart() {
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q hermes-gateway; then
    systemctl restart hermes-gateway 2>&1 || true
  elif command -v hermes >/dev/null 2>&1; then
    if gw_running; then
      hermes gateway restart >> "$HERMES_HOME/gateway.log" 2>&1 || {
        hermes gateway stop 2>&1 || true; sleep 2
        nohup hermes gateway run >> "$HERMES_HOME/gateway.log" 2>&1 &
      }
    else
      nohup hermes gateway run >> "$HERMES_HOME/gateway.log" 2>&1 &
    fi
  else
    nohup python3 -m hermes_cli.main gateway run >> "$HERMES_HOME/gateway.log" 2>&1 &
  fi
  sleep 5
}

# =============================================================================
# 0. 完整部署：安装 Hermes 本体（仅 INSTALL_HERMES=1 时执行）
#    目标：在干净 Ubuntu 22.04+ 上先引导 Python/uv/pip 环境，再用隔离 venv
#          安装 hermes-agent 并拉起 Gateway（22122）。完全不碰系统/CUDA Python。
# =============================================================================

HERMES_VENV="$HERMES_HOME/venv"
UV_BIN=""
PY_BIN=""

ensure_python_uv() {
  echo "[env] 检查 Python / uv 环境…"
  if ! command -v python3 >/dev/null 2>&1; then
    echo "[env] 未找到 python3，尝试 apt 安装…"
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq || true
      if ! apt-get install -y -qq python3 python3-venv python3-pip; then
        echo "[env][WARN] apt 安装 python3 失败，无法继续安装 Hermes 本体"; return 1
      fi
    else
      echo "[env][WARN] 系统无 apt-get 且无 python3，无法继续安装 Hermes 本体"; return 1
    fi
  fi
  PY_BIN="$(command -v python3)"
  echo "[env] python3 = $PY_BIN ($($PY_BIN --version 2>&1))"

  # 无 uv 兜底时，确保 python3 自带 venv 模块（最小化 Ubuntu 可能没装 python3-venv）
  if [[ -z "$UV_BIN" ]]; then
    if ! "$PY_BIN" -m venv --help >/dev/null 2>&1; then
      echo "[env] python3 缺 venv 模块，尝试 apt 安装 python3-venv…"
      if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq || true
        apt-get install -y -qq python3-venv python3-pip || echo "[env][WARN] 安装 python3-venv 失败，pip 兜底可能不可用"
      fi
    fi
  fi

  # 优先用 uv（自带 Python 管理、隔离好、速度快）。
  # 注意：uv 官方安装器默认装到 ~/.local/bin，但该目录在 SSH 非交互会话里通常不在 PATH，
  # 导致“上次装好的 uv 这次 command -v 找不到”。先把 ~/.local/bin 加进 PATH 再探测。
  export PATH="$HOME/.local/bin:$PATH"
  if command -v uv >/dev/null 2>&1; then
    UV_BIN="$(command -v uv)"
  else
    echo "[env] 未找到 uv，尝试安装（官方安装器 -> ~/.local/bin/uv）…"
    if command -v curl >/dev/null 2>&1; then
      echo "[env] 下载 uv 官方安装器（astral.sh）…"
      if curl -LsSf https://astral.sh/uv/install.sh -o /tmp/uv-install.sh 2>&1; then
        sh /tmp/uv-install.sh 2>&1 | sed 's/^/  /' || echo "[env][WARN] uv 官方安装器执行失败（常见：内网无外网 / 代理拦截 astral.sh）"
      else
        echo "[env][WARN] 无法下载 astral.sh/uv/install.sh（内网/代理不可达），改走 pip 兜底"
      fi
    fi
    # 官方安装器失败时用 pip3 装到用户目录（走已配置的 PyPI 源，内网镜像通常可达）
    if [[ ! -x "$HOME/.local/bin/uv" ]] && command -v pip3 >/dev/null 2>&1; then
      echo "[env] 尝试 pip3 install --user uv（走已配置 PyPI 源）…"
      pip3 install --user -q uv 2>&1 | sed 's/^/  /' || echo "[env][WARN] pip3 安装 uv 也失败"
    fi
    # PATH 已含 ~/.local/bin，重新探测；仍找不到就退回 pip + venv
    UV_BIN="$(command -v uv 2>/dev/null || true)"
  fi
  if [[ -n "$UV_BIN" && -x "$UV_BIN" ]]; then
    echo "[env] uv = $UV_BIN ($("$UV_BIN" --version 2>&1))"
  else
    echo "[env] uv 不可用，将退回 pip + venv"
    UV_BIN=""
  fi
  return 0
}

generate_hermes_config() {
  local cfg="$HERMES_HOME/config.yaml"
  if [[ -f "$cfg" ]]; then
    echo "[deploy] 已存在 $cfg，保留不覆盖（如需重建请先删除）"
    return 0
  fi
  {
    echo "# 由 Buddy 完整部署自动生成"
    echo "model:"
    [[ -n "$BUDDY_UPSTREAM_MODEL" ]] && echo "  name: $BUDDY_UPSTREAM_MODEL"
    if [[ -n "$BUDDY_UPSTREAM_BASE" ]]; then
      echo "  provider: custom"
      echo "  base_url: $BUDDY_UPSTREAM_BASE"
    fi
    [[ -n "$BUDDY_UPSTREAM_KEY" ]] && echo "  api_key: $BUDDY_UPSTREAM_KEY"
    echo ""
    echo "platforms:"
    echo "  api_server:"
    echo "    enabled: true"
    echo "    extra:"
    echo "      host: 0.0.0.0"
    echo "      port: 22122"
  } > "$cfg"
  echo "[deploy] 已生成 $cfg（Gateway 绑定 0.0.0.0:22122）"
}

register_hermes_gateway() {
  local gw_bin="$HERMES_VENV/bin/hermes"
  local gw_exec
  if [[ -x "$gw_bin" ]]; then
    gw_exec="$gw_bin gateway run"
  else
    gw_exec="$HERMES_VENV/bin/python -m hermes_cli.main gateway run"
  fi
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    cat > /etc/systemd/system/hermes-gateway.service <<SVCEOF
[Unit]
Description=Hermes Agent Gateway
After=network.target

[Service]
Type=simple
Environment=HERMES_HOME=$HERMES_HOME
ExecStart=$gw_exec
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
SVCEOF
    systemctl daemon-reload 2>&1 | sed 's/^/  /' || true
    systemctl enable hermes-gateway 2>&1 | sed 's/^/  /' || true
    systemctl restart hermes-gateway 2>&1 | sed 's/^/  /' || true
    sleep 5
    systemctl is-active hermes-gateway 2>&1 | sed 's/^/  /' || true
  else
    nohup "$HERMES_VENV/bin/python" -m hermes_cli.main gateway run >> "$HERMES_HOME/gateway.log" 2>&1 &
    sleep 5
  fi
  # 必须确认 22122 真的在监听，否则视为失败（防止 Gateway 启动即崩溃被误判成功）
  local ok=0
  for _ in $(seq 1 45); do
    if (command -v curl >/dev/null && curl -fsS -o /dev/null "http://127.0.0.1:22122/health" 2>/dev/null) \
       || (command -v wget >/dev/null && wget -q -O /dev/null "http://127.0.0.1:22122/health" 2>/dev/null) \
       || "$HERMES_VENV/bin/python" -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:22122/health',timeout=2); sys.exit(0)" 2>/dev/null; then
      ok=1; break
    fi
    sleep 2
  done
  if [[ "$ok" != "1" ]]; then
    echo "[deploy][FAIL] Hermes Gateway 拉起后 22122 未在监听（Gateway 可能启动即崩溃）"
    if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
      echo "[deploy] ---- hermes-gateway 服务状态 ----"
      systemctl status hermes-gateway --no-pager 2>&1 | sed 's/^/  /' | head -20
      echo "[deploy] ---- hermes-gateway 最近日志（journalctl）----"
      journalctl -u hermes-gateway --no-pager -n 30 2>&1 | sed 's/^/  /'
    else
      echo "[deploy] ---- gateway.log 末尾 ----"
      tail -30 "$HERMES_HOME/gateway.log" 2>&1 | sed 's/^/  /'
    fi
    return 1
  fi
  echo "[deploy] Hermes Gateway 已在 22122 监听（/health OK）"
  return 0
}

install_hermes() {
  echo ""
  echo "[deploy] ---- 安装 Hermes 本体（完整部署前置）----"
  if ! ensure_python_uv; then
    echo "[deploy][FAIL] 环境准备失败（python3/uv 缺失且无法安装），Hermes 无法安装"
    return 1
  fi
  mkdir -p "$HERMES_VENV"
  if [[ -n "$UV_BIN" ]]; then
    "$UV_BIN" venv "$HERMES_VENV" >/dev/null 2>&1 || "$PY_BIN" -m venv "$HERMES_VENV" || {
      echo "[deploy][FAIL] venv 创建失败，Hermes 无法安装"; return 1; }
  else
    "$PY_BIN" -m venv "$HERMES_VENV" || {
      echo "[deploy][FAIL] venv 创建失败，Hermes 无法安装"; return 1; }
  fi
  local idx_args=""
  [[ -n "$HERMES_INDEX_URL" ]] && idx_args="$idx_args --index-url $HERMES_INDEX_URL"
  [[ -n "$HERMES_EXTRA_INDEX_URL" ]] && idx_args="$idx_args --extra-index-url $HERMES_EXTRA_INDEX_URL"
  # 内部/私有镜像常是 HTTP 或自签证书：
  #   pip 用 --trusted-host（仅 http 需要）
  #   uv 用 --allow-insecure-host（新版 uv ≥0.5）或 --allow-insecure（旧版），按版本探测
  # 注意：https 有效证书源（如清华）不要加任何不安全参数，否则新版 uv 会因未知参数报错
  local trust_pip="" trust_uv=""
  local uv_insecure_flag="--allow-insecure"
  if [[ -n "$UV_BIN" ]] && "$UV_BIN" pip install --help 2>&1 | grep -q -- '--allow-insecure-host'; then
    uv_insecure_flag="--allow-insecure-host"
  fi
  for u in "$HERMES_INDEX_URL" "$HERMES_EXTRA_INDEX_URL"; do
    [[ -n "$u" ]] || continue
    case "$u" in
      http://*)
        local h="${u#*://}"; h="${h%%/*}"; h="${h%:*}"   # 取 host（去 scheme/path/port）
        trust_pip="$trust_pip --trusted-host $h"
        trust_uv="$trust_uv $uv_insecure_flag $h"
        ;;
    esac
  done
  echo "[deploy] 在隔离 venv 安装 $HERMES_PKG（索引: ${HERMES_INDEX_URL:-PyPI}）…"
  if [[ -n "$UV_BIN" ]]; then
    if ! "$UV_BIN" pip install --python "$HERMES_VENV/bin/python" $idx_args $trust_uv -U pip "$HERMES_PKG" 2>&1 | sed 's/^/  /'; then
      echo "[deploy][FAIL] uv 安装 $HERMES_PKG 失败（检查索引/网络/代理证书）"
      return 1
    fi
  else
    if ! "$HERMES_VENV/bin/python" -m pip install $idx_args $trust_pip -U pip "$HERMES_PKG" 2>&1 | sed 's/^/  /'; then
      echo "[deploy][FAIL] pip 安装 $HERMES_PKG 失败（检查索引/网络/代理证书）"
      return 1
    fi
  fi
  # hermes-agent 的 api_server 适配器需要 aiohttp，但它只出现在 extras 里、不在基础依赖中。
  # 不装的话 Gateway 进程能起来，但 22122 不提供 HTTP 服务（Buddy 连上后 fetch failed）。
  # 这里显式补齐 aiohttp（版本对齐 hermes-agent extras 中声明的 3.14.1）。
  echo "[deploy] 确保 api_server 适配器依赖 aiohttp 已安装…"
  if [[ -n "$UV_BIN" ]]; then
    "$UV_BIN" pip install --python "$HERMES_VENV/bin/python" $idx_args $trust_uv aiohttp==3.14.1 2>&1 | sed 's/^/  /' || \
      "$UV_BIN" pip install --python "$HERMES_VENV/bin/python" aiohttp 2>&1 | sed 's/^/  /'
  else
    "$HERMES_VENV/bin/python" -m pip install $idx_args $trust_pip aiohttp==3.14.1 2>&1 | sed 's/^/  /' || \
      "$HERMES_VENV/bin/python" -m pip install aiohttp 2>&1 | sed 's/^/  /'
  fi
  # 安装后必须验证 Hermes 真的可用，否则视为失败（防止空 venv 被误判成功）
  if [[ ! -x "$HERMES_VENV/bin/hermes" ]] && ! "$HERMES_VENV/bin/python" -c "import hermes_agent" >/dev/null 2>&1; then
    echo "[deploy][FAIL] $HERMES_PKG 安装后未找到 hermes 命令/模块，安装不完整"
    return 1
  fi
  echo "[deploy] $HERMES_PKG 已装入 $HERMES_VENV"
  generate_hermes_config
  if ! register_hermes_gateway; then
    echo "[deploy][FAIL] Hermes 本体已装入 venv，但 Gateway 拉起失败，完整部署未完成"
    return 1
  fi
  echo "[deploy] Hermes 本体安装完成（Gateway 22122 已监听）"
  return 0
}

if [[ "$INSTALL_HERMES" == "1" ]]; then
  if ! install_hermes; then
    HERMES_INSTALL_FAILED=1
    echo "[deploy][FAIL] Hermes 本体安装失败，完整部署未完成（外挂组件仍会部署）。请排查后重新执行完整部署。"
  fi
fi

# =============================================================================
# 1. 部署推理直通代理（端口 8811）
# =============================================================================
echo ""
echo "[deploy] ---- 1/4 部署推理直通代理（$PROXY_PORT）----"
PROXY_FILE="$HERMES_HOME/buddy-inference-proxy.py"
# 先清掉旧文件，确保干净部署（避免旧版本残留导致通道/代理行为异常）
rm -f "$PROXY_FILE"
cp "$PROXY_SRC" "$PROXY_FILE"
chmod +x "$PROXY_FILE"
echo "  已写入 $PROXY_FILE"

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  cat > /etc/systemd/system/hermes-buddy-inference.service <<SVCEOF
[Unit]
Description=Hermes Buddy inference pass-through proxy
After=network.target

[Service]
Type=simple
Environment=HERMES_HOME=$HERMES_HOME
Environment=BUDDY_PROXY_PORT=$PROXY_PORT
ExecStart=/usr/bin/env python3 $PROXY_FILE
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
SVCEOF
  pkill -f "buddy-inference-proxy.py" 2>/dev/null || true
  sleep 1
  systemctl daemon-reload 2>&1 | sed 's/^/  /' || true
  systemctl enable hermes-buddy-inference 2>&1 | sed 's/^/  /' || true
  systemctl restart hermes-buddy-inference 2>&1 | sed 's/^/  /' || true
  sleep 3
  systemctl is-active hermes-buddy-inference 2>&1 | sed 's/^/  /' || true
else
  pkill -f "buddy-inference-proxy.py" 2>/dev/null || true
  nohup python3 "$PROXY_FILE" >> "$HERMES_HOME/logs/buddy-proxy.log" 2>&1 &
  sleep 3
fi

# =============================================================================
# 2. 部署 WS 工具通道（端口 8822，外挂组件）
# =============================================================================
echo ""
echo "[deploy] ---- 2/4 部署 WS 工具通道（$CHANNEL_PORT）----"
CHANNEL_FILE="$HERMES_HOME/buddy-channel.py"
# 先清掉旧文件，确保干净部署（覆盖掉任何旧版 buddy-channel.py，避免断连 bug 残留）
rm -f "$CHANNEL_FILE"
cp "$CHANNEL_SRC" "$CHANNEL_FILE"
chmod +x "$CHANNEL_FILE"
echo "  已写入 $CHANNEL_FILE （复用同一份 API_SERVER_KEY 鉴权）"

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  cat > /etc/systemd/system/hermes-buddy-channel.service <<SVCEOF
[Unit]
Description=Hermes Buddy WS tool channel (external component)
After=network.target

[Service]
Type=simple
Environment=HERMES_HOME=$HERMES_HOME
Environment=BUDDY_CHANNEL_PORT=$CHANNEL_PORT
ExecStart=/usr/bin/env python3 $CHANNEL_FILE
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
SVCEOF
  # 先杀掉旧进程（即使 systemctl restart 也会做这步，但显式 kill 更保险）
  pkill -f "buddy-channel.py" 2>/dev/null || true
  sleep 1
  systemctl daemon-reload 2>&1 | sed 's/^/  /' || true
  systemctl enable hermes-buddy-channel 2>&1 | sed 's/^/  /' || true
  # 必须显式 restart：enable --now 在服务已运行时不会重载新代码，导致旧断连 bug 一直残留
  systemctl restart hermes-buddy-channel 2>&1 | sed 's/^/  /' || true
  sleep 3
  systemctl is-active hermes-buddy-channel 2>&1 | sed 's/^/  /' || true
else
  pkill -f "buddy-channel.py" 2>/dev/null || true
  nohup python3 "$CHANNEL_FILE" >> "$HERMES_HOME/logs/buddy-channel.log" 2>&1 &
  sleep 3
fi

# =============================================================================
# 3. 探测上游并完成 function-calling 实测，写 buddy-proxy.env
# =============================================================================
echo ""
echo "[deploy] ---- 3/4 探测上游并实测 function calling ----"
HERMES_HOME="$HERMES_HOME" BUDDY_PROXY_PORT="$PROXY_PORT" BUDDY_PROXY_KEY="$PROXY_KEY" SHOW_KEYS="$SHOW_KEYS" python3 - <<'PYTEST' 2>&1 | sed 's/^/  /' || true
import json, os, re, sys, urllib.request, urllib.error

HOME = os.environ.get("HERMES_HOME", "/root/.hermes")
PORT = os.environ.get("BUDDY_PROXY_PORT", "8811")
PROXY_KEY = os.environ.get("BUDDY_PROXY_KEY", "")
SHOW = os.environ.get("SHOW_KEYS", "0") == "1"

def read_env(path):
    d = {}
    try:
        for line in open(path, encoding="utf-8", errors="replace"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                d[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return d

def load_cfg(path):
    try:
        import yaml
        d = yaml.safe_load(open(path, encoding="utf-8"))
        if isinstance(d, dict):
            return d
    except Exception:
        pass
    return {}

def find_key(obj, keys, depth=0):
    if depth > 4:
        return ""
    if isinstance(obj, dict):
        for k in keys:
            v = obj.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        for v in obj.values():
            r = find_key(v, keys, depth + 1)
            if r:
                return r
    elif isinstance(obj, list):
        for v in obj[:10]:
            r = find_key(v, keys, depth + 1)
            if r:
                return r
    return ""

env = read_env(os.path.join(HOME, ".env"))
cfg = load_cfg(os.path.join(HOME, "config.yaml"))
model = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}

# If model.provider is set, look it up in the providers list first.
provider_name = model.get("provider") or ""
provider_match = {}
if provider_name:
    for pk in ("custom_providers", "providers"):
        plist = cfg.get(pk) if isinstance(cfg.get(pk), list) else None
        if not plist:
            continue
        for p in plist:
            if isinstance(p, dict) and (p.get("name") == provider_name or p.get("id") == provider_name):
                provider_match = p
                break
        if provider_match:
            break

def expand(s):
    return re.sub(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?", lambda m: env.get(m.group(1)) or os.environ.get(m.group(1)) or "", s or "")

base = expand(provider_match.get("base_url") or provider_match.get("base-url") or model.get("base_url") or model.get("base-url") or model.get("endpoint") or env.get("OPENAI_BASE_URL") or "").rstrip("/")
if not base:
    base = expand(find_key(cfg, ["base_url", "base-url", "endpoint"]) or "").rstrip("/")
name = expand(provider_match.get("model") or model.get("name") or model.get("model") or model.get("default") or env.get("OPENAI_MODEL") or "hermes-agent")
key = expand(provider_match.get("api_key") or provider_match.get("apiKey") or model.get("api_key") or model.get("apiKey") or "")
if not key:
    key = expand(find_key(model, ["api_key", "apiKey", "key", "token"]) or "")
if not key:
    for hint in ("ARK_API_KEY", "OPENAI_API_KEY", "CUSTOM_API_KEY", "LLM_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "DASHSCOPE_API_KEY"):
        if env.get(hint):
            key = env[hint]
            break

def mask(s):
    return (s[:4] + "****" + s[-4:]) if s and len(s) > 10 else ("****" if s else "(空)")

print("上游 base_url :", base or "(未找到)")
print("上游 model    :", name)
print("上游 api_key  :", key if SHOW else mask(key))

# 如果上游参数由用户在 Buddy UI 显式提供（环境变量），直接写入 buddy-proxy.env，
# 跳过 FC 探测（探测在新装机器上可能因网络/时延失败，但用户填的就是要用的）。
# 关键：这个检查必须在 "if not base or not key: sys.exit(0)" 之前，
# 否则全新部署（config.yaml 没有上游配置）时 base/key 为空，脚本提前退出，
# 永远到不了 FORCE_WRITE -> buddy-proxy.env 不写入 -> "上游未配置"。
FORCE_WRITE = bool(os.environ.get("BUDDY_UPSTREAM_BASE") and os.environ.get("BUDDY_UPSTREAM_KEY"))
if FORCE_WRITE:
    # 用户提供的值优先于 config.yaml 发现的值
    base = os.environ.get("BUDDY_UPSTREAM_BASE", "").rstrip("/")
    key = os.environ.get("BUDDY_UPSTREAM_KEY", "")
    name = os.environ.get("BUDDY_UPSTREAM_MODEL", "") or name or "hermes-agent"
    chat_path = ""
    if base.endswith("/chat/completions"):
        chat_path = ""
    elif re.search(r"/v\d+$", base):
        chat_path = "/chat/completions"
    else:
        chat_path = "/v1/chat/completions"
    with open(os.path.join(HOME, "buddy-proxy.env"), "w", encoding="utf-8") as f:
        f.write("BUDDY_UPSTREAM_BASE=%s\n" % base)
        f.write("BUDDY_UPSTREAM_CHAT_PATH=%s\n" % chat_path)
        f.write("BUDDY_UPSTREAM_MODEL=%s\n" % name)
        f.write("BUDDY_UPSTREAM_KEY=%s\n" % key)
    print("已写入 " + HOME + "/buddy-proxy.env（用户提供的上游参数，跳过 FC 探测）")
    print("  base_url =", base)
    print("  model    =", name)
    print("  api_key  :", key if SHOW else mask(key))
    # 仍然试一下 FC，但不阻断
    purl = "http://127.0.0.1:%s/v1/chat/completions" % PORT
    j, err = fc_test(purl, PROXY_KEY or key, name, True)
    if err:
        print("经代理 FC 测试失败（不影响部署）: %s" % err[:150])
    else:
        fn, txt = got_tool(j)
        print("经代理 %s -> %s" % (purl, ("tool_calls: " + fn) if fn else ("无 tool_calls: " + txt)))
    sys.exit(0)

if not base or not key:
    print("!! 拿不到上游 base_url 或 api_key，无法自动部署。")
    print("!! 请手工写入 " + HOME + "/buddy-proxy.env：")
    print("!!   BUDDY_UPSTREAM_BASE=<上游 OpenAI 兼容地址>")
    print("!!   BUDDY_UPSTREAM_KEY=<上游密钥>")
    print("!!   BUDDY_UPSTREAM_MODEL=<模型名>")
    sys.exit(0)

bases = [base]
if "/api/coding/" in base:
    bases.append(base.replace("/api/coding/", "/api/"))
if "/api/v3" in base and "/api/coding" not in base:
    bases.append(base.replace("/api/v3", "/api/coding/v3"))
uniq = []
for b in bases:
    if b not in uniq:
        uniq.append(b)
cands = []
for b in uniq:
    if b.endswith("/chat/completions"):
        cands.append((b, ""))
    else:
        for p in ("/chat/completions", "/v1/chat/completions", "/openai/chat/completions"):
            cands.append((b, p))

TOOLS = [{"type": "function", "function": {"name": "probe_tool", "description": "probe", "parameters": {"type": "object", "properties": {}, "required": []}}}]

def fc_test(url, api_key, model_name, force=True):
    body = {"model": model_name, "messages": [{"role": "user", "content": "Call probe_tool now."}], "tools": TOOLS, "max_tokens": 64}
    if force:
        body["tool_choice"] = "required"
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + api_key})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.loads(r.read().decode("utf-8", "replace")), None
    except urllib.error.HTTPError as e:
        return None, "HTTP %s: %s" % (e.code, e.read()[:200].decode("utf-8", "replace"))
    except Exception as e:
        return None, str(e)

def got_tool(j):
    try:
        msg = (j.get("choices") or [{}])[0].get("message") or {}
    except Exception:
        return None, ""
    tc = msg.get("tool_calls")
    if tc:
        return tc[0]["function"]["name"], ""
    return None, (msg.get("content") or "")[:100]

chosen = None
for b, p in cands:
    url = b if p == "" else b + p
    j, err = fc_test(url, key, name, True)
    if err:
        print("   x %s -> %s" % (url, err[:130]))
        continue
    fn, txt = got_tool(j)
    if fn:
        print("   OK %s -> tool_calls: %s" % (url, fn))
        chosen = (b, p)
        break
    j2, err2 = fc_test(url, key, name, False)
    if not err2:
        fn2, _ = got_tool(j2)
        if fn2:
            print("   OK %s -> tool_calls(auto): %s" % (url, fn2))
            chosen = (b, p)
            break
    print("   ~ %s -> 通但没有 tool_calls: %s" % (url, txt))

if not chosen:
    print("!! 所有候选路径都拿不到 tool_calls —— 该上游可能不支持 function calling。")
    print("!! Buddy 的本地工具链路必须靠 FC，请换一个支持 function calling 的模型。")
    sys.exit(0)

with open(os.path.join(HOME, "buddy-proxy.env"), "w", encoding="utf-8") as f:
    f.write("BUDDY_UPSTREAM_BASE=%s\n" % chosen[0])
    f.write("BUDDY_UPSTREAM_CHAT_PATH=%s\n" % chosen[1])
    f.write("BUDDY_UPSTREAM_MODEL=%s\n" % name)
    f.write("BUDDY_UPSTREAM_KEY=%s\n" % key)
print("已写入 " + HOME + "/buddy-proxy.env（上游密钥只存在服务端）")

purl = "http://127.0.0.1:%s/v1/chat/completions" % PORT
j, err = fc_test(purl, PROXY_KEY or key, name, True)
if err:
    print("!! 经代理失败: %s" % err[:220])
else:
    fn, txt = got_tool(j)
    print("经代理 %s -> %s" % (purl, ("tool_calls: " + fn) if fn else ("无 tool_calls: " + txt)))
PYTEST

# =============================================================================
# 4. 重启 Gateway（使 API_SERVER_KEY 生效）+ 重启通道（使通道读到最新密钥）
# =============================================================================
echo ""
echo "[deploy] ---- 4/4 重启 Gateway + 通道服务 ----"
if [[ "$ENV_WRITTEN" == "1" ]]; then
  echo "  重启 Gateway 使 API_SERVER_KEY 生效…"
  gw_restart
  # Gateway 重启后可能改写 .env 里的 API_SERVER_KEY，重新读取
  NEW_KEY=$(grep -E "^API_SERVER_KEY=" "$HERMES_HOME/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\r\n" || true)
  if [[ -n "$NEW_KEY" && "$NEW_KEY" != "$API_KEY" ]]; then
    API_KEY="$NEW_KEY"
    echo -n "$API_KEY" > "$HERMES_HOME/.api_server_key" 2>/dev/null || true
    echo "  Gateway 重启后 API_SERVER_KEY 已更新: ${API_KEY:0:8}****"
  fi
fi
# 无论 .env 是否被写入，都重启通道服务，确保它读到最新的 API_SERVER_KEY
# （之前通道在第 2 步启动时可能读到了空/旧密钥，这里强制刷新）
if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  echo "  重启通道服务使密钥生效…"
  systemctl restart hermes-buddy-channel 2>&1 | sed 's/^/  /' || true
  sleep 2
  systemctl is-active hermes-buddy-channel 2>&1 | sed 's/^/  /' || true
fi

# =============================================================================
# 健康检查 + 结论
# =============================================================================
echo ""
echo "============================================================"
echo " 健康检查"
echo "============================================================"
PROXY_UP=0
if curl -s -m 5 "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1; then PROXY_UP=1; fi
CHANNEL_UP=0
CHANNEL_HEALTH=""
if command -v curl >/dev/null 2>&1; then
  CHANNEL_HEALTH=$(curl -s -m 5 "http://127.0.0.1:${CHANNEL_PORT}/health" 2>/dev/null || true)
  if [[ -n "$CHANNEL_HEALTH" ]]; then CHANNEL_UP=1; fi
fi
CHANNEL_VERSION_EXPECTED="1.2"

if [[ "$PROXY_UP" == "1" ]]; then
  echo "  [OK] 推理直通代理  : http://0.0.0.0:$PROXY_PORT  (用 Gateway API Key 鉴权)"
else
  echo "  [WARN] 推理直通代理未监听 $PROXY_PORT。日志："
  tail -n 15 "$HERMES_HOME/logs/buddy-proxy.log" 2>/dev/null || true
fi
if [[ "$CHANNEL_UP" == "1" ]]; then
  CHANNEL_VERSION_ACTUAL=$(echo "$CHANNEL_HEALTH" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version","unknown"))' 2>/dev/null || echo "unknown")
  if [[ "$CHANNEL_VERSION_ACTUAL" == "$CHANNEL_VERSION_EXPECTED" ]]; then
    echo "  [OK] WS 工具通道    : ws://0.0.0.0:$CHANNEL_PORT/api/buddy/channel (version $CHANNEL_VERSION_ACTUAL)"
  else
    echo "  [WARN] WS 工具通道已启动，但版本 $CHANNEL_VERSION_ACTUAL 与期望 $CHANNEL_VERSION_EXPECTED 不符。"
    echo "         说明旧进程仍在运行，请手动执行：sudo systemctl restart hermes-buddy-channel"
  fi
else
  echo "  [WARN] WS 工具通道未监听 $CHANNEL_PORT。日志："
  tail -n 15 "$HERMES_HOME/logs/buddy-channel.log" 2>/dev/null || true
fi

echo ""
echo "============================================================"
echo " Buddy 连接填写说明"
echo "============================================================"
echo "  在 Buddy 客户端连接页填写："
echo "      Hermes 主机 : <HERMES_HOST>"
echo "      API Key      : $API_KEY"
echo "      通道地址(选填，默认自动推导) :"
echo "      ws://<HERMES_HOST>:$CHANNEL_PORT/api/buddy/channel"
echo "  · 决策在 Hermes 服务器，本机只执行被护栏放行的工具"
echo "  · 上游供应商由服务端持有，密钥不出服务器"
echo "  · 禁止填 http://<HERMES_HOST>:22122/v1/chat/completions（服务端 agent 端点）"
echo "============================================================"
