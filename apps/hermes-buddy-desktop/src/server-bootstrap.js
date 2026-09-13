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
 *   - llmPort        纯推理端点端口（默认 8800，即 hermes proxy；实际以探测为准）
 *   - gatewayPort    Gateway 端口（默认 22122；用户填 0 表示"没填 gateway"，脚本里就跳过这一段）
 *   - managementPort 部署管理端口（默认 8700；同上）

 * 重要认知（2026-09-14 实测终版，推翻了 2026-09-13 的假设）：
 * - Gateway 的 /v1/chat/completions（api_server 平台，22122）是"服务端 agent 端点"：
 *   无视请求 tools、注入约 1.2~4 万 token 的自有系统提示、在服务器本地执行命令。
 *   实测：model 填 hermes-agent 和填底层真实模型名（ark-code-latest）结果完全一样，
 *   两条请求都在服务器上真的跑了 `ls /root` 再返回文字 —— 换 model 名绕不过去。
 * - hermes proxy 也**不是**本地推理端点：它把请求转发给 OAuth 供应商（Nous/xai），
 *   子命令是 start（不是 run），默认端口 8645（不是 8800）。
 * - 结论：Buddy 必须直连一个真正的 OpenAI 兼容推理端点，来源三选一：
 *   (a) Hermes 自己在用的上游供应商（脚本第 4 步负责把它挖出来）
 *   (b) hermes proxy start --host 0.0.0.0 --port 8645
 *   (c) 任意自建 OpenAI 兼容端点（Ark / DeepSeek / 通义 / vLLM / Ollama）
 * - 所以脚本第 4 步 = 侦察上游模型端点；第 5 步 = 用合法参数重启 Gateway（不带 --host）。
 *
 * 输出是一段字符串，前 4 行带 #!/usr/bin/env bash，用户可以直接 .sh 保存到 Hermes 上跑。
 * 不用 shebang 也行 —— Buddy 那边有个"复制"按钮和"导出 .sh"按钮都能用。
 */

