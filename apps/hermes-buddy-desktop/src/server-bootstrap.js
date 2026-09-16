'use strict';

const { pythonSource } = require('./inference-proxy-template');
const { channelSource } = require('./channel-template');

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
 *   /v1/responses 同理（input_tokens 12178、无 tool_calls）。
 * - hermes proxy 也**不是**本地推理端点：它把请求转发给 OAuth 供应商（Nous/xai），
 *   子命令是 start（不是 run），默认端口 8645（不是 8800）。
 * - 22122 的路由表实测只有 5 个端点：/v1/models、/v1/chat/completions、/v1/responses、
 *   /health、/api/sessions；/api/proxy、/api/passthrough、/api/inference、/api/models、
 *   /api/providers 全部 404，也没有 openapi.json。
 *   **即 Hermes 当前没有对外暴露任何"纯推理"能力。**
 *
 * 架构结论（回答"Buddy 为什么要知道 LLM"）：
 * - Buddy 的语义是「收到 messages + tools → 返回 tool_call，但**不执行**」；
 *   Hermes 的 /v1/* 是「收到 messages → 在**服务端**跑完整个 agent 循环 → 返回文本」。
 *   两者是正交的 API 语义，不是同一件事的两种配置。
 * - v2.3.9 让用户把上游供应商地址 + 密钥填进 Windows 客户端是**错误设计**：
 *   密钥散落在每台客户端、违背"Hermes 是服务端"的定位、换供应商要改所有客户端。
 * - 正确解法：在 Hermes 主机上跑一个零依赖「推理直通代理」（默认 :8811），
 *   复用 Hermes 自己配好的上游（config.yaml 的 model.base_url / name / api_key），
 *   对外提供标准 OpenAI 接口并**原样透传 tools**，用 Gateway 的 API Key 鉴权。
 *   于是 Buddy 只认 Hermes 一个地址，上游密钥永不出服务器。
 * - 所以脚本第 4 步 = 侦察上游 + 部署并实测直通代理；第 5 步 = 重启 Gateway（不带 --host）。
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

  // 0. Hermes 服务端本体安装状态（完整部署后应有 hermes 命令 + 22122 监听）
  lines.push('# ---- 0. Hermes 服务端本体安装状态 ----');
  lines.push('echo "[buddy-bootstrap] Hermes 本体检查:"');
  lines.push('if command -v hermes >/dev/null 2>&1; then');
  lines.push('  echo "  hermes 命令: $(command -v hermes)"');
  lines.push('  hermes --version 2>/dev/null | head -1 | sed "s/^/  /" || true');
  lines.push('elif [[ -x "$HERMES_HOME/venv/bin/hermes" ]]; then');
  lines.push('  echo "  hermes 命令: $HERMES_HOME/venv/bin/hermes（隔离 venv 安装）"');
  lines.push('  "$HERMES_HOME/venv/bin/hermes" --version 2>/dev/null | head -1 | sed "s/^/  /" || true');
  lines.push('else');
  lines.push('  echo "  WARN: 未找到 hermes 命令 —— 若走完整部署，请确认 INSTALL_HERMES=1 已传递且 venv 安装成功"');
  lines.push('fi');
  lines.push('if [[ -f "$HERMES_HOME/config.yaml" ]]; then');
  lines.push('  echo "  config.yaml: 存在"');
  lines.push('else');
  lines.push('  echo "  WARN: $HERMES_HOME/config.yaml 不存在 —— Gateway 无法启动"');
  lines.push('fi');
  lines.push('if ss -tln 2>/dev/null | grep -qE ":22122\\b" || netstat -tln 2>/dev/null | grep -qE ":22122\\b"; then');
  lines.push('  echo "  Gateway 端口 22122: 监听中"');
  lines.push('else');
  lines.push('  echo "  WARN: Gateway 端口 22122 未监听（完整部署应已拉起 hermes-gateway.service）"');
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
  lines.push('# ---- 4. 在 Hermes 本机部署「推理直通代理」（Buddy 真正要连的东西）----');
  lines.push('# 为什么需要它：');
  lines.push('#   22122 的 /v1/chat/completions 和 /v1/responses 都是"服务端 agent 端点"——');
  lines.push('#   无视请求里的 tools、注入约 1.2 万 token 自有系统提示、在服务器本地执行命令。');
  lines.push('#   实测 22122 上没有 /api/proxy、/api/passthrough、/api/inference、/api/models（全 404），');
  lines.push('#   即 Hermes 当前没有对外暴露任何纯推理能力。');
  lines.push('# 解法：在本机起一个零依赖直通代理，复用 Hermes 自己配好的上游（base_url / model / api_key），');
  lines.push('#       对外提供标准 OpenAI 接口并原样透传 tools，用 Gateway 的 API Key 鉴权。');
  lines.push('#       于是 Buddy 只认 Hermes 一个地址，上游密钥永不出服务器。');
  lines.push('PROXY_PORT="${BUDDY_PROXY_PORT:-8811}"');
  lines.push('PROXY_KEY=$(grep -E "^API_SERVER_KEY=" "$HERMES_HOME/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "\\r\\n" || true)');
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
  // 4e. 部署「推理直通代理」—— Buddy 只认 Hermes 一个地址，上游由 Hermes 自己持有
  lines.push('echo "[buddy-bootstrap] ---- 4e. 部署 Buddy 推理直通代理（端口 $PROXY_PORT）----"');
  lines.push('mkdir -p "$HERMES_HOME/logs"');
  lines.push('PROXY_FILE="$HERMES_HOME/buddy-inference-proxy.py"');
  lines.push('cat > "$PROXY_FILE" <<\'PYEOF\'');
  for (const srcLine of pythonSource().split('\n')) lines.push(srcLine);
  lines.push('PYEOF');
  lines.push('chmod +x "$PROXY_FILE"');
  lines.push('echo "  已写入 $PROXY_FILE （零依赖，只用 Python 标准库）"');
  lines.push('');
  // 启动：systemd 优先（能开机自启），没有 systemd 就 nohup
  lines.push('# 启动直通代理：优先 systemd（可开机自启），否则 nohup');
  lines.push('if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then');
  lines.push('  cat > /etc/systemd/system/hermes-buddy-inference.service <<SVCEOF');
  lines.push('[Unit]');
  lines.push('Description=Hermes Buddy inference pass-through proxy');
  lines.push('After=network.target');
  lines.push('');
  lines.push('[Service]');
  lines.push('Type=simple');
  lines.push('Environment=HERMES_HOME=$HERMES_HOME');
  lines.push('Environment=BUDDY_PROXY_PORT=$PROXY_PORT');
  lines.push('ExecStart=/usr/bin/env python3 $PROXY_FILE');
  lines.push('Restart=always');
  lines.push('RestartSec=2');
  lines.push('');
  lines.push('[Install]');
  lines.push('WantedBy=multi-user.target');
  lines.push('SVCEOF');
  lines.push('  systemctl daemon-reload 2>&1 | sed \'s/^/  /\' || true');
  lines.push('  systemctl enable --now hermes-buddy-inference 2>&1 | sed \'s/^/  /\' || true');
  lines.push('  sleep 3');
  lines.push('  systemctl is-active hermes-buddy-inference 2>&1 | sed \'s/^/  /\' || true');
  lines.push('else');
  lines.push('  pkill -f "buddy-inference-proxy.py" 2>/dev/null || true');
  lines.push('  nohup python3 "$PROXY_FILE" >> "$HERMES_HOME/logs/buddy-proxy.log" 2>&1 &');
  lines.push('  sleep 3');
  lines.push('fi');
  lines.push('');

  // 4f. 自动探测上游 chat 路径 + 实测 function calling + 回写 buddy-proxy.env
  lines.push('echo "[buddy-bootstrap] ---- 4f. 探测上游并实测 function calling ----"');
  lines.push('HERMES_HOME="$HERMES_HOME" BUDDY_PROXY_PORT="$PROXY_PORT" BUDDY_PROXY_KEY="$PROXY_KEY" python3 - <<\'PYTEST\' 2>&1 | sed \'s/^/  /\' || true');
  lines.push('import json, os, re, sys, urllib.request, urllib.error');
  lines.push('');
  lines.push('HOME = os.environ.get("HERMES_HOME", "/root/.hermes")');
  lines.push('PORT = os.environ.get("BUDDY_PROXY_PORT", "8811")');
  lines.push('PROXY_KEY = os.environ.get("BUDDY_PROXY_KEY", "")');
  lines.push('');
  lines.push('def read_env(path):');
  lines.push('    d = {}');
  lines.push('    try:');
  lines.push('        for line in open(path, encoding="utf-8", errors="replace"):');
  lines.push('            line = line.strip()');
  lines.push('            if line and not line.startswith("#") and "=" in line:');
  lines.push('                k, v = line.split("=", 1)');
  lines.push('                d[k.strip()] = v.strip().strip(\'"\').strip("\'")');
  lines.push('    except OSError:');
  lines.push('        pass');
  lines.push('    return d');
  lines.push('');
  lines.push('def load_cfg(path):');
  lines.push('    try:');
  lines.push('        import yaml');
  lines.push('        d = yaml.safe_load(open(path, encoding="utf-8"))');
  lines.push('        if isinstance(d, dict):');
  lines.push('            return d');
  lines.push('    except Exception:');
  lines.push('        pass');
  lines.push('    return {}');
  lines.push('');
  lines.push('def find_key(obj, keys, depth=0):');
  lines.push('    if depth > 4:');
  lines.push('        return ""');
  lines.push('    if isinstance(obj, dict):');
  lines.push('        for k in keys:');
  lines.push('            v = obj.get(k)');
  lines.push('            if isinstance(v, str) and v.strip():');
  lines.push('                return v.strip()');
  lines.push('        for v in obj.values():');
  lines.push('            r = find_key(v, keys, depth + 1)');
  lines.push('            if r:');
  lines.push('                return r');
  lines.push('    elif isinstance(obj, list):');
  lines.push('        for v in obj[:10]:');
  lines.push('            r = find_key(v, keys, depth + 1)');
  lines.push('            if r:');
  lines.push('                return r');
  lines.push('    return ""');
  lines.push('');
  lines.push('env = read_env(os.path.join(HOME, ".env"))');
  lines.push('cfg = load_cfg(os.path.join(HOME, "config.yaml"))');
  lines.push('model = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}');
  lines.push('');
  lines.push('def expand(s):');
  lines.push('    return re.sub(r"\\$\\{?([A-Za-z_][A-Za-z0-9_]*)\\}?", lambda m: env.get(m.group(1)) or os.environ.get(m.group(1)) or "", s or "")');
  lines.push('');
  lines.push('base = expand(model.get("base_url") or model.get("base-url") or model.get("endpoint") or find_key(cfg, ["base_url", "base-url", "endpoint"]) or env.get("OPENAI_BASE_URL") or "").rstrip("/")');
  lines.push('name = expand(model.get("name") or model.get("model") or env.get("OPENAI_MODEL") or "hermes-agent")');
  lines.push('key = expand(model.get("api_key") or model.get("apiKey") or find_key(model, ["api_key", "apiKey", "key", "token"]) or "")');
  lines.push('if not key:');
  lines.push('    for hint in ("ARK_API_KEY", "OPENAI_API_KEY", "CUSTOM_API_KEY", "LLM_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "DASHSCOPE_API_KEY"):');
  lines.push('        if env.get(hint):');
  lines.push('            key = env[hint]');
  lines.push('            break');
  lines.push('');
  lines.push('def mask(s):');
  lines.push('    return (s[:4] + "****" + s[-4:]) if s and len(s) > 10 else ("****" if s else "(空)")');
  lines.push('');
  lines.push('print("上游 base_url :", base or "(未找到)")');
  lines.push('print("上游 model    :", name)');
  lines.push('print("上游 api_key  :", mask(key))');
  lines.push('if not base or not key:');
  lines.push('    print("!! 拿不到上游 base_url 或 api_key，无法自动部署。")');
  lines.push('    print("!! 请执行 hermes secrets list 找凭证，或手工写入 " + HOME + "/buddy-proxy.env：")');
  lines.push('    print("!!   BUDDY_UPSTREAM_BASE=<上游 OpenAI 兼容地址>")');
  lines.push('    print("!!   BUDDY_UPSTREAM_KEY=<上游密钥>")');
  lines.push('    print("!!   BUDDY_UPSTREAM_MODEL=<模型名>")');
  lines.push('    sys.exit(0)');
  lines.push('');
  lines.push('bases = [base]');
  lines.push('if "/api/coding/" in base:');
  lines.push('    bases.append(base.replace("/api/coding/", "/api/"))');
  lines.push('if "/api/v3" in base and "/api/coding" not in base:');
  lines.push('    bases.append(base.replace("/api/v3", "/api/coding/v3"))');
  lines.push('uniq = []');
  lines.push('for b in bases:');
  lines.push('    if b not in uniq:');
  lines.push('        uniq.append(b)');
  lines.push('cands = []');
  lines.push('for b in uniq:');
  lines.push('    if b.endswith("/chat/completions"):');
  lines.push('        cands.append((b, ""))');
  lines.push('    else:');
  lines.push('        for p in ("/chat/completions", "/v1/chat/completions", "/openai/chat/completions"):');
  lines.push('            cands.append((b, p))');
  lines.push('');
  lines.push('TOOLS = [{"type": "function", "function": {"name": "probe_tool", "description": "probe", "parameters": {"type": "object", "properties": {}, "required": []}}}]');
  lines.push('');
  lines.push('def fc_test(url, api_key, model_name, force=True):');
  lines.push('    body = {"model": model_name, "messages": [{"role": "user", "content": "Call probe_tool now."}], "tools": TOOLS, "max_tokens": 64}');
  lines.push('    if force:');
  lines.push('        body["tool_choice"] = "required"');
  lines.push('    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + api_key})');
  lines.push('    try:');
  lines.push('        with urllib.request.urlopen(req, timeout=90) as r:');
  lines.push('            return json.loads(r.read().decode("utf-8", "replace")), None');
  lines.push('    except urllib.error.HTTPError as e:');
  lines.push('        return None, "HTTP %s: %s" % (e.code, e.read()[:200].decode("utf-8", "replace"))');
  lines.push('    except Exception as e:');
  lines.push('        return None, str(e)');
  lines.push('');
  lines.push('def got_tool(j):');
  lines.push('    try:');
  lines.push('        msg = (j.get("choices") or [{}])[0].get("message") or {}');
  lines.push('    except Exception:');
  lines.push('        return None, ""');
  lines.push('    tc = msg.get("tool_calls")');
  lines.push('    if tc:');
  lines.push('        return tc[0]["function"]["name"], ""');
  lines.push('    return None, (msg.get("content") or "")[:100]');
  lines.push('');
  lines.push('chosen = None');
  lines.push('for b, p in cands:');
  lines.push('    url = b if p == "" else b + p');
  lines.push('    j, err = fc_test(url, key, name, True)');
  lines.push('    if err:');
  lines.push('        print("   x %s -> %s" % (url, err[:130]))');
  lines.push('        continue');
  lines.push('    fn, txt = got_tool(j)');
  lines.push('    if fn:');
  lines.push('        print("   OK %s -> tool_calls: %s" % (url, fn))');
  lines.push('        chosen = (b, p)');
  lines.push('        break');
  lines.push('    j2, err2 = fc_test(url, key, name, False)');
  lines.push('    if not err2:');
  lines.push('        fn2, _ = got_tool(j2)');
  lines.push('        if fn2:');
  lines.push('            print("   OK %s -> tool_calls(auto): %s" % (url, fn2))');
  lines.push('            chosen = (b, p)');
  lines.push('            break');
  lines.push('    print("   ~ %s -> 通但没有 tool_calls: %s" % (url, txt))');
  lines.push('');
  lines.push('if not chosen:');
  lines.push('    print("!! 所有候选路径都拿不到 tool_calls —— 该上游可能不支持 function calling。")');
  lines.push('    print("!! Buddy 的本地工具链路必须靠 FC，请换一个支持 function calling 的模型。")');
  lines.push('    sys.exit(0)');
  lines.push('');
  lines.push('with open(os.path.join(HOME, "buddy-proxy.env"), "w", encoding="utf-8") as f:');
  lines.push('    f.write("BUDDY_UPSTREAM_BASE=%s\\n" % chosen[0])');
  lines.push('    f.write("BUDDY_UPSTREAM_CHAT_PATH=%s\\n" % chosen[1])');
  lines.push('    f.write("BUDDY_UPSTREAM_MODEL=%s\\n" % name)');
  lines.push('    f.write("BUDDY_UPSTREAM_KEY=%s\\n" % key)');
  lines.push('print("已写入 " + HOME + "/buddy-proxy.env（上游密钥只存在服务端）")');
  lines.push('');
  lines.push('purl = "http://127.0.0.1:%s/v1/chat/completions" % PORT');
  lines.push('j, err = fc_test(purl, PROXY_KEY or key, name, True)');
  lines.push('if err:');
  lines.push('    print("!! 经代理失败: %s" % err[:220])');
  lines.push('else:');
  lines.push('    fn, txt = got_tool(j)');
  lines.push('    print("经代理 %s -> %s" % (purl, ("tool_calls: " + fn) if fn else ("无 tool_calls: " + txt)))');
  lines.push('PYTEST');
  lines.push('');

  // 4g. 结论：Buddy 该填什么
  lines.push('echo "[buddy-bootstrap] ---- 4g. 结论 ----"');
  lines.push('PROXY_UP=0');
  lines.push('if curl -s -m 5 "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1; then PROXY_UP=1; fi');
  lines.push('if [[ "$PROXY_UP" == "1" ]]; then');
  lines.push('  echo "  直通代理已就绪: http://0.0.0.0:$PROXY_PORT  (用 Gateway API Key 鉴权)"');
  lines.push('  LLM_PORT="$PROXY_PORT"');
  lines.push('else');
  lines.push('  echo "  WARN: 直通代理未监听 $PROXY_PORT。buddy-proxy.log 末尾:"');
  lines.push('  tail -n 20 "$HERMES_HOME/logs/buddy-proxy.log" 2>/dev/null || true');
  lines.push('  echo "  或: systemctl status hermes-buddy-inference --no-pager | tail -20"');
  lines.push('  LLM_PORT="' + (gatewayPort || 22122) + '"');
  lines.push('fi');
  lines.push('echo "  禁止: http://' + host + ':' + (gatewayPort || 22122) + '/v1/chat/completions = 服务端 agent 端点，Buddy 用不了（已实测）"');
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
  lines.push('# 最终核验：Gateway 端口 + 直通代理端口都必须在监听');
  lines.push('sleep 2');
  lines.push('if ss -tln 2>/dev/null | grep -qE ":' + (gatewayPort || 22122) + '\\b" || netstat -tln 2>/dev/null | grep -qE ":' + (gatewayPort || 22122) + '\\b"; then');
  lines.push('  echo "[buddy-bootstrap] 最终核验 OK：Gateway 端口 ' + (gatewayPort || 22122) + ' 正在监听"');
  lines.push('else');
  lines.push('  echo "[buddy-bootstrap] 最终核验 FAIL：Gateway 端口 ' + (gatewayPort || 22122) + ' 仍未监听。gateway.log 末尾如下："');
  lines.push('  tail -n 30 "$HERMES_HOME/gateway.log" 2>/dev/null || true');
  lines.push('fi');
  lines.push('if ss -tln 2>/dev/null | grep -qE ":$PROXY_PORT\\b"; then');
  lines.push('  echo "[buddy-bootstrap] 最终核验 OK：推理直通代理端口 $PROXY_PORT 正在监听"');
  lines.push('else');
  lines.push('  echo "[buddy-bootstrap] 最终核验 WARN：直通代理端口 $PROXY_PORT 未监听"');
  lines.push('fi');
  lines.push('');
  lines.push('echo "[buddy-bootstrap] 完成。请在 Buddy 连接向导里按下面填写："');
  if (gatewayPort) {
    lines.push('echo "[buddy-bootstrap]   Gateway 地址: http://' + host + ':' + gatewayPort + '"');
    lines.push('echo "[buddy-bootstrap]   注意：Gateway 必须是 22122，填 22121/22123/8700 会报 404（不是 Gateway）"');
  }
  lines.push('echo "[buddy-bootstrap]   API Key（Gateway 与推理端点共用同一个）: $API_KEY"');
  lines.push('echo "[buddy-bootstrap]   推理端点（LLM）: http://' + host + ':$LLM_PORT/v1/chat/completions"');
  lines.push('echo "[buddy-bootstrap]   —— 这就是 Hermes 本机上的直通代理，上游供应商由服务端持有，密钥不出服务器"');
  lines.push('echo "[buddy-bootstrap]   —— 千万不要填 http://' + host + ':' + (gatewayPort || 22122) + '/v1/chat/completions（服务端 agent 端点，已实测不可用）"');

  // 4h. 部署「WS 工具通道」（外挂组件，决策在服务器、执行在 Buddy 本地）
  // 这是比 8811 直通代理更彻底的架构：服务器跑 Agent 循环，把工具调用经 WS 卸载给 Buddy 本地执行。
  lines.push('');
  lines.push('# ---- 4h. 部署 WS 工具通道（端口 8822，外挂组件）----');
  lines.push('# 适用场景：想要「决策在 Hermes 服务器、工具在 Buddy 客户端本地执行」的飞书式通道架构。');
  lines.push('# 与 8811 直通代理二选一：8811 是本地跑 ReAct 循环（决策在客户端），8822 是决策在服务器。');
  lines.push('CHANNEL_PORT="${BUDDY_CHANNEL_PORT:-8822}"');
  lines.push('CHANNEL_FILE="$HERMES_HOME/buddy-channel.py"');
  lines.push('cat > "$CHANNEL_FILE" <<\'CHEOF\'');
  for (const srcLine of channelSource().split('\n')) lines.push(srcLine);
  lines.push('CHEOF');
  lines.push('chmod +x "$CHANNEL_FILE"');
  lines.push('echo "  已写入 $CHANNEL_FILE （零依赖，只用 Python 标准库；复用同一份 API_SERVER_KEY 鉴权）"');
  lines.push('if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then');
  lines.push('  cat > /etc/systemd/system/hermes-buddy-channel.service <<SVCEOF');
  lines.push('[Unit]');
  lines.push('Description=Hermes Buddy WS tool channel (external component)');
  lines.push('After=network.target');
  lines.push('');
  lines.push('[Service]');
  lines.push('Type=simple');
  lines.push('Environment=HERMES_HOME=$HERMES_HOME');
  lines.push('Environment=BUDDY_CHANNEL_PORT=$CHANNEL_PORT');
  lines.push('Environment=API_SERVER_KEY=$PROXY_KEY');
  lines.push('ExecStart=/usr/bin/env python3 $CHANNEL_FILE');
  lines.push('Restart=always');
  lines.push('RestartSec=2');
  lines.push('');
  lines.push('[Install]');
  lines.push('WantedBy=multi-user.target');
  lines.push('SVCEOF');
  lines.push('  systemctl daemon-reload 2>&1 | sed \'s/^/  /\' || true');
  lines.push('  systemctl enable --now hermes-buddy-channel 2>&1 | sed \'s/^/  /\' || true');
  lines.push('  sleep 3');
  lines.push('  systemctl is-active hermes-buddy-channel 2>&1 | sed \'s/^/  /\' || true');
  lines.push('else');
  lines.push('  pkill -f "buddy-channel.py" 2>/dev/null || true');
  lines.push('  nohup python3 "$CHANNEL_FILE" >> "$HERMES_HOME/logs/buddy-channel.log" 2>&1 &');
  lines.push('  sleep 3');
  lines.push('fi');
  lines.push('CHANNEL_UP=0');
  lines.push('if curl -s -m 5 "http://127.0.0.1:${CHANNEL_PORT}/health" >/dev/null 2>&1; then CHANNEL_UP=1; fi');
  lines.push('if [[ "$CHANNEL_UP" == "1" ]]; then');
  lines.push('  echo "  通道已就绪: ws://0.0.0.0:$CHANNEL_PORT/api/buddy/channel (用 Gateway API Key 鉴权)"');
  lines.push('else');
  lines.push('  echo "  WARN: 通道未监听 $CHANNEL_PORT。buddy-channel.log 末尾:"');
  lines.push('  tail -n 20 "$HERMES_HOME/logs/buddy-channel.log" 2>/dev/null || true');
  lines.push('fi');
  lines.push('');
  lines.push('echo "[buddy-bootstrap] ---- 4i. 通道模式结论 ----"');
  lines.push('echo "  通道模式（决策在服务器）连接填写:"');
  lines.push('echo "    Gateway 地址: http://' + host + ':' + (gatewayPort || 22122) + '（用于会话登记，可选）"');
  lines.push('echo "    API Key: $API_KEY"');
  lines.push('echo "    在连接向导里选「通道模式」，或把推理端点留空并填 ws://' + host + ':$CHANNEL_PORT/api/buddy/channel"');

  return lines.join('\n') + '\n';
}

function clampPort(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 1 || n > 65535) return fallback;
  return Math.trunc(n);
}

module.exports = { generateBootstrapScript, clampPort };
