#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Hermes Buddy · WS 工具通道（外挂组件） —— 由 Buddy 服务端准备脚本部署。

职责（不像 8811 代理那样透传，而是真正跑 Agent 循环）：
  1. 读 Hermes 自己配好的上游模型（config.yaml + .env，逻辑复用推理直通代理）；
  2. 通过 WebSocket 与已连接的 Buddy 通信：把 LLM 产生的工具调用卸载到 Buddy 本地执行，
     把工具结果回灌模型，直到任务结束；
  3. 助手文本通过 WS 流式回传，决策始终在服务器侧。

设计约束（与推理直通代理一致）：
  · 零第三方依赖（只用标准库）——不假设服务器装了什么；
  · 不自己实现 YAML 全量解析：优先 pyyaml，失败降级到内置子集解析器；
  · 鉴权复用 Hermes 的 API_SERVER_KEY。

mock 模式（部署/联调用，不连真实模型）：
  BUDDY_CHANNEL_MOCK_LLM=1 时，LLM 由本地脚本替代，用于验证"卸载→执行→回灌"闭环，
  以及命令护栏的 tool_rejected 路径。
"""

import base64
import hashlib
import json
import os
import re
import struct
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CHANNEL_VERSION = "1.2"

HERMES_HOME = os.environ.get("HERMES_HOME", "/root/.hermes")
CONFIG_YAML = os.path.join(HERMES_HOME, "config.yaml")
DOTENV = os.path.join(HERMES_HOME, ".env")
PROXY_ENV = os.path.join(HERMES_HOME, "buddy-proxy.env")
LISTEN_HOST = os.environ.get("BUDDY_CHANNEL_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("BUDDY_CHANNEL_PORT", "8822"))
UPSTREAM_TIMEOUT = float(os.environ.get("BUDDY_UPSTREAM_TIMEOUT", "300"))
TOOL_TIMEOUT = float(os.environ.get("BUDDY_TOOL_TIMEOUT", "300"))
MAX_TURNS = int(os.environ.get("BUDDY_CHANNEL_MAX_TURNS", "24"))
MOCK_LLM = os.environ.get("BUDDY_CHANNEL_MOCK_LLM", "0") == "1"

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
LOCK = threading.Lock()
STATE = {"base": "", "key": "", "model": "", "chat_path": ""}
SESSIONS = {}  # session_id -> Session


# ----------------------------------------------------------------- 配置发现（复用推理代理逻辑）

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


def load_yaml_simple(path):
    root = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            raw_lines = fh.readlines()
    except OSError:
        return root
    lines = []
    for raw in raw_lines:
        line = raw.rstrip("\n").rstrip()
        if not line.strip() or line.strip().startswith("#"):
            continue
        stripped = re.sub(r"\s+#.*$", "", line) if not line.strip().startswith("-") else line
        lines.append((len(stripped) - len(stripped.lstrip(" ")), stripped.strip()))
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
                i += 1
                continue
            item = text[2:].strip()
            if ":" in item and not item.startswith(('"', "'")):
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

    # If model.provider is set, look it up in the providers list first.
    # This handles the model-router pattern where the provider entry has the real
    # base_url and api_key, while the model section itself has neither.
    provider_name = model.get("provider") or ""
    provider_match = {}
    if provider_name:
        # Hermes uses "custom_providers" (newer) or "providers" (older)
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

    base = (os.environ.get("BUDDY_UPSTREAM_BASE")
            or proxy_env.get("BUDDY_UPSTREAM_BASE")
            or provider_match.get("base_url") or provider_match.get("base-url") or provider_match.get("endpoint")
            or model.get("base_url") or model.get("base-url") or model.get("endpoint")
            or env.get("OPENAI_BASE_URL") or "")

    name = (os.environ.get("BUDDY_UPSTREAM_MODEL")
            or proxy_env.get("BUDDY_UPSTREAM_MODEL")
            or model.get("name") or model.get("model") or model.get("model_name")
            or model.get("default")
            or env.get("OPENAI_MODEL") or "hermes-agent")

    key = (os.environ.get("BUDDY_UPSTREAM_KEY")
           or proxy_env.get("BUDDY_UPSTREAM_KEY")
           or provider_match.get("api_key") or provider_match.get("apiKey") or ""
           or model.get("api_key") or model.get("apiKey") or "")
    if not key:
        key = (dig(model, "api_key", "apiKey", "key", "token") or "")
    if not key:
        for hint in ENV_KEY_HINTS:
            if env.get(hint) and hint != "API_SERVER_KEY":
                key = env[hint]
                break

    # Only fall back to the broad dig if provider lookup didn't give us a base
    if not base:
        base = (dig(cfg, "base_url", "base-url", "endpoint") or "")

    base = expand(base, env)
    name = expand(name, env)
    key = expand(key, env)
    chat_path = (os.environ.get("BUDDY_UPSTREAM_CHAT_PATH")
                 or proxy_env.get("BUDDY_UPSTREAM_CHAT_PATH") or "")
    with LOCK:
        STATE["base"] = str(base).rstrip("/")
        STATE["model"] = str(name)
        STATE["key"] = str(key)
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
    """上游 /models 端点（OpenAI 兼容）。

    base 可能是 https://x 、 https://x/v1 或 https://x/v1/chat/completions，
    统一归一到 .../models。
    """
    base = STATE["base"]
    if not base:
        return ""
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    if re.search(r"/v\d+$", base):
        return base + "/models"
    return base + "/v1/models"


# 运行期发现的「上游不接受」的模型名。上游 /models 往往会把账号下所有模型都列出来，
# 但真正能聊的只是一部分（典型：火山方舟 Ark 的 coding plan 端点只接受特定模型，
# 选错了就 404 UnsupportedModel）。这里记下被打回的模型，后续 list_models 不再返回。
UNSUPPORTED_MODELS = set()


def _flatten_names(items):
    """把 /models 返回的条目（字符串或 dict）平铺成模型名列表。"""
    out = []
    for x in items or []:
        if isinstance(x, str):
            if x.strip():
                out.append(x.strip())
        elif isinstance(x, dict):
            for k in ("id", "name", "model", "model_id"):
                v = x.get(k)
                if isinstance(v, str) and v.strip():
                    out.append(v.strip())
                    break
    return out


def _collect_cfg_models():
    """从 Hermes config.yaml 收集「声明过的」模型名，作为 /models 拿不到时的补充。

    注意：这只是配置里写的名字，不保证上游真的存在，所以只在 /models 失败时兜底。
    """
    cfg = load_yaml(CONFIG_YAML) if os.path.exists(CONFIG_YAML) else {}
    if not isinstance(cfg, dict):
        return []
    raw = []
    model = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
    for k in ("models", "available_models", "model_list", "fallbacks"):
        v = model.get(k)
        if isinstance(v, (list, dict)):
            raw.append(v)
    for pk in ("custom_providers", "providers"):
        plist = cfg.get(pk) if isinstance(cfg.get(pk), list) else None
        if not plist:
            continue
        for p in plist:
            if not isinstance(p, dict):
                continue
            for k in ("models", "model_list", "available_models"):
                v = p.get(k)
                if isinstance(v, (list, dict)):
                    raw.append(v)
            # provider 也可能只声明单个默认模型
            for k in ("default_model", "model", "name"):
                v = p.get(k)
                if isinstance(v, str) and v.strip():
                    raw.append([v])
    out = []
    for item in raw:
        if isinstance(item, dict):
            # {"model-a": {...}, "model-b": {...}} 这种映射形式
            out.extend([k for k in item.keys() if isinstance(k, str) and k.strip()])
        else:
            out.extend(_flatten_names(item))
    return out


def list_upstream_models():
    """尽力拿到可用模型列表：上游 /models 优先，config.yaml 声明作补充。

    返回的列表保证：当前默认模型排第一位；拿不到任何东西时至少给回默认模型，
    这样 UI 的下拉永远有东西可选（不会退回写死的 hermes-agent）。
    """
    ids = []
    url = models_url()
    if url:
        try:
            req = urllib.request.Request(url, headers={
                "Authorization": "Bearer " + STATE["key"],
                "Accept": "application/json",
            }, method="GET")
            resp = urllib.request.urlopen(req, timeout=15)
            try:
                body = json.loads(resp.read().decode("utf-8", "replace"))
            finally:
                try:
                    resp.close()
                except Exception:  # noqa: BLE001
                    pass
            data = body.get("data") if isinstance(body, dict) else body
            ids = _flatten_names(data if isinstance(data, list) else [])
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write("[channel] list models failed: %s\n" % exc)
    # /models 拿不到（或拿到了但为空）时用 config.yaml 兜底
    if not ids:
        ids = _collect_cfg_models()
    default = (STATE["model"] or "").strip()
    merged = []
    seen = set()
    if default and default not in UNSUPPORTED_MODELS:
        merged.append(default)
        seen.add(default)
    for m in ids:
        if m and m not in seen and m not in UNSUPPORTED_MODELS:
            seen.add(m)
            merged.append(m)
    if not merged and default:
        # 极端情况：所有候选都被打回过，至少保留默认模型，别让 UI 下拉变成空白
        merged.append(default)
    return merged


def expected_token():
    env = read_env_file(DOTENV)
    proxy_env = read_env_file(PROXY_ENV)
    # 优先读 .api_server_key 文件（deploy.sh 和 ssh-check 都写这个）
    key_file = os.path.join(HERMES_HOME, ".api_server_key")
    file_key = ""
    try:
        with open(key_file, "r", encoding="utf-8", errors="replace") as fh:
            file_key = fh.read().strip()
    except OSError:
        pass
    return (os.environ.get("BUDDY_CHANNEL_KEY")
            or proxy_env.get("BUDDY_CHANNEL_KEY")
            or env.get("API_SERVER_KEY")
            or file_key
            or os.environ.get("API_SERVER_KEY") or "")


# ----------------------------------------------------------------- 工具 schema（服务端广播给 LLM）

TOOL_SCHEMAS = [
    {"type": "function", "function": {
        "name": "run_command",
        "description": "在用户 Windows 电脑的工作目录中执行 PowerShell 命令。命令在独立进程中运行，默认工作目录已设为工作区根目录。不要用 ssh 连接其他机器。注意：工作目录可能是大型网络同步盘，递归遍历整盘的命令会很慢、易超时。",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string", "description": "要执行的 PowerShell 命令或脚本，可多行"},
            "cwd": {"type": "string", "description": "可选，相对工作区的子目录；留空则在工作区根目录执行"},
            "timeout_seconds": {"type": "number", "description": "可选，超时秒数，默认 120，最大 600"}
        }, "required": ["command"]}}},
    {"type": "function", "function": {
        "name": "read_file",
        "description": "读取工作区内文本文件的内容，带行号。",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "相对工作区的文件路径"},
            "offset": {"type": "number", "description": "可选，从第几行开始（0 基）"},
            "limit": {"type": "number", "description": "可选，最多读多少行"}
        }, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "write_file",
        "description": "写入或覆盖工作区内的文件。父目录会自动创建。修改已有文件前请先 read_file。",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "相对工作区的文件路径"},
            "content": {"type": "string", "description": "文件完整内容"}
        }, "required": ["path", "content"]}}},
    {"type": "function", "function": {
        "name": "list_dir",
        "description": "列出工作区内的目录结构，用于了解项目布局。",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "相对工作区的目录，留空为根目录"},
            "depth": {"type": "number", "description": "可选，递归层数，默认 1，最大 4"}
        }, "required": []}}},
    {"type": "function", "function": {
        "name": "find_files",
        "description": "按名称/扩展名查找文件，支持 * 和 ** 通配。自动跳过 node_modules/.git/dist，限制扫描数，大目录也快。",
        "parameters": {"type": "object", "properties": {
            "pattern": {"type": "string", "description": "文件名模式，可逗号分隔多个，例如 *.pem,*.key"},
            "path": {"type": "string", "description": "可选，限定在某个子目录下查找"},
            "maxDepth": {"type": "number", "description": "可选，最多下钻层数，默认不限制"}
        }, "required": ["pattern"]}}},
    {"type": "function", "function": {
        "name": "search_content",
        "description": "在工作区文件内容中搜索（支持正则），返回文件名、行号和内容。",
        "parameters": {"type": "object", "properties": {
            "pattern": {"type": "string", "description": "要搜索的文本或正则表达式"},
            "path": {"type": "string", "description": "可选，限定搜索目录"},
            "filePattern": {"type": "string", "description": "可选，只搜索符合该名称模式的文件，如 *.js"},
            "maxResults": {"type": "number", "description": "可选，最多返回多少条，默认 50"}
        }, "required": ["pattern"]}}},
    {"type": "function", "function": {
        "name": "system_info",
        "description": "查看这台 Windows 电脑的基本信息：CPU、内存、系统版本、工作区路径等。",
        "parameters": {"type": "object", "properties": {}, "required": []}}},
]

TOOL_NAMES = [t["function"]["name"] for t in TOOL_SCHEMAS]


SYSTEM_PROMPT = (
    "你是 Hermes Buddy，一个运行在用户 Windows 电脑上的本地助手。"
    "所有工具都在用户的 Windows 机器上、且被限制在一个工作目录（workspace）内执行；"
    "你拿不到工作区之外的任何路径，也拿不到任何程序对象，只能拿到工具返回的文本。"
    "危险命令（格式化磁盘、关机、删系统目录等）会被客户端的安全规则拦截，"
    "被拦截时请换一种安全的方式完成任务，或向用户说明无法执行。"
    "优先用 find_files/search_content 而非递归遍历整盘。"
)


# ----------------------------------------------------------------- LLM 调用

class UpstreamError(RuntimeError):
    """上游（LLM 供应商）返回的错误，带结构化 code / HTTP status / 给用户的建议。"""

    def __init__(self, message, code="upstream_error", status=0, hint="", detail=""):
        RuntimeError.__init__(self, message)
        self.code = code
        self.status = status
        self.hint = hint
        self.detail = detail


def _upstream_error_fields(raw):
    """从上游响应体里剥出 (code, message)。非 JSON 时原样返回。"""
    try:
        body = json.loads(raw or "")
    except Exception:  # noqa: BLE001
        return "", (raw or "").strip()
    if not isinstance(body, dict):
        return "", (raw or "").strip()
    err = body.get("error")
    if not isinstance(err, dict):
        err = body
    code = str(err.get("code") or err.get("type") or "").strip()
    message = str(err.get("message") or err.get("msg") or "").strip() or (raw or "").strip()
    return code, message


def _is_model_unsupported(code, message):
    """判断上游是不是在说「这个模型我用不了」。"""
    c = (code or "").lower().replace("_", "").replace("-", "")
    if c in ("unsupportedmodel", "modelunsupported", "modelnotsupported",
             "invalidmodel", "modelnotfound", "modeldoesnotexist", "modelnotexist"):
        return True
    m = (message or "").lower()
    return ("model" in m and "does not support" in m) or "unsupported model" in m


def call_llm(messages, tools, signal_broken, model=None):
    """返回 { content, tool_calls:[{id,name,arguments}] }。mock 模式走脚本。

    model：本轮要用的模型（来自客户端 user_message.model）；留空则用全局默认。
    """
    if MOCK_LLM:
        return mock_llm(messages, tools)
    url = chat_url()
    if not url:
        raise RuntimeError("上游未配置：在 %s 或 config.yaml 的 model.base_url 写入上游" % PROXY_ENV)
    payload_model = model or STATE["model"] or "hermes-agent"
    payload = {
        "model": payload_model,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "stream": False,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + STATE["key"],
        "Accept": "application/json",
    }, method="POST")
    try:
        resp = urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT)
    except urllib.error.HTTPError as exc:
        raw = ""
        try:
            raw = exc.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            pass
        code, detail = _upstream_error_fields(raw)
        if _is_model_unsupported(code, detail):
            UNSUPPORTED_MODELS.add(payload_model)
            raise UpstreamError(
                "上游不接受模型 %s（HTTP %s，%s）：%s" % (
                    payload_model, exc.code, code or "upstream error", detail[:200] or "无详细信息"),
                code="model_unsupported", status=exc.code,
                hint="该模型不被当前上游支持（例如火山方舟 coding plan 端点只接受特定模型）。"
                     "本轮已自动改用默认模型继续；若仍失败，请在智能体配置里换一个模型。",
                detail=detail,
            )
        raise UpstreamError(
            "上游返回 HTTP %s%s：%s" % (exc.code, "（%s）" % code if code else "",
                                    detail[:300] or raw[:300] or "无响应内容"),
            code=code or "upstream_http_error", status=exc.code, detail=detail,
        )
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("上游不可达: %s" % exc)
    body = json.loads(resp.read().decode("utf-8"))
    choice = body["choices"][0]
    msg = choice.get("message") or {}
    calls = []
    for c in (msg.get("tool_calls") or []):
        args = c.get("function", {}).get("arguments", "{}")
        try:
            arguments = json.loads(args) if isinstance(args, str) else args
        except Exception:  # noqa: BLE001
            arguments = {"_raw": args}
        calls.append({"id": c.get("id") or "call_%d" % len(calls),
                      "name": c.get("function", {}).get("name", ""),
                      "arguments": arguments})
    return {"content": msg.get("content") or "", "tool_calls": calls}


def mock_llm(messages, tools):
    """脚本化 3 步：echo → 护栏拒绝命令(format c:) → 收尾，验证卸载/护栏/回灌闭环。"""
    tool_msgs = [m for m in messages if m.get("role") == "tool"]
    n = len(tool_msgs)
    if n == 0:
        return {"content": "", "tool_calls": [{
            "id": "call_mock_1",
            "name": "run_command",
            "arguments": {"command": "echo channel-ok", "timeout_seconds": 30},
        }]}
    if n == 1:
        # 这条会被客户端的 CommandGuard 硬拒绝，验证 tool_rejected 回灌路径。
        return {"content": "", "tool_calls": [{
            "id": "call_mock_2",
            "name": "run_command",
            "arguments": {"command": "format c:", "timeout_seconds": 30},
        }]}
    return {"content": "GUARD_PROBE_DONE", "tool_calls": []}


# ----------------------------------------------------------------- WebSocket 帧编解码

def ws_accept(key):
    return base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()


def encode_frame(opcode, payload):
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    n = len(payload)
    if n <= 125:
        header = struct.pack("!BB", 0x80 | opcode, n)
    elif n <= 65535:
        header = struct.pack("!BBH", 0x80 | opcode, 126, n)
    else:
        header = struct.pack("!BBQ", 0x80 | opcode, 127, n)
    return header + payload


def decode_frame(buf):
    """从 buf 中解析出一个完整帧，返回 (frame, rest)。frame=None 表示数据不足。"""
    if len(buf) < 2:
        return None, buf
    b0, b1 = buf[0], buf[1]
    fin = (b0 & 0x80) != 0
    opcode = b0 & 0x0F
    masked = (b1 & 0x80) != 0
    length = b1 & 0x7F
    idx = 2
    if length == 126:
        if len(buf) < idx + 2:
            return None, buf
        length = struct.unpack("!H", buf[idx:idx + 2])[0]
        idx += 2
    elif length == 127:
        if len(buf) < idx + 8:
            return None, buf
        length = struct.unpack("!Q", buf[idx:idx + 8])[0]
        idx += 8
    if masked:
        if len(buf) < idx + 4:
            return None, buf
        mask = buf[idx:idx + 4]
        idx += 4
    if len(buf) < idx + length:
        return None, buf
    payload = buf[idx:idx + length]
    if masked:
        payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))
    return {"fin": fin, "opcode": opcode, "payload": payload}, buf[idx + length:]


# ----------------------------------------------------------------- Session / Agent 循环

class Session:
    def __init__(self, conn, sid):
        self.conn = conn
        self.sid = sid
        self.messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        self.pending = {}            # id -> {"event": Event, "result": None}
        self.lock = threading.Lock()
        self.cancel_event = threading.Event()
        self.running = False
        self.model = None            # 客户端指定的模型（user_message.model）
        self._model_fallback = False  # 本会话是否已因「模型不被支持」回退过

    def send(self, obj):
        try:
            self.conn.send_json(obj)
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write("[channel] send failed: %s\n" % exc)

    def _call_llm_with_fallback(self):
        """调上游；模型被上游拒绝（如 coding plan 不支持）时自动改用默认模型重试一次。"""
        try:
            return call_llm(self.messages, TOOL_SCHEMAS, self.cancel_event.is_set, self.model)
        except UpstreamError as exc:
            default = (STATE["model"] or "").strip()
            if (exc.code != "model_unsupported" or self._model_fallback
                    or not default or default == (self.model or "").strip()):
                raise
            self._model_fallback = True
            bad = (self.model or "").strip() or default
            self.model = default
            self.send({"type": "status", "session": self.sid,
                       "text": "模型 %s 不被上游支持，已自动改用默认模型 %s" % (bad, default)})
            return call_llm(self.messages, TOOL_SCHEMAS, self.cancel_event.is_set, self.model)

    def run_task(self, user_text, history, model=None):
        self.running = True
        # 模型按会话记住：后续轮次（工具回灌后再问）继续用用户选的。
        if model:
            self.model = str(model)
        try:
            if history:
                # 简单去重：只保留最近若干条，避免系统提示被冲掉
                for m in history[-30:]:
                    if isinstance(m, dict) and m.get("role") in ("user", "assistant", "tool"):
                        self.messages.append(m)
            self.messages.append({"role": "user", "content": user_text})
            turns = 0
            while turns < MAX_TURNS:
                if self.cancel_event.is_set():
                    self.send({"type": "task_done", "session": self.sid, "text": "", "stopped": "aborted"})
                    return
                turns += 1
                self.send({"type": "status", "session": self.sid, "text": "思考中…", "turn": turns})
                r = self._call_llm_with_fallback()
                if r.get("content"):
                    self.send({"type": "assistant_chunk", "session": self.sid, "text": r["content"]})
                calls = r.get("tool_calls") or []
                if not calls:
                    self.send({"type": "task_done", "session": self.sid, "text": r.get("content", ""), "turns": turns})
                    return
                # 把模型意图作为 assistant 消息记回上下文
                self.messages.append({"role": "assistant", "content": r.get("content", ""),
                                      "tool_calls": [{"id": c["id"], "type": "function",
                                                      "function": {"name": c["name"],
                                                                   "arguments": json.dumps(c["arguments"])}} for c in calls]})
                for c in calls:
                    if self.cancel_event.is_set():
                        break
                    result = self.dispatch_tool(c)
                    if result is None:
                        # 等待超时/取消：用错误占位，让模型换路
                        self.messages.append({"role": "tool", "tool_call_id": c["id"],
                                              "content": "工具执行超时或连接已断开，未能拿到结果。请换一种方式。"})
                        continue
                    self.messages.append({"role": "tool", "tool_call_id": c["id"], "content": result})
            self.send({"type": "task_done", "session": self.sid, "text": "",
                       "turns": turns, "stopped": "max_turns"})
        except UpstreamError as exc:
            sys.stderr.write("[channel] agent error: %s\n" % exc)
            self.send({"type": "error", "code": exc.code, "message": str(exc), "hint": exc.hint})
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write("[channel] agent error: %s\n" % exc)
            self.send({"type": "error", "code": "agent_error", "message": str(exc)})
        finally:
            self.running = False

    def dispatch_tool(self, call):
        """发送 tool_request 并等待结果；返回给模型的 tool content 字符串或 None。"""
        cid = call["id"]
        with self.lock:
            self.pending[cid] = {"event": threading.Event(), "result": None}
            ev = self.pending[cid]["event"]
        self.send({"type": "tool_request", "session": self.sid,
                   "id": cid, "tool": call["name"], "params": call["arguments"]})
        ok = ev.wait(timeout=TOOL_TIMEOUT)
        with self.lock:
            entry = self.pending.pop(cid, None)
        if not ok:
            return None
        res = entry["result"] if entry else None
        if res is None:
            return None
        return res  # 已经是给模型的文本

    def on_tool_result(self, cid, text, blocked):
        with self.lock:
            entry = self.pending.get(cid)
            if entry:
                entry["result"] = ("被安全规则拦截，未执行。请改用其它方式完成任务，或向用户说明无法执行。"
                                    if blocked else text)
                entry["event"].set()

    def on_cancel(self):
        self.cancel_event.set()
        with self.lock:
            for entry in self.pending.values():
                entry["result"] = None
                entry["event"].set()


# ----------------------------------------------------------------- WS 连接处理

class WSConnection:
    def __init__(self, sock, addr):
        self.sock = sock
        self.addr = addr
        self.buf = b""
        self.session = None
        self.closed = False

    def send_raw(self, data):
        if self.closed:
            return
        try:
            self.sock.sendall(encode_frame(0x1, data))
        except Exception:
            self.closed = True

    def send_json(self, obj):
        self.send_raw(json.dumps(obj, ensure_ascii=False))

    def send_ping(self):
        try:
            self.sock.sendall(encode_frame(0x9, b""))
        except Exception:
            self.closed = True

    def close(self):
        try:
            self.sock.sendall(encode_frame(0x8, b""))
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass
        self.closed = True

    def handle(self):
        sid = "sess-%d" % int(time.time() * 1000)
        self.session = Session(self, sid)
        with LOCK:
            SESSIONS[sid] = self.session
        # channel_version 供客户端做能力协商：版本不够时客户端会直接断开并提示重新部署，
        # 而不是带着残缺能力（比如拿不到模型清单）继续跑。
        self.send_json({"type": "welcome", "session": sid,
                        "model": STATE["model"], "server": "hermes-buddy-channel",
                        "version": "1", "channel_version": CHANNEL_VERSION})
        try:
            while not self.closed:
                frame = self.read_frame()
                if frame is None:
                    break
                op = frame["opcode"]
                if op == 0x8:  # close
                    break
                if op == 0x9:  # ping
                    self.send_raw(encode_frame(0xA, frame["payload"]))
                    continue
                if op == 0xA:  # pong
                    continue
                if op == 0x1:  # text
                    self.on_message(frame["payload"].decode("utf-8", "replace"))
        finally:
            if self.session:
                self.session.on_cancel()
            with LOCK:
                SESSIONS.pop(sid, None)
            self.close()

    def read_frame(self):
        # 收集足够数据解析一个帧
        while True:
            frame, self.buf = decode_frame(self.buf)
            if frame is not None:
                return frame
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                # 超时不算断开，继续等下一轮 recv
                continue
            except (OSError, ConnectionError):
                return None
            if not chunk:
                return None
            self.buf += chunk

    def on_message(self, text):
        try:
            msg = json.loads(text)
        except Exception:
            self.send_json({"type": "error", "code": "bad_json", "message": "消息不是合法 JSON"})
            return
        t = msg.get("type")
        s = self.session
        if t == "hello":
            caps = msg.get("capabilities") or []
            sys.stderr.write("[channel] hello caps=%s\n" % caps)
        elif t == "user_message":
            if s and not s.running:
                threading.Thread(target=s.run_task,
                                 args=(msg.get("text", ""), msg.get("history") or []),
                                 kwargs={"model": msg.get("model") or ""},
                                 daemon=True).start()
            elif s and s.running:
                self.send_json({"type": "error", "code": "busy", "message": "上一次任务还在进行"})
        elif t == "list_models":
            # 客户端要模型清单：去上游 /models 拉（失败则用 config.yaml 声明兜底）。
            # 服务端同步拉取即可，列表小、上游一般很快。
            try:
                models = list_upstream_models()
            except Exception as exc:  # noqa: BLE001
                models = [STATE["model"] or "hermes-agent"]
                sys.stderr.write("[channel] list_models error: %s\n" % exc)
            self.send_json({"type": "models", "models": models,
                            "default": STATE["model"] or "",
                            "unsupported": sorted(UNSUPPORTED_MODELS)})
        elif t == "tool_result":
            if s:
                s.on_tool_result(msg.get("id"), msg.get("text", ""), bool(msg.get("blocked")))
        elif t == "tool_rejected":
            if s:
                reason = msg.get("reason", "被安全规则拦截")
                s.on_tool_result(msg.get("id"), "被安全规则拦截，未执行：%s" % reason, True)
        elif t == "cancel":
            if s:
                s.on_cancel()
        elif t == "pong":
            pass
        else:
            self.send_json({"type": "error", "code": "unknown_type", "message": "未知消息类型: %s" % t})


# ----------------------------------------------------------------- HTTP / WS 升级

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "hermes-buddy-channel/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[channel] %s - %s\n" % (self.address_string(), fmt % args))

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
        except Exception:
            pass

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/health", "/healthz", "/"):
            self._send(200, {"ok": True, "service": "hermes-buddy-channel",
                             "version": CHANNEL_VERSION,
                             "upstream_base": STATE["base"], "upstream_model": STATE["model"],
                             "mock": MOCK_LLM, "sessions": len(SESSIONS)})
            return
        if path == "/api/buddy/channel":
            return self.upgrade_ws()
        self._send(404, {"error": {"message": "not found: " + path}})

    def upgrade_ws(self):
        # 鉴权：支持 Authorization: Bearer header 或 ?token= query string
        token = expected_token()
        # 1. 先从 Authorization header 取
        client_token = ""
        auth_header = self.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            client_token = auth_header[7:].strip()
        # 2. 再从 query string 取（header 优先）
        if not client_token and "?" in self.path:
            from urllib.parse import parse_qs
            qs = parse_qs(self.path.split("?", 1)[1])
            client_token = (qs.get("token", [""])[0] or "").strip()
        if token and client_token != token:
            self._send(401, {"error": {"message": "unauthorized: 需要 Hermes 的 API Key（Authorization: Bearer 或 ?token=）"}})
            return
        key = self.headers.get("Sec-WebSocket-Key", "")
        if not key:
            self._send(400, {"error": {"message": "missing Sec-WebSocket-Key"}})
            return
        accept = ws_accept(key)
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        try:
            self.wfile.flush()
        except Exception:
            pass
        # 关键：阻止 BaseHTTPRequestHandler 在 do_GET 返回后继续循环读下一个请求
        self.close_connection = True
        # 把底层 socket 交给 WSConnection（关掉 BufferedWriter 的缓冲）
        raw = self.connection
        try:
            raw.settimeout(5.0)
        except Exception:
            pass
        conn = WSConnection(raw, self.client_address)
        conn.handle()


def main():
    base, key, model, _ = discover_upstream()
    sys.stderr.write("[channel] HERMES_HOME = %s\n" % HERMES_HOME)
    sys.stderr.write("[channel] upstream base  = %s\n" % (base or "(未配置)"))
    sys.stderr.write("[channel] upstream model = %s\n" % model)
    sys.stderr.write("[channel] mock LLM       = %s\n" % MOCK_LLM)
    if not base and not MOCK_LLM:
        sys.stderr.write("[channel] WARN: 上游未配置，通道会启动但无法调用真实模型\n")
    sys.stderr.write("[channel] listening on %s:%d (ws /api/buddy/channel)\n" % (LISTEN_HOST, LISTEN_PORT))
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
