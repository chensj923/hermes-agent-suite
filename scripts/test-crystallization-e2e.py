#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Hermes Buddy 结晶系统（crystallization）端到端验证 —— 服务端半侧。

验证目标（"hermes-buddy 记得住" 的服务端证据）：
  A. 客户端 sync_memory 上传 -> 服务端落盘到 HERMES_HOME/buddy-memory/{GLOBAL,AGENTS,PROJECT}.md
  B. 新 Session 初始化时把结晶记忆注入 system prompt
  C. 会话落盘 -> 断线重连后 load_from_disk 恢复，且结晶记忆仍在
  D. run_task 的 system_extra 每轮刷新，且【保留】服务端结晶记忆（v3.6.8 修复点）

无需网络/端口：直接 import 通道模块，调用真实函数。
"""
import os
import sys
import json
import tempfile

# 必须在 import 前设定 HERMES_HOME，避免污染真实环境
TMP = tempfile.mkdtemp(prefix="hermes_crystal_e2e_")
os.environ["HERMES_HOME"] = TMP
os.environ["BUDDY_CHANNEL_MOCK_LLM"] = "1"

HERE = os.path.dirname(os.path.abspath(__file__))
CHANNEL_PATH = os.path.abspath(os.path.join(HERE, "..", "packages", "hermes-buddy-channel", "buddy-channel.py"))
import importlib.util  # noqa: E402
_spec = importlib.util.spec_from_file_location("buddy_channel", CHANNEL_PATH)
bc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bc)

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (("  -> " + detail) if detail else ""))

MEM_DIR = os.path.join(TMP, "buddy-memory")
SES_DIR = os.path.join(TMP, "buddy-sessions")

# ----------------------------------------------------------------- 假连接（只记录 send_json）
class FakeConn:
    def __init__(self):
        self.sent = []
    def send_json(self, obj):
        self.sent.append(obj)

# ----------------------------------------------------------------- A. 结晶落盘
fc = FakeConn()
bc.WSConnection._handle_sync_memory(fc, {"scope": "project", "content": "用户偏好红色主题"})
proj = os.path.join(MEM_DIR, "PROJECT.md")
check("A1 结晶写 PROJECT.md", os.path.exists(proj))
with open(proj, encoding="utf-8") as f:
    pc = f.read()
check("A2 内容持久化", "用户偏好红色主题" in pc, pc[:60].replace("\n", " "))

fc2 = FakeConn()
bc.WSConnection._handle_sync_memory(fc2, {"scope": "global", "content": "跨项目约定：一律用中文回复"})
glob = os.path.join(MEM_DIR, "GLOBAL.md")
check("A3 global -> GLOBAL.md", os.path.exists(glob))
check("A4 返回 sync_memory_result.ok", any(s.get("type") == "sync_memory_result" and s.get("ok") for s in fc2.sent))

# 追加模式（多次同步是增量贡献，不是覆盖）
bc.WSConnection._handle_sync_memory(FakeConn(), {"scope": "project", "content": "用户是前端开发者"})
with open(proj, encoding="utf-8") as f:
    pc2 = f.read()
check("A5 追加而非覆盖", "用户偏好红色主题" in pc2 and "用户是前端开发者" in pc2)

# ----------------------------------------------------------------- B. system prompt 注入
sp = bc.Session._build_system_prompt()
check("B1 项目结晶注入 prompt", "用户偏好红色主题" in sp)
check("B2 全局结晶注入 prompt", "用中文回复" in sp)

# ----------------------------------------------------------------- C. 会话落盘 + resume 继承
s1 = bc.Session(None, "sess-A")
s1.messages.append({"role": "user", "content": "记住我的名字是张三"})
s1.save_to_disk()
check("C1 会话文件写出", os.path.exists(os.path.join(SES_DIR, "sess-A.json")))

s2 = bc.Session(None, "sess-A")
ok = s2.load_from_disk("sess-A")
check("C2 resume 成功", ok)
check("C3 历史消息恢复", any(m.get("content") == "记住我的名字是张三" for m in s2.messages))
check("C4 resume 后结晶记忆仍在 system prompt",
      "用户偏好红色主题" in s2.messages[0]["content"])

# ----------------------------------------------------------------- D. system_extra 每轮刷新 + 保留结晶（v3.6.8 修复点）
def fake_llm(self):
    return {"content": "ok", "tool_calls": []}
bc.Session._call_llm_with_fallback = fake_llm

s3 = bc.Session(None, "sess-D")
extra = "工作区: C:/proj\n本地记忆: 用户是开发者"
s3.run_task("你好", [], model=None, system_extra=extra)
c0 = s3.messages[0]["content"]
check("D1 system_extra 注入", extra in c0)
check("D2 marker 存在", "【本机上下文 - 由客户端提供】" in c0)
# 关键：结晶记忆必须保留（旧写法 base=SYSTEM_PROMPT 会把它覆盖掉）
check("D3 结晶记忆在 system_extra 注入后仍保留", "用户偏好红色主题" in c0)
# 再跑一轮，验证 marker 不重复累积
s3.run_task("再问一次", [], model=None, system_extra=extra)
check("D4 多轮刷新无重复 marker",
      s3.messages[0]["content"].count("【本机上下文 - 由客户端提供】") == 1)

# 对照：无 system_extra 时，结晶记忆也独立可见（换 Buddy / 清本地记忆场景）
s4 = bc.Session(None, "sess-E")
check("D5 无 system_extra 时结晶仍注入", "用户偏好红色主题" in s4.messages[0]["content"])

# ----------------------------------------------------------------- 汇总
print("\n=== SUMMARY ===")
fails = [r for r in results if not r[1]]
for r in results:
    print(("  [OK]  " if r[1] else "  [XX]  ") + r[0])
print("TOTAL=%d  FAIL=%d" % (len(results), len(fails)))
print("HERMES_HOME(测试隔离目录)=%s" % TMP)
sys.exit(1 if fails else 0)
