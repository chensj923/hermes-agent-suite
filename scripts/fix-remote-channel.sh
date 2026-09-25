#!/usr/bin/env bash
#
# fix-remote-channel.sh —— Hermes 服务端「通道脚本过旧」自助修复脚本
#
# 症状（Buddy 客户端「检查并连接」页面会报）：
#   [check] 通道版本: 2.3 (build 12)（脚本过旧，需要 build 14+）
#   [check] 部署后通道脚本仍过旧（build 12），请到服务器上手动重跑 deploy.sh。
#
# 根因：客户端安装包内嵌的 server-deploy/hermes-buddy-server-deploy.tar.gz
#   是构建时打进去的快照。如果那次构建前没有重跑
#   apps/hermes-buddy-desktop/scripts/build-server-deploy-bundle.js，
#   一键部署推上去的就还是旧脚本 —— 于是「部署成功」但版本永远不变。
#
# 本脚本绕过客户端安装包，直接以仓库中的单一事实源
#   packages/hermes-buddy-channel/buddy-channel.py
# 为准，上传到服务器、备份旧文件、重启通道服务，并校验运行中的 build。
#
# 用法（Git Bash / WSL / Linux / macOS）：
#   bash scripts/fix-remote-channel.sh --host 192.168.0.246
#   bash scripts/fix-remote-channel.sh --host 192.168.0.246 --key ~/.ssh/Chensj-8192
#   bash scripts/fix-remote-channel.sh --host 10.0.0.5 --user root --port 22 --no-proxy
#
# 参数：
#   --host <ip|域名>     必填，Hermes 服务器地址
#   --user <用户名>      默认 root
#   --port <端口>        默认 22
#   --key <私钥路径>     默认使用系统 ssh 默认密钥 / ssh-agent / ~/.ssh/config
#   --expect <build>     期望达到的通道 build；默认读取仓库脚本自带的值
#   --dir <远端目录>     默认 /root/.hermes
#   --no-proxy           只更新通道脚本，不更新推理直通代理（8811）
#   --dry-run            只显示将要执行的操作，不实际修改
#
# 退出码：0 修复成功且校验通过；非 0 表示失败（脚本会原样保留服务器上的备份）。

set -euo pipefail

HOST=""; REMOTE_USER="root"; PORT="22"; KEY=""; EXPECT=""
REMOTE_DIR="/root/.hermes"; UPDATE_PROXY=1; DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --user) REMOTE_USER="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --expect) EXPECT="$2"; shift 2 ;;
    --dir) REMOTE_DIR="$2"; shift 2 ;;
    --no-proxy) UPDATE_PROXY=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "未知参数: $1（用 --help 查看用法）" >&2; exit 2 ;;
  esac
done

if [ -z "$HOST" ]; then
  echo "错误：必须用 --host 指定服务器地址" >&2; exit 2
fi

# 定位仓库根（scripts/ 的上一级）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CHANNEL_SRC="$REPO_ROOT/packages/hermes-buddy-channel/buddy-channel.py"
PROXY_SRC="$REPO_ROOT/packages/hermes-buddy-proxy/buddy-inference-proxy.py"
CHANNEL_FALLBACK="$REPO_ROOT/apps/hermes-buddy-desktop/src/buddy-channel.py"
PROXY_FALLBACK="$REPO_ROOT/apps/hermes-buddy-desktop/src/buddy-inference-proxy.py"

# 事实源优先取 packages/；缺失时回退到安装包副本
[ -f "$CHANNEL_SRC" ] || CHANNEL_SRC="$CHANNEL_FALLBACK"
[ -f "$PROXY_SRC" ] || PROXY_SRC="$PROXY_FALLBACK"

if [ ! -f "$CHANNEL_SRC" ]; then
  echo "错误：找不到 buddy-channel.py（已尝试 packages/ 与 apps/*/src/）" >&2; exit 2
fi

SRC_BUILD="$(grep -m1 -oE 'CHANNEL_BUILD = "[0-9]+"' "$CHANNEL_SRC" | grep -oE '[0-9]+' || true)"
SRC_VERSION="$(grep -m1 -oE 'CHANNEL_VERSION = "[0-9.]+"' "$CHANNEL_SRC" | grep -oE '[0-9.]+' || true)"
if [ -z "$SRC_BUILD" ]; then
  echo "错误：无法从 $CHANNEL_SRC 解析 CHANNEL_BUILD" >&2; exit 2
fi
TARGET_BUILD="${EXPECT:-$SRC_BUILD}"