function generateBootstrapScript(input = {}) {
  const host = String(input.host || '<hermes-host>').replace(/[^a-zA-Z0-9.\-_]/g, '');
  const llmPort = clampPort(input.llmPort, 22122);
  const gatewayPort = input.gatewayPort === 0 ? 0 : clampPort(input.gatewayPort, 22122);
  const managementPort = input.managementPort === 0 ? 0 : clampPort(input.managementPort, 8700);

  // 这里不直接拼 bash 字符串做注入面：所有 port 都来自用户输入，已经用 clampPort 限制成 1-65535。
  // host 已经过滤过非法字符；shell 里的双引号也用不着（脚本里只用注释和 echo）。
  const lines = [];

  lines.push('#!/usr/bin/env bash');
  lines.push('# Hermes Buddy 服务端一次性准备脚本');
  lines.push('# 由 Buddy 自动生成，请复制到 Hermes 主机（' + host + '）以 root 身份执行');
  lines.push('# 作用：诊断端口监听、检查绑定地址、打印 API Key、启动 LLM、重启 gateway');
  lines.push('set -euo pipefail');
  lines.push('');

  lines.push('HERMES_HOME="${HERMES_HOME:-/root/.hermes}"');
  lines.push('echo "[buddy-bootstrap] Hermes 主机:  ' + host + '"');
  lines.push('echo "[buddy-bootstrap] Hermes_HOME:    $HERMES_HOME"');
  lines.push('echo "[buddy-bootstrap] 说明: Buddy 需要「原生 function calling 的纯推理端点」，22122 是服务端 agent 端点用不了，详见第 4 步"');
  if (gatewayPort) lines.push('echo "[buddy-bootstrap] 预期 Gateway 端口: ' + gatewayPort + '"');
  if (managementPort) lines.push('echo "[buddy-bootstrap] 预期 Management 端口: ' + managementPort + '"');
  lines.push('');

  // 统一的重启函数：绝不给 `hermes gateway run` 传 --host（CLI 不认，绑定地址由 config.yaml 的 host 决定）。
  lines.push('# 重启 Gateway 的统一入口：在跑用 restart，没跑直接 run；绑定地址一律来自 config.yaml');
  lines.push('gw_running() { pgrep -f "hermes.*gateway" >/dev/null 2>&1; }');
  lines.push('gw_restart() {');
  lines.push('  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q hermes-gateway; then');
  lines.push('    echo "[buddy-bootstrap] 用 systemd 重启..."');
  lines.push('    systemctl restart hermes-gateway 2>&1 || true');
  lines.push('  elif command -v hermes >/dev/null 2>&1; then');
  lines.push('    if gw_running; then');
  lines.push('      echo "[buddy-bootstrap] Gateway 在跑，执行 hermes gateway restart..."');
  lines.push('      hermes gateway restart >> "$HERMES_HOME/gateway.log" 2>&1 || {');
  lines.push('        echo "[buddy-bootstrap]   restart 失败，尝试 stop + run..."');
  lines.push('        hermes gateway stop 2>&1 || true');
  lines.push('        sleep 2');
  lines.push('        nohup hermes gateway run >> "$HERMES_HOME/gateway.log" 2>&1 &');
  lines.push('      }');
  lines.push('    else');
  lines.push('      echo "[buddy-bootstrap] Gateway 未在跑，直接 hermes gateway run（绑定地址取 config.yaml 的 host，无需 --host 参数）..."');
  lines.push('      nohup hermes gateway run >> "$HERMES_HOME/gateway.log" 2>&1 &');
  lines.push('    fi');
  lines.push('  else');
  lines.push('    echo "[buddy-bootstrap] 未找到 hermes 命令，尝试 python 模块方式启动..."');
  lines.push('    nohup python3 -m hermes_cli.main gateway run >> "$HERMES_HOME/gateway.log" 2>&1 &');
  lines.push('  fi');
  lines.push('  sleep 5');
  lines.push('}');
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
  lines.push('# ---- 2. 当前监听端口（打全表，方便一眼看出还有没有别的推理端点） ----');
  lines.push('echo "[buddy-bootstrap] 全部 TCP 监听:"');
  lines.push('if command -v ss >/dev/null 2>&1; then');
  lines.push('  ss -tlnp 2>/dev/null | head -40 | sed "s/^/  /" || true');
  lines.push('else');
  lines.push('  netstat -tlnp 2>/dev/null | head -40 | sed "s/^/  /" || true');
  lines.push('fi');
  lines.push('');

  // 3. 配置文件绑定地址
  lines.push('# ---- 3. 配置文件绑定地址（这是 Buddy 连不上的最常见原因） ----');
  lines.push('CONFIG="$HERMES_HOME/config.yaml"');
  lines.push('if [[ -f "$CONFIG" ]]; then');
  lines.push('  echo "[buddy-bootstrap] config.yaml 里和绑定相关的行:"');
  lines.push('  grep -nE "^\\s*(host|bind|listen|bind_host|gateway_host|server_host|api_server_host|llm_host|model_router_host)\\s*[:=]" "$CONFIG" | head -20 || echo "  (没有显式的 host 字段，Hermes 启动命令会决定监听)"');
  lines.push('  echo ""');
  lines.push('  echo "[buddy-bootstrap] 如果上面看到 127.0.0.1，需要改成 0.0.0.0 才能让 Buddy（另一台机器）连上"');
  lines.push('  echo "[buddy-bootstrap] sed 单引号转义太容易踩坑，这里只提示，由你人工决定：人工编辑 $CONFIG，把 host/bind 这一类键的值改成 0.0.0.0"');
  lines.push('  echo ""');
  lines.push('  echo "[buddy-bootstrap] 编辑完之后直接重启 gateway（第 5 步），无需改配置文件"');
  lines.push('else');
  lines.push('  echo "[buddy-bootstrap] WARN: $CONFIG 不存在"');
  lines.push('fi');
  lines.push('');

  // 4. 侦察「可用的纯推理端点」
  // 2026-09-14 实测终版：22122 的 /v1/chat/completions 无论 model 填什么都走服务端 agent，
  // 换 model 名绕不过去；hermes proxy 又是转发到 OAuth 供应商（Nous/xai）的代理，
  // 子命令 start、默认 8645。所以第 4 步的目标改成：
  //   把「Hermes 自己在用的上游模型供应商」挖出来（base_url + 密钥 + 模型名），供 Buddy 直连。
  lines.push('# ---- 4. 侦察纯推理端点（Buddy 真正要连的东西）----');
  lines.push('SHOW_KEYS="${SHOW_KEYS:-0}"   # 需要看完整密钥时改用: SHOW_KEYS=1 ./本脚本.sh');
  lines.push('mask() { local v="$1"; if [[ "$SHOW_KEYS" == "1" || ${#v} -le 10 ]]; then printf "%s" "$v"; else printf "%s****%s" "${v:0:6}" "${v: -4}"; fi; }');
  lines.push('mkdir -p "$HERMES_HOME/logs"');
  lines.push('');
  lines.push('echo "[buddy-bootstrap] ---- 4a. 配置里的模型与供应商 ----"');
  lines.push('for f in "$HERMES_HOME/config.yaml" "$HERMES_HOME/.env" "$HERMES_HOME/data/.env"; do');
  lines.push('  [[ -f "$f" ]] || continue');
  lines.push('  echo "  -- $f"');
  lines.push('  grep -nEi "(model|provider|base_url|api_base|endpoint|ark|volc|openai|deepseek|anthropic|nous|xai|qwen|doubao|moonshot|zhipu)" "$f" 2>/dev/null | grep -vE "^[0-9]+:[[:space:]]*#" | head -40 | sed "s/^/     /" || true');
  lines.push('done');
  lines.push('');
  lines.push('echo "[buddy-bootstrap] ---- 4b. 上游供应商密钥（默认打码）与 base_url ----"');
  lines.push('for f in "$HERMES_HOME/.env" "$HERMES_HOME/data/.env" "$HERMES_HOME/config.yaml"; do');
  lines.push('  [[ -f "$f" ]] || continue');
  lines.push('  while IFS= read -r line; do');
  lines.push('    name="${line%%=*}"; value="${line#*=}"');
  lines.push('    [[ "$name" =~ (KEY|TOKEN|SECRET|PASSWORD) ]] || continue');
  lines.push('    printf "     %-38s %s   (%s)\\n" "$name" "$(mask "$value")" "$f"');
  lines.push('  done < <(grep -E "^[A-Za-z_][A-Za-z0-9_]*=" "$f" 2>/dev/null || true)');
  lines.push('done');
  lines.push('echo "  -- 配置里出现的 URL（非机密，直接打印）:"');
  lines.push('grep -hoE "https?://[A-Za-z0-9._/-]+" "$HERMES_HOME/config.yaml" "$HERMES_HOME/.env" "$HERMES_HOME/data/.env" 2>/dev/null | sort -u | sed "s/^/     /" || true');
  lines.push('');
  lines.push('echo "[buddy-bootstrap] ---- 4c. hermes CLI 的模型 / 代理能力 ----"');
  lines.push('if command -v hermes >/dev/null 2>&1; then');
  lines.push('  echo "  $ hermes model --help";     hermes model --help     2>&1 | head -25 || true');
  lines.push('  echo "  $ hermes model list";       hermes model list       2>&1 | head -25 || true');
  lines.push('  echo "  $ hermes proxy providers";  hermes proxy providers  2>&1 | head -20 || true');
  lines.push('  echo "  $ hermes proxy status";     hermes proxy status     2>&1 | head -20 || true');
  lines.push('else');
  lines.push('  echo "  未找到 hermes 命令"');
  lines.push('fi');
  lines.push('');
  lines.push('echo "[buddy-bootstrap] ---- 4d. Hermes 源码里的推理端点线索 ----"');
  lines.push('PKG_DIR=$(python3 -c "import importlib.util as u, os; ms=[x for x in (\'hermes_cli\',\'hermes\') if u.find_spec(x)]; print(os.path.dirname(u.find_spec(ms[0]).origin) if ms else \'\')" 2>/dev/null || true)');
  lines.push('if [[ -n "$PKG_DIR" && -d "$PKG_DIR" ]]; then');
  lines.push('  echo "  包目录: $PKG_DIR"');
  lines.push('  grep -rn "chat/completions" "$PKG_DIR" --include=*.py 2>/dev/null | head -12 | sed "s/^/     /" || true');
  lines.push('else');
  lines.push('  echo "  未能定位 hermes 包目录（不影响结论）"');
  lines.push('fi');
  lines.push('');
  lines.push('echo "[buddy-bootstrap] ---- 4e. hermes proxy（子命令是 start，默认端口 8645）----"');
  lines.push('PROXY_PORT=""');
  lines.push('for p in 8645 8800 8000; do');
  lines.push('  if curl -s -m 5 "http://127.0.0.1:${p}/v1/models" >/dev/null 2>&1; then PROXY_PORT="$p"; break; fi');
  lines.push('done');
  lines.push('if [[ -n "$PROXY_PORT" ]]; then');
  lines.push('  echo "  已有 OpenAI 兼容代理在跑：端口 $PROXY_PORT"');
  lines.push('elif command -v hermes >/dev/null 2>&1; then');
  lines.push('  echo "  尝试: hermes proxy start --host 0.0.0.0 --port 8645"');
  lines.push('  nohup hermes proxy start --host 0.0.0.0 --port 8645 >> "$HERMES_HOME/logs/proxy.log" 2>&1 &');
  lines.push('  sleep 8');
  lines.push('  curl -s -m 5 http://127.0.0.1:8645/v1/models >/dev/null 2>&1 && PROXY_PORT=8645 || true');
  lines.push('  if [[ -z "$PROXY_PORT" ]]; then');
  lines.push('    echo "  未起来。proxy.log 末尾:"');
  lines.push('    tail -n 15 "$HERMES_HOME/logs/proxy.log" 2>/dev/null || true');
  lines.push('  fi');
  lines.push('fi');
  lines.push('');
  lines.push('echo "[buddy-bootstrap] ---- 4f. Buddy 的「推理端点（LLM）」该填什么 ----"');
  lines.push('if [[ -n "$PROXY_PORT" ]]; then');
  lines.push('  echo "  可选: http://' + host + ':$PROXY_PORT/v1/chat/completions  (hermes proxy，转发到 OAuth 供应商)"');
  lines.push('fi');
  lines.push('echo "  推荐: 用 4a/4b 挖出来的上游供应商 base_url + 密钥，在 Buddy 里直连（原生 function calling）"');
  lines.push('echo "  例如: https://ark.cn-beijing.volces.com/api/v3/chat/completions  模型名见 4a"');
  lines.push('echo "  禁止: http://' + host + ':' + (gatewayPort || 22122) + '/v1/chat/completions = 服务端 agent 端点，Buddy 用不了（已实测）"');
  lines.push('if [[ -n "$PROXY_PORT" ]]; then');
  lines.push('  LLM_PORT="$PROXY_PORT"');
  lines.push('else');
  lines.push('  LLM_PORT="' + (gatewayPort || 22122) + '"');
  lines.push('fi');
  lines.push('');


  // 5. 重启 gateway
  // 教训：绝不能先盲杀再重启 —— v2.3.6 之前"先 kill 再用非法参数 run"直接把 Gateway 干死了。
  // 现在统一走 gw_restart()：在跑用 hermes gateway restart，没跑用 hermes gateway run（不带 --host）。
  lines.push('# ---- 5. 重启 Gateway（若第 3 步改过绑定地址，此步必须执行） ----');
  lines.push('gw_restart');

  // 6. 验证 + 打印 API Key
  lines.push('# ---- 6. 重启后再听一次端口 ----');
  lines.push('sleep 3');
  lines.push('if command -v ss >/dev/null 2>&1; then');
  lines.push('  ss -tlnp 2>/dev/null | grep -E ":' + (gatewayPort || '00000') + (managementPort ? '|:' + managementPort : '') + '" || echo "  还是没监听 —— 检查 gateway.log"');
  lines.push('fi');
  lines.push('echo "[buddy-bootstrap] gateway.log 最近 20 行:"');
  lines.push('tail -n 20 "$HERMES_HOME/gateway.log" 2>/dev/null || true');
  lines.push('');

  lines.push('# ---- 7. 打印 API Key + 确保 .env 包含 API_SERVER_KEY ----');
  lines.push('KEY_FILE=""');
  lines.push('for candidate in "$HERMES_HOME/.api_server_key" "$HERMES_HOME/data/.env" "$HERMES_HOME/.env"; do');
  lines.push('  if [[ -f "$candidate" ]]; then KEY_FILE="$candidate"; break; fi');
  lines.push('done');
  lines.push('API_KEY=""');
  lines.push('if [[ -z "$KEY_FILE" ]]; then');
  lines.push('  echo "[buddy-bootstrap] WARN: 找不到 API Key 文件，请到 $HERMES_HOME 翻 .api_server_key / data/.env"');
  lines.push('else');
  lines.push('  echo "[buddy-bootstrap] API Key 文件: $KEY_FILE"');
  lines.push('  if [[ "$KEY_FILE" == *.env ]]; then');
  lines.push('    API_KEY=$(grep -E "^API_SERVER_KEY=" "$KEY_FILE" 2>/dev/null | cut -d= -f2- | tr -d "\\r\\n" || true)');
  lines.push('    if [[ -z "$API_KEY" ]]; then');
  lines.push('      API_KEY=$(grep -E "API_SERVER_KEY|API_KEY|HERMES_API_KEY" "$KEY_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\\r\\n" || true)');
  lines.push('    fi');
  lines.push('  else');
  lines.push('    API_KEY=$(cat "$KEY_FILE" | tr -d "\\r\\n")');
  lines.push('  fi');
  lines.push('fi');
  lines.push('echo "[buddy-bootstrap] API Key: $API_KEY"');
  lines.push('');
  lines.push('# 关键修复：确保 .env 文件包含 API_SERVER_KEY，否则 Gateway 的 createSession 会返回 401');
  lines.push('ENV_FILE="$HERMES_HOME/.env"');
  lines.push('ENV_WRITTEN=0');
  lines.push('if [[ -f "$ENV_FILE" ]]; then');
  lines.push('  if ! grep -q "^API_SERVER_KEY=" "$ENV_FILE" 2>/dev/null; then');
  lines.push('    echo "[buddy-bootstrap] .env 缺少 API_SERVER_KEY，正在自动写入..."');
  lines.push('    echo "API_SERVER_KEY=$API_KEY" >> "$ENV_FILE"');
  lines.push('    echo "[buddy-bootstrap] 已写入 API_SERVER_KEY 到 $ENV_FILE"');
  lines.push('    ENV_WRITTEN=1');
  lines.push('  else');
  lines.push('    echo "[buddy-bootstrap] .env 已包含 API_SERVER_KEY"');
  lines.push('  fi');
  lines.push('else');
  lines.push('  echo "[buddy-bootstrap] .env 不存在，正在创建并写入 API_SERVER_KEY..."');
  lines.push('  echo "API_SERVER_KEY=$API_KEY" > "$ENV_FILE"');
  lines.push('  ENV_WRITTEN=1');
  lines.push('fi');
  lines.push('');
  lines.push('# 只有刚写入过 Key 才需要再重启一次让配置生效（复用统一的 gw_restart，不带 --host）');
  lines.push('if [[ "$ENV_WRITTEN" == "1" ]]; then');
  lines.push('  echo "[buddy-bootstrap] 重启 Gateway 使 API_SERVER_KEY 生效..."');
  lines.push('  gw_restart');
  lines.push('fi');
  lines.push('');
  lines.push('# 最终核验：Gateway 端口必须在监听（LLM 端点可能是外部地址，不在这里校验）');
  lines.push('sleep 2');
  lines.push('if ss -tln 2>/dev/null | grep -qE ":' + (gatewayPort || 22122) + '\\b" || netstat -tln 2>/dev/null | grep -qE ":' + (gatewayPort || 22122) + '\\b"; then');
  lines.push('  echo "[buddy-bootstrap] 最终核验 OK：Gateway 端口 ' + (gatewayPort || 22122) + ' 正在监听"');
  lines.push('else');
  lines.push('  echo "[buddy-bootstrap] 最终核验 FAIL：Gateway 端口 ' + (gatewayPort || 22122) + ' 仍未监听。gateway.log 末尾如下："');
  lines.push('  tail -n 30 "$HERMES_HOME/gateway.log" 2>/dev/null || true');
  lines.push('fi');
  lines.push('');
  lines.push('echo "[buddy-bootstrap] 完成。请在 Buddy 连接向导里按下面填写："');
  if (gatewayPort) {
    lines.push('echo "[buddy-bootstrap]   Gateway 地址: http://' + host + ':' + gatewayPort + '"');
    lines.push('echo "[buddy-bootstrap]   注意：Gateway 必须是 22122，填 22121/22123/8700 会报 404（不是 Gateway）"');
  }
  lines.push('echo "[buddy-bootstrap]   Gateway API Key: $API_KEY"');
  lines.push('echo "[buddy-bootstrap]   推理端点（LLM）: 填第 4f 步推荐的上游供应商地址 —— 不要填 Gateway 的 22122"');

  return lines.join('\n') + '\n';
}

function clampPort(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 1 || n > 65535) return fallback;
  return Math.trunc(n);
}

module.exports = { generateBootstrapScript, clampPort };
