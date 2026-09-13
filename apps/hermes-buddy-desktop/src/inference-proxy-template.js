'use strict';

/**
 * Hermes 推理直通代理（Inference Pass-through Proxy）—— Python 源码模板。
 *
 * 为什么需要它（架构背景，2026-09-14 实测定论）：
 * - Buddy 的架构是「决策在远端、工具在本地执行」，要求端点具备一种语义：
 *   「收到 messages + tools，返回一个 tool_call，但**不执行**它」。
 * - Hermes Gateway（22122）的 /v1/chat/completions 是另一种语义：
 *   「收到 messages，在**服务端**跑完整 agent 循环（含工具），返回最终文本」。
 *   实测：请求里的 tools 被完全忽略、注入约 1.2 万 token 自有系统提示、
 *   在服务器本地真的执行 `ls /root`。
 * - 路由表实测：22122 上只有 /v1/models、/v1/chat/completions、/v1/responses、
 *   /health、/api/sessions 五个端点；/api/proxy、/api/passthrough、/api/inference、
 *   /api/models、/api/providers 全是 404，也没有 openapi.json。
 *   **即 Hermes 当前没有对外暴露任何「纯推理」能力。**
 * - hermes proxy 只转发 OAuth 供应商（nous/xai），不是本地模型代理，也用不上。
 *
 * 结论：在不动 Hermes 源码的前提下，正确做法是在 Hermes 主机上跑一个极薄的
 * 直通代理——它复用 Hermes 自己配好的上游（base_url / model / api_key），
 * 对外提供标准 OpenAI 兼容接口并**原样透传 tools**，用 Gateway 的 API Key 鉴权。
 * 这样：
 *   · Buddy 只填「Hermes 主机 + API Key」，不碰任何上游供应商配置；
 *   · 上游密钥永远不出服务器；
 *   · 换供应商只改 Hermes 配置，所有 Buddy 客户端自动跟随。
 *
 * 设计约束：
 * - 零第三方依赖（只許标准库），因为不能假设服务器装了什么；
 * - 不自己实现 YAML 全量解析：优先 pyyaml（Hermes 自己依赖它），失败降级到内置子集解析器；
 * - 上游路径自动探测（方舟有 /api/v3 与 /api/coding/v3 两种形态）；
 * - 支持 stream（SSE）透传，否则 Buddy 的流式输出会坏。
 */

