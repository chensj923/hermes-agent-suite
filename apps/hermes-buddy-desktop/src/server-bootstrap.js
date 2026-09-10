'use strict';

/**
 * 生成一份给 Hermes 服务端跑的"准备脚本"。
 *
 * 这份脚本不是 Buddy 自动执行的（Buddy 跑在 Windows 上，没 SSH 到服务端），
 * 而是把内容展示/复制给用户，让他去 Hermes 主机上跑一下：
 *
 *   1. 检查 Hermes 是不是真的在跑（pid 文件 / ss 端口）
 *   2. 检查配置文件里有没有把端口绑到 127.0.0.1（这是 Buddy 连不上的常见原因）
 *   3. 给出"修改绑定 + 重启"的具体命令
 *   4. 打印 API Key（路径找得到就用，找不到就提示去 ~/.hermes 翻 .api_server_key 或 .env）
 *   5. 用 ss 打一份当前监听清单，Buddy 用户拿这个对一下自己填的端口
 *
 * 输入参数：
 *   - host           Hermes 主机（必填，用来给生成出来的脚本头部 echo 提示用）
 *   - llmPort        LLM 端点端口（默认 8800）
 *   - gatewayPort    Gateway 端口（默认 22122；用户填 0 表示"没填 gateway"，脚本里就跳过这一段）
 *   - managementPort 部署管理端口（默认 8700；同上）
 *
 * 输出是一段字符串，前 4 行带 #!/usr/bin/env bash，用户可以直接 .sh 保存到 Hermes 上跑。
 * 不用 shebang 也行 —— Buddy 那边有个"复制"按钮和"导出 .sh"按钮都能用。
 */