echo "============================================================"
echo " Hermes 服务端通道脚本修复"
echo "============================================================"
echo "目标服务器 : $REMOTE_USER@$HOST:$PORT"
echo "远端目录   : $REMOTE_DIR"
echo "本地脚本   : $CHANNEL_SRC"
echo "脚本版本   : version $SRC_VERSION / build $SRC_BUILD"
echo "期望 build : $TARGET_BUILD"
echo "同步代理   : $([ "$UPDATE_PROXY" = "1" ] && echo '是（8811）' || echo '否')"
echo "------------------------------------------------------------"

SSH_OPTS=(-o "StrictHostKeyChecking=no" -o "ConnectTimeout=10" -o "BatchMode=yes")
SCP_OPTS=(-o "StrictHostKeyChecking=no" -o "ConnectTimeout=10" -o "BatchMode=yes")
if [ -n "$KEY" ]; then
  SSH_OPTS+=(-i "$KEY")
  SCP_OPTS+=(-i "$KEY")
fi

# 1) 连通性 + 远端现状探查
echo "[1/5] 检查 SSH 连通性与服务端现状…"
REMOTE_STATE="$(ssh "${SSH_OPTS[@]}" -p "$PORT" "$REMOTE_USER@$HOST" '
  D="'"$REMOTE_DIR"'"
  echo "dir:$([ -d "$D" ] && echo yes || echo no)"
  if [ -f "$D/buddy-channel.py" ]; then
    B=$(grep -m1 -oE "CHANNEL_BUILD = \"[0-9]+\"" "$D/buddy-channel.py" | grep -oE "[0-9]+" || echo 0)
    echo "build:$B"
  else
    echo "build:missing"
  fi
  echo "service:$(systemctl list-unit-files 2>/dev/null | grep -c "hermes-buddy-channel.service" || echo 0)"
  echo "health:$(curl -s -m 3 http://127.0.0.1:8822/health 2>/dev/null | head -c 300)"
')" || { echo "错误：SSH 连接失败，请确认主机在线、密钥/口令可用" >&2; exit 1; }

CUR_BUILD="$(echo "$REMOTE_STATE" | sed -n 's/^build://p' | head -1)"
HAS_SERVICE="$(echo "$REMOTE_STATE" | sed -n 's/^service://p' | head -1)"
echo "      远端目录存在: $(echo "$REMOTE_STATE" | sed -n 's/^dir://p' | head -1)"
echo "      当前 build  : ${CUR_BUILD:-未知}"
echo "      通道服务    : $([ "${HAS_SERVICE:-0}" != "0" ] && echo 'systemd 已注册' || echo '未注册（将按进程方式重启）')"

if [ "${CUR_BUILD:-0}" = "$TARGET_BUILD" ] && [ -z "$EXPECT" ]; then
  echo "      已是目标 build，仍将继续强制同步（保证与仓库事实源一致）。"
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] 到此为止，未做任何修改。"
  exit 0
fi

# 2) 上传
TS="$(date +%Y%m%d%H%M%S)"
TMP="/tmp/hermes-fix-$TS"
echo "[2/5] 上传脚本到远端临时目录 $TMP …"
ssh "${SSH_OPTS[@]}" -p "$PORT" "$REMOTE_USER@$HOST" "mkdir -p $TMP"
scp "${SCP_OPTS[@]}" -P "$PORT" "$CHANNEL_SRC" "$REMOTE_USER@$HOST:$TMP/buddy-channel.py" >/dev/null
if [ "$UPDATE_PROXY" = "1" ] && [ -f "$PROXY_SRC" ]; then
  scp "${SCP_OPTS[@]}" -P "$PORT" "$PROXY_SRC" "$REMOTE_USER@$HOST:$TMP/buddy-inference-proxy.py" >/dev/null
fi

# 3) 备份 + 覆盖（heredoc 走 ssh stdin，参数用 `bash -s --` 传入）
echo "[3/5] 备份旧脚本并覆盖…"
APPLY_OUT="$(ssh "${SSH_OPTS[@]}" -p "$PORT" "$REMOTE_USER@$HOST" \
  "bash -s -- $TMP $REMOTE_DIR $UPDATE_PROXY $TS" <<'EOS'
set -e
TMP="$1"; D="$2"; UPDATE_PROXY="$3"; TS="$4"
mkdir -p "$D"
if [ -f "$D/buddy-channel.py" ]; then
  cp -f "$D/buddy-channel.py" "$D/buddy-channel.py.bak-$TS"
  echo "backup:$D/buddy-channel.py.bak-$TS"
else
  echo "backup:none（远端原本没有通道脚本）"