/** 返回 Python 源码（bash heredoc <<'PYEOF' 安全：不做变量替换）。 */
function pythonSource() {
  const src = String.raw`#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Hermes Buddy 推理直通代理 —— 由 Buddy 服务端准备脚本自动生成。

作用：把 Hermes 自己配置好的上游推理端点（OpenAI 兼容）原样暴露给 Buddy，
不做任何 agent 编排、不注入系统提示、不吞 tools 参数。

配置来源（优先级从高到低）：
  1. 环境变量 BUDDY_UPSTREAM_BASE / BUDDY_UPSTREAM_KEY / BUDDY_UPSTREAM_MODEL / BUDDY_UPSTREAM_CHAT_PATH
  2. <hermes_home>/buddy-proxy.env（脚本探测成功后写入）
  3. <hermes_home>/config.yaml 的 model 段 + <hermes_home>/.env
"""
import json
import os
import re
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERMES_HOME = os.environ.get("HERMES_HOME", "/root/.hermes")
CONFIG_YAML = os.path.join(HERMES_HOME, "config.yaml")
DOTENV = os.path.join(HERMES_HOME, ".env")
PROXY_ENV = os.path.join(HERMES_HOME, "buddy-proxy.env")
LISTEN_HOST = os.environ.get("BUDDY_PROXY_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("BUDDY_PROXY_PORT", "8811"))
UPSTREAM_TIMEOUT = float(os.environ.get("BUDDY_UPSTREAM_TIMEOUT", "300"))

LOCK = threading.Lock()
STATE = {"base": "", "key": "", "model": "", "chat_path": ""}


# ---------------------------------------------------------------- 基础工具

def mask(secret):
    if not secret:
        return "(empty)"
    s = str(secret)
    if len(s) <= 8:
        return s[0] + "****"
    return s[:4] + "****" + s[-4:]


def read_env_file(path):
    out = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, val = line.split("=", 1)
                out[key.strip()] = val.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


def expand(value, env):
    if not isinstance(value, str):
        return value or ""
    def repl(m):
        name = m.group(1)
        return env.get(name) or os.environ.get(name) or ""
    return re.sub(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?", repl, value)


# ---------------------------------------------------------------- YAML（子集解析，兜底）

def load_yaml_simple(path):
    """解析 YAML 的常用子集：嵌套 mapping、短横线 list、标量、引号。够读 config.yaml 的 model 段。"""
    root = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            raw_lines = fh.readlines()
    except OSError:
        return root

    # 去掉注释与空行（行内 # 只在前面是空格/行首时才算注释，避免误伤包含 # 的字符串）
    lines = []
    for raw in raw_lines:
        line = raw.rstrip("\n").rstrip()
        if not line.strip() or line.strip().startswith("#"):
            continue
        stripped = re.sub(r"\s+#.*$", "", line) if not line.strip().startswith("-") else line
        lines.append((len(stripped) - len(stripped.lstrip(" ")), stripped.strip()))

    # stack: list of (indent, container)
    stack = [(-1, root)]

    def scalar(tok):
        tok = tok.strip()
        if tok in ("", "null", "~", "None"):
            return None
        if tok.lower() in ("true", "yes"):
            return True
        if tok.lower() in ("false", "no"):
            return False
        if (tok.startswith('"') and tok.endswith('"')) or (tok.startswith("'") and tok.endswith("'")):
            return tok[1:-1]
        try:
            return int(tok)
        except ValueError:
            pass
        try:
            return float(tok)
        except ValueError:
            pass
        return tok

    i = 0
    while i < len(lines):
        indent, text = lines[i]
        while stack and stack[-1][0] >= indent:
            stack.pop()
        parent = stack[-1][1]

        if text.startswith("- "):
            if not isinstance(parent, list):
                continue
            item = text[2:].strip()
            if ":" in item and not item.startswith(('"', "'")):
                # list 里的 mapping
                sub = {}
                parent.append(sub)
                stack.append((indent + 2, sub))
                k, v = item.split(":", 1)
                v = v.strip()
                if v:
                    sub[k.strip()] = scalar(v)
                else:
                    stack.append((indent + 2 + (len(item) - len(item.lstrip())), sub))
            else:
                parent.append(scalar(item))
            i += 1
            continue

        if ":" not in text:
            i += 1
            continue

        key, val = text.split(":", 1)
        key = key.strip().strip('"').strip("'")
        val = val.strip()
        if val == "":
            # 可能是下一层的 mapping 或 list
            nxt = lines[i + 1][0] if i + 1 < len(lines) else -1
            child = [] if (i + 1 < len(lines) and lines[i + 1][1].startswith("- ")) else {}
            if isinstance(parent, dict):
                parent[key] = child
            stack.append((indent, child))
        else:
            if isinstance(parent, dict):
                parent[key] = scalar(val)
        i += 1

    return root


def load_yaml(path):
    try:
        import yaml  # type: ignore
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            data = yaml.safe_load(fh)
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return load_yaml_simple(path)


def dig(obj, *keys):
    """在嵌套结构里找第一个命中的键（广度优先），返回值或 ''。"""
    from collections import deque
    q = deque([obj])
    seen = 0
    while q and seen < 4000:
        cur = q.popleft()
        seen += 1
        if isinstance(cur, dict):
            for k in keys:
                if k in cur and isinstance(cur[k], (str, int, float)) and cur[k] not in ("", None):
                    return str(cur[k])
            for v in cur.values():
                if isinstance(v, (dict, list)):
                    q.append(v)
        elif isinstance(cur, list):
            for v in cur:
                if isinstance(v, (dict, list)):
                    q.append(v)
    return ""


ENV_KEY_HINTS = (
    "ARK_API_KEY", "OPENAI_API_KEY", "CUSTOM_API_KEY", "LLM_API_KEY",
    "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY",
    "DASHSCOPE_API_KEY", "API_KEY", "OPENROUTER_API_KEY", "TOGETHER_API_KEY",
)


def discover_upstream():
    env = read_env_file(DOTENV)
    proxy_env = read_env_file(PROXY_ENV)
    cfg = load_yaml(CONFIG_YAML) if os.path.exists(CONFIG_YAML) else {}
    model = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}

    base = (os.environ.get("BUDDY_UPSTREAM_BASE")
            or proxy_env.get("BUDDY_UPSTREAM_BASE")
            or model.get("base_url") or model.get("base-url") or model.get("endpoint")
            or dig(cfg, "base_url", "base-url", "endpoint")
            or env.get("OPENAI_BASE_URL") or "")

    name = (os.environ.get("BUDDY_UPSTREAM_MODEL")
            or proxy_env.get("BUDDY_UPSTREAM_MODEL")
            or model.get("name") or model.get("model") or model.get("model_name")
            or env.get("OPENAI_MODEL") or "hermes-agent")

    key = (os.environ.get("BUDDY_UPSTREAM_KEY")
           or proxy_env.get("BUDDY_UPSTREAM_KEY")
           or (model.get("api_key") or model.get("apiKey") or "")
           or dig(model, "api_key", "apiKey", "key", "token")
           or "")
    if not key:
        for hint in ENV_KEY_HINTS:
            if env.get(hint) and hint != "API_SERVER_KEY":
                key = env[hint]
                break

    base = expand(base, env)
    name = expand(name, env)
    key = expand(key, env)

    chat_path = (os.environ.get("BUDDY_UPSTREAM_CHAT_PATH")
                 or proxy_env.get("BUDDY_UPSTREAM_CHAT_PATH") or "")

    with LOCK:
        STATE["base"] = str(base).rstrip("/")
        STATE["key"] = str(key)
        STATE["model"] = str(name)
        STATE["chat_path"] = str(chat_path)
    return STATE["base"], STATE["key"], STATE["model"], STATE["chat_path"]


def chat_url():
    base = STATE["base"]
    if not base:
        return ""
    if STATE["chat_path"]:
        return base + STATE["chat_path"]
    if base.endswith("/chat/completions"):
        return base
    if re.search(r"/v\d+$", base):
        return base + "/chat/completions"
    return base + "/v1/chat/completions"


def models_url():
    base = STATE["base"]
    if not base:
        return ""
    if re.search(r"/v\d+$", base):
        return base + "/models"
    return base + "/v1/models"


# ---------------------------------------------------------------- 鉴权

def expected_token():
    env = read_env_file(DOTENV)
    proxy_env = read_env_file(PROXY_ENV)
    return (os.environ.get("BUDDY_PROXY_KEY")
            or proxy_env.get("BUDDY_PROXY_KEY")
            or env.get("API_SERVER_KEY")
            or os.environ.get("API_SERVER_KEY") or "")


def authorized(handler):
    token = expected_token()
    if not token:
        return True  # 服务端没配 key 就不强制（内网场景）
    header = handler.headers.get("Authorization", "") or ""
    if header.startswith("Bearer "):
        return header[7:].strip() == token
    return header.strip() == token


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "hermes-buddy-inference/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[buddy-proxy] %s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, payload, ctype="application/json"):
        if isinstance(payload, (dict, list)):
            body = json.dumps(payload).encode("utf-8")
        elif isinstance(payload, str):
            body = payload.encode("utf-8")
        else:
            body = payload
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _unauthorized(self):
        self._send(401, {"error": {"message": "unauthorized: 需要 Hermes 的 API Key（Bearer）",
                                   "type": "invalid_request_error"}})

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/health", "/healthz", "/"):
            self._send(200, {"ok": True, "service": "hermes-buddy-inference",
                             "upstream_base": STATE["base"],
                             "upstream_model": STATE["model"],
                             "upstream_key": mask(STATE["key"])})
            return
        if not authorized(self):
            return self._unauthorized()
        if path.endswith("/models"):
            return self._proxy_models()
        self._send(404, {"error": {"message": "not found: " + path}})

    def do_POST(self):
        # 先无条件消费请求体：HTTP/1.1 keep-alive 下，鉴权失败就直接返回会把 body 留在
        # socket 缓冲区里，下一个请求会把它当成请求行，报 "Unsupported method ('{...}POST')"。
        raw = self._read_body()
        if not authorized(self):
            self.close_connection = True
            return self._unauthorized()
        path = self.path.split("?")[0]
        if path.endswith("/chat/completions"):
            return self._proxy_chat(raw)
        if path.endswith("/models"):
            return self._proxy_models()
        self._send(404, {"error": {"message": "not found: " + path}})

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _proxy_models(self):
        url = models_url()
        if not url:
            return self._send(200, {"object": "list",
                                    "data": [{"id": STATE["model"] or "hermes-agent",
                                              "object": "model", "owned_by": "hermes"}]})
        try:
            req = urllib.request.Request(url, headers={"Authorization": "Bearer " + STATE["key"]})
            with urllib.request.urlopen(req, timeout=30) as resp:
                self._send(resp.status, resp.read())
        except Exception as exc:
            self._send(200, {"object": "list",
                             "data": [{"id": STATE["model"] or "hermes-agent",
                                       "object": "model", "owned_by": "hermes"}],
                             "warning": "upstream models fetch failed: %s" % exc})

    def _proxy_chat(self, raw=None):
        # 每次请求重读配置（读两个小文件，开销可忽略），这样改了 buddy-proxy.env 即刻生效，无需重启
        if os.environ.get("BUDDY_DISCOVER_EVERY", "1") != "0":
            discover_upstream()
        url = chat_url()
        if not url:
            return self._send(500, {"error": {"message":
                "上游未配置：在 %s 里写 BUDDY_UPSTREAM_BASE / BUDDY_UPSTREAM_KEY，或确保 config.yaml 的 model.base_url 可读"
                % PROXY_ENV}})

        if raw is None:
            raw = self._read_body()
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            return self._send(400, {"error": {"message": "请求体不是合法 JSON"}})

        # 只在客户端没指定 model 时才补默认模型；其余字段（含 tools / tool_choice / stream）原样透传
        if not payload.get("model") and STATE["model"]:
            payload["model"] = STATE["model"]

        data = json.dumps(payload).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + STATE["key"],
            "Accept": "text/event-stream" if payload.get("stream") else "application/json",
        }
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")

        try:
            resp = urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT)
        except urllib.error.HTTPError as exc:
            detail = exc.read()
            sys.stderr.write("[buddy-proxy] upstream %s -> %s\n" % (url, exc.code))
            return self._send(exc.code, detail or b'{"error":"upstream error"}')
        except Exception as exc:
            sys.stderr.write("[buddy-proxy] upstream error: %s\n" % exc)
            return self._send(502, {"error": {"message": "上游不可达: %s" % exc, "upstream": url}})

        if payload.get("stream"):
            # SSE 无法预知长度，响应结束就关掉这条连接，避免 keep-alive 复用出错
            self.close_connection = True
            self.send_response(resp.status)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            try:
                while True:
                    chunk = resp.read(4096)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                try:
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except Exception:
                    pass
                resp.close()
            return

        body = resp.read()
        resp.close()
        ctype = resp.headers.get("Content-Type", "application/json")
        self._send(resp.status, body, ctype)


def main():
    base, key, model, chat_path = discover_upstream()
    sys.stderr.write("[buddy-proxy] HERMES_HOME = %s\n" % HERMES_HOME)
    sys.stderr.write("[buddy-proxy] upstream base  = %s\n" % (base or "(未配置)"))
    sys.stderr.write("[buddy-proxy] upstream model = %s\n" % model)
    sys.stderr.write("[buddy-proxy] upstream key   = %s\n" % mask(key))
    sys.stderr.write("[buddy-proxy] chat endpoint  = %s\n" % (chat_url() or "(未配置)"))
    if not base or not key:
        sys.stderr.write("[buddy-proxy] WARN: 上游 base_url 或 api_key 缺失，代理会启动但无法转发\n")
    sys.stderr.write("[buddy-proxy] listening on %s:%d\n" % (LISTEN_HOST, LISTEN_PORT))
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
`;
  return src;
}

module.exports = { pythonSource };