function generateBootstrapScript(input = {}) {
  const host = String(input.host || '<hermes-host>').replace(/[^a-zA-Z0-9.\-_]/g, '');
  const llmPort = clampPort(input.llmPort, 8800);
  const gatewayPort = input.gatewayPort === 0 ? 0 : clampPort(input.gatewayPort, 22122);
  const managementPort = input.managementPort === 0 ? 0 : clampPort(input.managementPort, 8700);

  // 这里不直接拼 bash 字符串做注入面：所有 port 都来自用户输入，已经用 clampPort 限制成 1-65535。
  // host 已经过滤过非法字符；shell 里的双引号也用不着（脚本里只用注释和 echo）。
  const lines = [];

  lines.push('#!/usr/bin/env bash');
  lines.push('# Hermes Buddy 服务端一次性准备脚本');
  lines.push('# 由 Buddy 自动生成，请复制到 Hermes 主机（' + host + '）以 root 身份执行');
  lines.push('# 作用：诊断端口监听、检查绑定地址、打印 API Key、重启 gateway');
  lines.push('set -euo pipefail');
  lines.push('');

  lines.push('HERMES_HOME="${HERMES_HOME:-/root/.hermes}"');
  lines.push('echo "[buddy-bootstrap] Hermes 主机:  ' + host + '"');
  lines.push('echo "[buddy-bootstrap] Hermes_HOME:    $HERMES_HOME"');
  lines.push('echo "[buddy-bootstrap] 预期 LLM 端口:    ' + llmPort + '"');
  if (gatewayPort) lines.push('echo "[buddy-bootstrap] 预期 Gateway 端口: ' + gatewayPort + '"');
  if (managementPort) lines.push('echo "[buddy-bootstrap] 预期 Management 端口: ' + managementPort + '"');
  lines.push('');

  // 1. Hermes 是否在跑
  lines.push('# ---- 1. Hermes 进程状态 ----');
  lines.push('if [[ -f "$HERMES_HOME/gateway.pid" ]]; then');
  lines.push('  echo "[buddy-bootstrap] gateway.pid: $(cat "$HERMES_HOME/gateway.pid" 2>/dev/null | head -c 200)"');
  lines.push('else');
  lines.push('  echo "[buddy-bootstrap] WARN: $HERMES_HOME/gateway.pid 不存在，Hermes 可能没在跑"');
  lines.push('fi');
  lines.push('if command -v systemctl >/dev/null 2>&1; then');
  lines.push('  systemctl is-active hermes-gateway 2>/dev/null || true');
  lines.push('fi');
  lines.push('');

  // 2. 当前监听清单
  lines.push('# ---- 2. 当前监听端口 ----');
  lines.push('if command -v ss >/dev/null 2>&1; then');
  lines.push('  ss -tlnp 2>/dev/null | grep -E ":' + llmPort + '|' + (gatewayPort || '00000') + '|' + (managementPort || '00000') + '" || echo "  （预期端口未监听，下面要修）"');
  lines.push('else');
  lines.push('  netstat -tlnp 2>/dev/null | grep -E ":' + llmPort + '|' + (gatewayPort || '00000') + '|' + (managementPort || '00000') + '" || true');
  lines.push('fi');
  lines.push('');

  // 3. 配置文件绑定地址
  lines.push('# ---- 3. 配置文件绑定地址（这是 Buddy 连不上的最常见原因） ----');
  lines.push('CONFIG="$HERMES_HOME/config.yaml"');
  lines.push('if [[ -f "$CONFIG" ]]; then');
  lines.push('  echo "[buddy-bootstrap] config.yaml 里和绑定相关的行:"');
  lines.push('  grep -nE "^\\s*(host|bind|listen|bind_host|gateway_host|server_host)\\s*[:=]" "$CONFIG" | head -20 || echo "  (没有显式的 host 字段，Hermes 启动命令会决定监听)"');
  lines.push('  echo ""');
  lines.push('  echo "[buddy-bootstrap] 如果上面看到 127.0.0.1，需要改成 0.0.0.0 才能让 Buddy（另一台机器）连上"');
  lines.push('  echo "[buddy-bootstrap] sed 单引号转义太容易踩坑，这里只提示，由你人工决定：人工编辑 $CONFIG，把 host/bind 这一类键的值改成 0.0.0.0"');
  lines.push('  echo ""');
  lines.push('  echo "[buddy-bootstrap] 编辑完之后直接重启 gateway（第 4 步），无需改配置文件"');
  lines.push('else');
  lines.push('  echo "[buddy-bootstrap] WARN: $CONFIG 不存在"');
  lines.push('fi');
  lines.push('');

  // 4. 重启 gateway
  lines.push('# ---- 4. 重启 gateway（如果改了绑定地址，必须重启） ----');
  lines.push('if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q hermes-gateway; then');
  lines.push('  echo "[buddy-bootstrap] 用 systemd 重启..."');
  lines.push('  systemctl restart hermes-gateway 2>&1 || echo "  (systemctl 失败，尝试下面的手动方式)"');
  lines.push('elif command -v hermes >/dev/null 2>&1; then');
  lines.push('  echo "[buddy-bootstrap] 用 hermes CLI 重启..."');
  lines.push('  if [[ -f "$HERMES_HOME/gateway.pid" ]]; then');
  lines.push('    PID=$(grep -oE "\\\"pid\\\":\\s*[0-9]+" "$HERMES_HOME/gateway.pid" 2>/dev/null | grep -oE "[0-9]+" || true)');
  lines.push('    [[ -n "${PID:-}" ]] && kill "$PID" 2>/dev/null || true');
  lines.push('    sleep 2');
  lines.push('  fi');
  lines.push('  nohup hermes gateway run >> "$HERMES_HOME/gateway.log" 2>&1 &');
  lines.push('  sleep 2');
  lines.push('else');
  lines.push('  echo "[buddy-bootstrap] WARN: 没找到 hermes 命令，也没 systemd 单元，请手动重启"');
  lines.push('fi');
  lines.push('');

  // 5. 验证 + 打印 API Key
  lines.push('# ---- 5. 重启后再听一次端口 ----');
  lines.push('sleep 3');
  lines.push('if command -v ss >/dev/null 2>&1; then');
  lines.push('  ss -tlnp 2>/dev/null | grep -E ":' + llmPort + (gatewayPort ? '|:' + gatewayPort : '') + (managementPort ? '|:' + managementPort : '') + '" || echo "  还是没监听 —— 检查 gateway.log"');
  lines.push('fi');
  lines.push('echo "[buddy-bootstrap] gateway.log 最近 20 行:"');
  lines.push('tail -n 20 "$HERMES_HOME/gateway.log" 2>/dev/null || true');
  lines.push('');

  lines.push('# ---- 6. 打印 API Key（复制这一行粘到 Buddy 连接向导） ----');
  lines.push('KEY_FILE=""');
  lines.push('for candidate in "$HERMES_HOME/.api_server_key" "$HERMES_HOME/data/.env" "$HERMES_HOME/.env"; do');
  lines.push('  if [[ -f "$candidate" ]]; then KEY_FILE="$candidate"; break; fi');
  lines.push('done');
  lines.push('if [[ -z "$KEY_FILE" ]]; then');
  lines.push('  echo "[buddy-bootstrap] WARN: 找不到 API Key 文件，请到 $HERMES_HOME 翻 .api_server_key / data/.env"');
  lines.push('else');
  lines.push('  echo "[buddy-bootstrap] API Key 文件: $KEY_FILE"');
  lines.push('  if [[ "$KEY_FILE" == *.env ]]; then');
  lines.push('    grep -E "API_SERVER_KEY|API_KEY|HERMES_API_KEY" "$KEY_FILE" 2>/dev/null | sed -E "s/^([^=]+=)/\\1/" || true');
  lines.push('  else');
  lines.push('    cat "$KEY_FILE"');
  lines.push('  fi');
  lines.push('fi');
  lines.push('');
  lines.push('echo "[buddy-bootstrap] 完成。把上面的 API Key 复制回 Buddy 的连接向导。"');

  return lines.join('\n') + '\n';
}

function clampPort(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 1 || n > 65535) return fallback;
  return Math.trunc(n);
}

module.exports = { generateBootstrapScript, clampPort };