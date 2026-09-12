const fs = require('fs');
const path = require('path');
const os = require('os');
const { AgentStore } = require('./apps/hermes-buddy-desktop/src/agent-store.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
const out = [];
{
  const store = new AgentStore({ dir });
  out.push(`default: ${store.list().length} agent(s), active=${store.active().id}, name=${store.active().name}`);
  const a = store.create({ name: '代码助手', workspace: 'D:\\work\\code', model: 'qwen3-235b', permission: 'read-write' });
  out.push(`created: ${a.id} active=${store.activeId}`);
  store.activate('default');
  out.push(`switched back: active=${store.activeId}`);
  store.update(a.id, { name: '代码助手2', permission: 'full' });
  out.push(`updated: ${JSON.stringify(store.find(a.id))}`);
  store.remove(a.id);
  out.push(`removed: agents=${store.list().length}, active=${store.activeId}`);
  // 持久化验证
  const store2 = new AgentStore({ dir });
  out.push(`reload: agents=${store2.list().length}, active=${store2.activeId}`);
  try { store2.remove('default'); } catch (e) { out.push(`remove-last-blocked: ${e.message}`); }
}
fs.rmSync(dir, { recursive: true, force: true });
fs.writeFileSync('agent-test.out.txt', out.join('\n'), 'utf8');
