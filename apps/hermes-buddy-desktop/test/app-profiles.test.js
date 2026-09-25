'use strict';

/**
 * v4.11.0 应用画像库回归测试。
 * 锁住：库规模（约 100 种）、每应用 3 个行为、exe 匹配不误判、游戏类行为固定三件套。
 */

const assert = require('assert');
const { test } = require('node:test');
const {
  APP_PROFILES, INTENT_META, CATEGORY_LABEL,
  lookupApp, behaviorsOf, behaviorById, isGame, normalizeExe,
} = require('../src/predict/app-profiles');

test('画像库规模：覆盖 100 种以上常见软件', () => {
  assert.ok(APP_PROFILES.length >= 100, '画像数应 ≥100，实际 ' + APP_PROFILES.length);
});

test('每个画像恰好 3 个常用行为，且行为字段完整', () => {
  for (const p of APP_PROFILES) {
    assert.strictEqual(p.behaviors.length, 3, p.id + ' 应有 3 个行为');
    for (const b of p.behaviors) {
      assert.ok(b.id && b.name, p.id + ' 行为缺 id/name');
      assert.ok(INTENT_META[b.intent], p.id + '/' + b.id + ' 的 intent 未在 INTENT_META 登记：' + b.intent);
      assert.ok(b.suggestion && b.suggestion.length > 0, p.id + '/' + b.id + ' 缺建议话术');
      assert.strictEqual(typeof b.insert, 'boolean');
    }
    assert.ok(CATEGORY_LABEL[p.category], p.id + ' 的类别未登记：' + p.category);
  }
});

test('exe 归一化：去路径、去扩展名、小写', () => {
  assert.strictEqual(normalizeExe('C:\\Program Files\\WPS\\wps.exe'), 'wps');
  assert.strictEqual(normalizeExe('WINWORD.EXE'), 'winword');
  assert.strictEqual(normalizeExe(''), '');
});

test('精确匹配：常见 exe 命中正确画像', () => {
  const cases = [
    ['wps.exe', 'wps'], ['winword.exe', 'word'], ['excel.exe', 'excel'],
    ['chrome.exe', 'chrome'], ['msedge.exe', 'edge'], ['code.exe', 'vscode'],
    ['wechat.exe', 'wechat'], ['qq.exe', 'qq'], ['explorer.exe', 'explorer'],
    ['notepad.exe', 'notepad'], ['devenv.exe', 'visualstudio'], ['photoshop.exe', 'photoshop'],
  ];
  for (const [exe, id] of cases) {
    const r = lookupApp({ exeName: exe });
    assert.ok(r, exe + ' 应命中画像');
    assert.strictEqual(r.profile.id, id, exe + ' 应命中 ' + id + '，实际 ' + r.profile.id);
    assert.strictEqual(r.match, 'exe');
  }
});

test('包含匹配不误判：qqbrowser 不被 qq 吃掉，qq.exe 仍是 QQ', () => {
  const b = lookupApp({ exeName: 'qqbrowser.exe' });
  assert.ok(b, 'qqbrowser 应命中');
  assert.strictEqual(b.profile.id, 'qqbrowser', 'qqbrowser 不能判成 ' + b.profile.id);
  const q = lookupApp({ exeName: 'qq.exe' });
  assert.strictEqual(q.profile.id, 'qq');
});

test('未知 exe：返回 null（交给行为规则/远端兜底）', () => {
  assert.strictEqual(lookupApp({ exeName: 'totally-unknown-app.exe' }), null);
  assert.strictEqual(lookupApp({}), null);
});

test('游戏类：具体游戏 exe 与引擎窗口类都命中游戏三件套', () => {
  const g = lookupApp({ exeName: 'YuanShen.exe' });
  assert.ok(g, '原神应命中');
  assert.strictEqual(g.profile.id, 'genshin');
  assert.ok(isGame(g.profile));
  const names = behaviorsOf(g.profile).map((b) => b.name);
  assert.deepStrictEqual(names, ['攻略推荐', '过程推荐', '任务与养成建议']);
  // 游戏里绝不代写：所有行为的 insert 都必须是 false
  for (const b of behaviorsOf(g.profile)) {
    assert.strictEqual(b.insert, false, '游戏行为不能往窗口里打字节');
  }
  const engine = lookupApp({ windowClass: 'UnityWndClass' });
  assert.ok(engine, 'Unity 窗口类应兜底为游戏');
  assert.strictEqual(engine.profile.id, 'game-generic');
  assert.ok(isGame(engine.profile));
});

test('behaviorsOf / behaviorById 返回副本，调用方改动不污染库', () => {
  const hit = lookupApp({ exeName: 'wps.exe' });
  const list = behaviorsOf(hit.profile);
  list[0].name = '被改坏了';
  assert.notStrictEqual(behaviorsOf(hit.profile)[0].name, '被改坏了');
  const b = behaviorById(hit.profile, 'draft');
  assert.strictEqual(b.intent, 'word_writing');
  assert.strictEqual(behaviorById(hit.profile, 'nonexistent'), null);
});

test('写作类行为可插入文档（insert=true），建议类不可', () => {
  const wps = lookupApp({ exeName: 'wps.exe' }).profile;
  const draft = behaviorById(wps, 'draft');
  assert.strictEqual(draft.insert, true, '起草正文应可插入文档');
  const lol = lookupApp({ exeName: 'LeagueClient.exe' }).profile;
  assert.ok(isGame(lol));
  assert.strictEqual(behaviorById(lol, 'guide').insert, false);
});