fi
cp -f "$TMP/buddy-channel.py" "$D/buddy-channel.py"
chmod 755 "$D/buddy-channel.py"
if [ "$UPDATE_PROXY" = "1" ] && [ -f "$TMP/buddy-inference-proxy.py" ]; then
  if [ -f "$D/buddy-inference-proxy.py" ]; then
    cp -f "$D/buddy-inference-proxy.py" "$D/buddy-inference-proxy.py.bak-$TS"
  fi
  cp -f "$TMP/buddy-inference-proxy.py" "$D/buddy-inference-proxy.py"
  chmod 755 "$D/buddy-inference-proxy.py"
  echo "proxy:updated"
else
  echo "proxy:skipped"
fi
echo "installed_build:$(grep -m1 -oE 'CHANNEL_BUILD = \"[0-9]+\"' "$D/buddy-channel.py" | grep -oE '[0-9]+' || echo 0)"
EOS
)"
echo "$APPLY_OUT" | sed 's/^/      /'

# 4) 重启服务
echo "[4/5] 重启通道服务…"
ssh "${SSH_OPTS[@]}" -p "$PORT" "$REMOTE_USER@$HOST" '
  if systemctl list-unit-files 2>/dev/null | grep -q "hermes-buddy-channel.service"; then
    systemctl restart hermes-buddy-channel
    echo "      已 systemctl restart hermes-buddy-channel"
  else
    pkill -f "buddy-channel.py" 2>/dev/null || true
    sleep 1
    nohup python3 /root/.hermes/buddy-channel.py >/tmp/buddy-channel.log 2>&1 &
    echo "      已按进程方式重启（未注册 systemd）"
  fi
  if [ -f /root/.hermes/buddy-inference-proxy.py ] && systemctl list-unit-files 2>/dev/null | grep -q "hermes-buddy-inference.service"; then
    systemctl restart hermes-buddy-inference 2>/dev/null && echo "      已重启推理代理服务" || true
  fi
  sleep 2
' | sed 's/^/      /'

# 5) 校验
echo "[5/5] 校验运行中的版本…"
VERIFY="$(ssh "${SSH_OPTS[@]}" -p "$PORT" "$REMOTE_USER@$HOST" '
  D="'"$REMOTE_DIR"'"
  B=$(grep -m1 -oE "CHANNEL_BUILD = \"[0-9]+\"" "$D/buddy-channel.py" | grep -oE "[0-9]+" || echo 0)
  echo "file_build:$B"
  H=$(curl -s -m 5 http://127.0.0.1:8822/health 2>/dev/null || true)
  echo "health:$H"
  echo "game_feature:$(grep -c "game_guide" "$D/buddy-channel.py" || true)"
')"
FILE_BUILD="$(echo "$VERIFY" | sed -n 's/^file_build://p' | head -1)"
HEALTH="$(echo "$VERIFY" | sed -n 's/^health://p' | head -1)"
GAME_FEATURE="$(echo "$VERIFY" | sed -n 's/^game_feature://p' | head -1)"
HEALTH_BUILD="$(printf '%s' "$HEALTH" | grep -oE '"channel_build"[^,}]*' | grep -oE '[0-9]+' | head -1)"
[ -n "$HEALTH_BUILD" ] || HEALTH_BUILD="$(printf '%s' "$HEALTH" | grep -oE '"build"[^,}]*' | grep -oE '[0-9]+' | head -1)"

echo "      文件 build    : ${FILE_BUILD:-未知}"
echo "      /health build : ${HEALTH_BUILD:-未知}"
echo "      新特性 game_guide: ${GAME_FEATURE:-0} 处"

OK=1
[ "${FILE_BUILD:-0}" = "$TARGET_BUILD" ] || OK=0
if [ -n "$HEALTH_BUILD" ]; then
  [ "$HEALTH_BUILD" = "$TARGET_BUILD" ] || OK=0
fi

ssh "${SSH_OPTS[@]}" -p "$PORT" "$REMOTE_USER@$HOST" "rm -rf $TMP" >/dev/null 2>&1 || true

echo "------------------------------------------------------------"
if [ "$OK" = "1" ]; then
  echo "PASS：服务端通道脚本已更新到 build $TARGET_BUILD，Buddy 客户端可重新「检查并连接」。"
  exit 0
else
  echo "FAIL：版本仍未达到 build $TARGET_BUILD。"
  echo "      旧文件已备份为 $REMOTE_DIR/buddy-channel.py.bak-$TS ，可回滚："
  echo "      ssh $REMOTE_USER@$HOST 'cp -f $REMOTE_DIR/buddy-channel.py.bak-$TS $REMOTE_DIR/buddy-channel.py && systemctl restart hermes-buddy-channel'"
  exit 1
fi
