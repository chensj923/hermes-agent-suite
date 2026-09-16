"""校验服务端通道的多模态 user_message 处理（不需要起监听端口）。"""
import importlib.util
import os
import sys

os.environ["BUDDY_CHANNEL_MOCK_LLM"] = "1"

SRC = r"c:/Users/chens/SynologyDrive/hermes/hermes-agent-suite/packages/hermes-buddy-channel/buddy-channel.py"
spec = importlib.util.spec_from_file_location("buddy_channel", SRC)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

assert mod.CHANNEL_VERSION == "1.3", f"版本应为 1.3，实际 {mod.CHANNEL_VERSION}"


class FakeConn:
    def __init__(self):
        self.sent = []

    def send_json(self, obj):
        self.sent.append(obj)


def make_session():
    s = mod.Session(FakeConn(), "sess-test")
    # 让 LLM 一步返回、不带 tool_calls，避免真的跑工具循环
    s._call_llm_with_fallback = lambda: {"content": "done", "tool_calls": []}
    return s


# 1) 多模态 content 数组：应原样作为 user 消息 append
content = [
    {"type": "text", "text": "看看这张图"},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
]
s = make_session()
s.run_task(content, [], model="")
last = s.messages[-1]
assert last["role"] == "user", last
assert last["content"] == content, f"content 应原样保留，实际 {last['content']!r}"
print("[OK] 多模态 content 数组原样进 messages")

# 2) 老客户端只发纯字符串：行为与 v1.2 一致
s2 = make_session()
s2.run_task("纯文本消息", [], model="")
assert s2.messages[-1] == {"role": "user", "content": "纯文本消息"}, s2.messages[-1]
print("[OK] 纯字符串兼容（老客户端）")

# 3) on_message 解析：带 content 时优先 content；只有 text 时兜底
conn = mod.WSConnection.__new__(mod.WSConnection)
conn.closed = False
conn.sock = None
captured = {}


class SpySession:
    def __init__(self):
        self.messages = []
        self.running = False

    def run_task(self, content, history, model=None):
        captured["content"] = content
        captured["model"] = model


class FakeThread:
    """同步执行 target，便于断言 run_task 实际收到了什么。"""

    def __init__(self, target=None, args=(), kwargs=None, daemon=None):
        self.target = target
        self.args = args
        self.kwargs = kwargs or {}

    def start(self):
        self.target(*self.args, **self.kwargs)


mod.threading.Thread = FakeThread
conn.session = SpySession()
conn.send_json = lambda obj: None

# 构造 on_message 的输入（绕过 socket）
import json


def call_on_message(payload):
    # 直接复用 on_message 的分派逻辑：把 payload 灌进去
    conn.session.running = False
    conn._test_payload = json.dumps(payload)
    orig_loads = mod.json.loads
    mod.json.loads = lambda s: payload
    try:
        conn.on_message("ignored")
    finally:
        mod.json.loads = orig_loads


call_on_message({"type": "user_message", "content": content, "text": "看看这张图", "model": "m1"})
assert captured["content"] == content, captured
assert captured["model"] == "m1", captured
print("[OK] on_message 优先取 content，并透传 model")

call_on_message({"type": "user_message", "text": "老客户端"})
assert captured["content"] == "老客户端", captured
print("[OK] on_message 无 content 时兜底用 text")

# 5) 客户端历史只在会话开始时接入一次：否则多模态图片会每轮重复发送一遍
s3 = make_session()
hist = [
    {"role": "user", "content": "上一轮提问"},
    {"role": "assistant", "content": "上一轮回复"},
]
s3.run_task("第一轮", hist)
s3.run_task("第二轮", hist)
roles = [m["role"] for m in s3.messages]
assert roles.count("assistant") == 1, f"历史应只接入一次，assistant 实际 {roles.count('assistant')} 条"
assert s3.messages[-1] == {"role": "user", "content": "第二轮"}, s3.messages[-1]
print("[OK] 客户端历史只接入一次（避免图片每轮重复计费）")

print("\n全部通过：CHANNEL_VERSION =", mod.CHANNEL_VERSION)
