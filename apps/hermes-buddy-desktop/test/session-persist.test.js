'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PY = 'C:\\Users\\chens\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe';
const CHANNEL_PY = path.resolve(__dirname, '..', '..', '..', 'packages', 'hermes-buddy-channel', 'buddy-channel.py').replace(/\\/g, '/');

function runPy(code) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'py-session-'));
  const script = path.join(tmpDir, 'test_session.py');
  const env = { ...process.env, HERMES_HOME: tmpDir, BUDDY_CHANNEL_MOCK_LLM: '1' };
  fs.writeFileSync(script, code);
  try {
    const out = execFileSync(PY, [script], { env, encoding: 'utf8', timeout: 15000 });
    return { out, tmpDir };
  } catch (e) {
    return { out: e.stdout || '', err: e.stderr || '', tmpDir };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

test('Session.save_to_disk 落盘后 load_from_disk 能恢复', () => {
  const result = runPy(`
import sys, os, json
# 直接 exec 源文件，不走 importlib
exec(open(sys.argv[1]).read(), {'__name__': '__test__'})
  ` + '\n' + `
# 上面的 exec 会把 buddy-channel.py 加载进来，但因为它有 main() 调用，
# 需要在 exec 前注入 __name__ 非 __main__ 来跳过 main()
# 实际上 buddy-channel.py 底部应该有 if __name__ == "__main__"
`);
  // 上面的方式太复杂，换一种：直接用 exec + 临时文件
  const code = `
import sys, os, json

# 读取源码并 exec，跳过 main 调用
with open(r"${CHANNEL_PY}", encoding='utf-8') as f:
    source = f.read()
ns = {'__name__': 'buddy_channel', '__file__': r"${CHANNEL_PY}"}
exec(source, ns)

Session = ns['Session']

class FakeConn:
    def send_json(self, obj): pass

s = Session(FakeConn(), "sess-test-001")
s.messages = [
    {"role": "system", "content": "SYSTEM_PROMPT + extra"},
    {"role": "user", "content": "你好"},
    {"role": "assistant", "content": "你好啊"},
    {"role": "user", "content": "记住 imganalyze 在 Temp"},
]
s.model = "test-model"
s.save_to_disk()

f = s._session_file()
assert os.path.exists(f), "session file should exist"

s2 = Session(FakeConn(), "sess-new")
ok = s2.load_from_disk("sess-test-001")
assert ok, "should load successfully"
assert len(s2.messages) == 4, f"expected 4, got {len(s2.messages)}"
assert s2.model == "test-model", "model should be restored"
print(json.dumps({"ok": True, "messages": len(s2.messages), "model": s2.model}))
`;
  const result2 = runPy(code);
  assert.ok(result2.out.includes('"ok": true'), 'Python 应返回成功: ' + result2.out + (result2.err || ''));
  assert.ok(result2.out.includes('"messages": 4'), '应恢复 4 条消息');
});

test('Session.load_from_disk 不存在的 sid 返回 False', () => {
  const code = `
import sys, os, json
with open(r"${CHANNEL_PY}", encoding='utf-8') as f:
    source = f.read()
ns = {'__name__': 'buddy_channel', '__file__': r"${CHANNEL_PY}"}
exec(source, ns)
Session = ns['Session']

class FakeConn:
    def send_json(self, obj): pass

s = Session(FakeConn(), "sess-new")
ok = s.load_from_disk("nonexistent-sid-99999")
print(json.dumps({"ok": ok}))
`;
  const result = runPy(code);
  assert.ok(result.out.includes('"ok": false'), '不存在的 sid 应返回 false: ' + result.out + (result.err || ''));
});

test('客户端 ChannelClient 有 resumeSession 方法', () => {
  const SRC = path.resolve(__dirname, '..', 'src');
  const { ChannelClient } = require(path.join(SRC, 'agent', 'channel'));
  assert.equal(typeof ChannelClient.prototype.resumeSession, 'function',
    'ChannelClient 应有 resumeSession 方法');
  assert.equal(typeof ChannelClient.prototype._sendResume, 'function',
    'ChannelClient 应有 _sendResume 方法');
});

test('客户端 ChannelClient 有 pendingResume 属性', () => {
  const SRC = path.resolve(__dirname, '..', 'src');
  const { ChannelClient } = require(path.join(SRC, 'agent', 'channel'));
  const client = new ChannelClient({
    url: 'ws://127.0.0.1:1',
    token: 't',
    tools: { invoke: async () => ({ ok: true, text: 'ok' }) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  assert.equal(client.pendingResume, null, 'pendingResume 初始应为 null');
  assert.equal(client._supportsResume, false, 'supportsResume 初始应为 false');
});
