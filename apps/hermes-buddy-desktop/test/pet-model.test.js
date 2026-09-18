'use strict';

/** 桌宠自定义模型（v4.6）回归测试：入口发现 + 存取 + 回退。纯 Node，不依赖 Electron。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DesktopPet, findModelEntry } = require('../src/predict/desktop-pet');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pet-model-'));
}

function noopLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function makePet(dataDir) {
  return new DesktopPet({ logger: noopLogger(), dataDir });
}

test('findModelEntry：根目录直接命中 model3.json', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'Foo.model3.json'), '{}');
  fs.writeFileSync(path.join(dir, 'Foo.moc3'), 'x');
  assert.strictEqual(findModelEntry(dir), 'Foo.model3.json');
});

test('findModelEntry：子目录（1~2 级内）也能找到，返回相对路径', () => {
  const dir = tmpDir();
  const sub = path.join(dir, 'hiyori', 'sub');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'deep.model3.json'), '{}');
  assert.strictEqual(findModelEntry(dir), 'hiyori/sub/deep.model3.json');
});

test('findModelEntry：超过 2 级深或没有 model3.json → null', () => {
  const dir = tmpDir();
  const deep = path.join(dir, 'a', 'b', 'c');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'x.model3.json'), '{}');
  assert.strictEqual(findModelEntry(dir), null, '3 级深不扫描');

  const empty = tmpDir();
  fs.writeFileSync(path.join(empty, 'x.model.json'), '{}');  // Cubism2 旧格式不支持
  assert.strictEqual(findModelEntry(empty), null, 'Cubism2 .model.json 不算命中');
});

test('findModelEntry：大小写不敏感，3 级深以上的入口不算', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'UPPER.MODEL3.JSON'), '{}');
  assert.strictEqual(findModelEntry(dir), 'UPPER.MODEL3.JSON');
});

test('setModel：有效目录落盘并返回入口；getModel 读回', () => {
  const dataDir = tmpDir();
  const modelDir = tmpDir();
  fs.writeFileSync(path.join(modelDir, 'Foo.model3.json'), '{}');
  const pet = makePet(dataDir);
  const r = pet.setModel(modelDir);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.file, 'Foo.model3.json');
  const m = pet.getModel();
  assert.strictEqual(m.dir, modelDir);
  assert.strictEqual(m.file, 'Foo.model3.json');
  // 新实例（模拟重启）读同一份
  assert.deepStrictEqual(makePet(dataDir).getModel(), m);
});

test('setModel：目录里没有 model3.json → 报错且不落盘', () => {
  const dataDir = tmpDir();
  const modelDir = tmpDir();  // 空目录
  const pet = makePet(dataDir);
  assert.throws(() => pet.setModel(modelDir), /没有 Live2D 模型文件/);
  assert.strictEqual(pet.getModel(), null);
  fs.writeFileSync(path.join(modelDir, 'only-textures.png'), 'x');
  assert.throws(() => pet.setModel(modelDir), /没有 Live2D 模型文件/);
  assert.strictEqual(pet.getModel(), null);
});

test('clearModel：删除落盘记录，回到 null（内置）', () => {
  const dataDir = tmpDir();
  const modelDir = tmpDir();
  fs.writeFileSync(path.join(modelDir, 'Foo.model3.json'), '{}');
  const pet = makePet(dataDir);
  pet.setModel(modelDir);
  assert.ok(pet.getModel());
  pet.clearModel();
  assert.strictEqual(pet.getModel(), null);
});

test('getModel：落盘记录损坏或目录被删 → null（回落内置，不抛异常）', () => {
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, 'pet-model.json'), '{broken');
  assert.strictEqual(makePet(dataDir).getModel(), null);

  const dataDir2 = tmpDir();
  fs.writeFileSync(path.join(dataDir2, 'pet-model.json'), JSON.stringify({ dir: path.join(os.tmpdir(), 'definitely-gone-9x8y7z'), file: 'a.model3.json' }));
  assert.strictEqual(makePet(dataDir2).getModel(), null);
});

test('点击穿透开关：默认关，开启后落盘并在新实例读回', () => {
  const dataDir = tmpDir();
  const pet = makePet(dataDir);
  assert.strictEqual(pet._clickThrough, false, '默认不穿透（否则菜单点不出来）');
  pet._setClickThrough(true);
  assert.strictEqual(pet._clickThrough, true);
  assert.strictEqual(makePet(dataDir)._loadClickThrough(), true);
  pet._setClickThrough(false);
  assert.strictEqual(makePet(dataDir)._loadClickThrough(), false);
});

test('本地 GGUF 覆盖：getStatus 优先返回用户指定的模型/mmproj 路径', () => {
  const llama = require('../src/predict/llama-engine');
  const appDir = tmpDir();
  const myModel = path.join(appDir, 'my-Qwen.gguf');
  const myMmproj = path.join(appDir, 'mmproj-mine.gguf');
  fs.writeFileSync(myModel, 'x');
  fs.writeFileSync(myMmproj, 'x');
  const st = llama.getStatus(appDir, 'qwen2.5-vl-3b', { modelPath: myModel, mmprojPath: myMmproj });
  assert.strictEqual(st.model.path, myModel);
  assert.strictEqual(st.model.custom, true);
  assert.strictEqual(st.mmproj.path, myMmproj);
  // 路径失效（文件被删）→ 自动回落到 vlm 目录查找，不报错
  fs.unlinkSync(myModel);
  const st2 = llama.getStatus(appDir, 'qwen2.5-vl-3b', { modelPath: myModel, mmprojPath: myMmproj });
  assert.notStrictEqual(st2.model.path, myModel);
});

test('_modelUrl：无自定义时返回内置 Hiyori；有自定义时经 pet://model/ 且路径正确编码', () => {
  const dataDir = tmpDir();
  const modelDir = tmpDir();
  const sub = path.join(modelDir, 'My Model');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'my model.model3.json'), '{}');
  const pet = makePet(dataDir);
  assert.strictEqual(pet._modelUrl(), 'pet://assets/live2d/hiyori/Hiyori.model3.json');
  pet.setModel(modelDir);
  const url = pet._modelUrl();
  assert.ok(url.startsWith('pet://model/'), url);
  assert.ok(url.includes('My%20Model'), '空格需编码: ' + url);
});
