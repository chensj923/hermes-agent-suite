"""校验服务端对上游连接错误的分类（不需要真的起监听端口）。

重点：Connection refused（errno 111）必须被识别成「地址上没服务在听」，
而不是笼统一句「上游不可达」——后者会让用户往附件体积的方向白排查。
"""
import importlib.util
import os
import urllib.error

os.environ["BUDDY_CHANNEL_MOCK_LLM"] = "0"

SRC = r"c:/Users/chens/SynologyDrive/hermes/hermes-agent-suite/packages/hermes-buddy-channel/buddy-channel.py"
spec = importlib.util.spec_from_file_location("buddy_channel", SRC)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

mod.STATE["base"] = "http://127.0.0.1:8080/v1"
mod.STATE["key"] = "sk-test"
mod.STATE["model"] = "test-model"

assert mod._public_upstream() == "http://127.0.0.1:8080/v1", mod._public_upstream()
print("[OK] _public_upstream 返回可展示地址")

# 带查询串时不能把 token 带出去
mod.STATE["base"] = "http://127.0.0.1:8080/v1?key=secret"
assert mod._public_upstream() == "http://127.0.0.1:8080/v1", mod._public_upstream()
print("[OK] 上游地址里的查询串被剥掉（不会泄露 token）")
mod.STATE["base"] = "http://127.0.0.1:8080/v1"


def raise_with(exc):
    def _f(*a, **kw):
        raise exc
    return _f

# 1) Connection refused → upstream_refused，且消息里带上游地址
refused = urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))
mod.urllib.request.urlopen = raise_with(refused)
try:
    mod.call_llm([{"role": "user", "content": "hi"}], [], lambda: False)
    raise AssertionError("应当抛错")
except mod.UpstreamError as exc:
    assert exc.code == "upstream_refused", f"code 应为 upstream_refused，实际 {exc.code}"
    assert "127.0.0.1:8080" in str(exc), f"消息应带上游地址，实际 {exc}"
    assert "没有服务在监听" in exc.hint, exc.hint
    print("[OK] Connection refused → upstream_refused，提示指向地址与监听状态")
except Exception as exc:  # noqa: BLE001
    raise AssertionError(f"应抛 UpstreamError，实际 {type(exc).__name__}: {exc}")

# 2) 超时 → upstream_timeout
mod.urllib.request.urlopen = raise_with(urllib.error.URLError(TimeoutError("timed out")))
try:
    mod.call_llm([{"role": "user", "content": "hi"}], [], lambda: False)
    raise AssertionError("应当抛错")
except mod.UpstreamError as exc:
    assert exc.code == "upstream_timeout", f"code 应为 upstream_timeout，实际 {exc.code}"
    print("[OK] 超时 → upstream_timeout，提示指向模型加载/推理慢")

# 3) 其它 URLError → upstream_unreachable，不能退化成没头没尾的一句话
mod.urllib.request.urlopen = raise_with(urllib.error.URLError(OSError("Name or service not known")))
try:
    mod.call_llm([{"role": "user", "content": "hi"}], [], lambda: False)
    raise AssertionError("应当抛错")
except mod.UpstreamError as exc:
    assert exc.code == "upstream_unreachable", exc.code
    assert "127.0.0.1:8080" in str(exc), str(exc)
    print("[OK] 其它网络错误 → upstream_unreachable，消息仍带上游地址")

# 4) 上游未配置 → 明确报错
mod.STATE["base"] = ""
mod.urllib.request.urlopen = raise_with(urllib.error.URLError(ConnectionRefusedError(111, "x")))
try:
    mod.call_llm([{"role": "user", "content": "hi"}], [], lambda: False)
    raise AssertionError("应当抛错")
except mod.UpstreamError:
    raise AssertionError("未配置上游时应抛 RuntimeError 而非 UpstreamError")
except RuntimeError as exc:
    assert "上游未配置" in str(exc), str(exc)
    print("[OK] 上游未配置 → 明确提示去哪里配")

print("\n全部通过")
