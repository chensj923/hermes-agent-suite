'use strict';

/** 桌宠文案存取回归测试（纯 Node，不依赖 Electron）。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DesktopPet } = require('../src/predict/desktop-pet');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pet-lines-'));
}

function noopLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function makePet(dataDir) {
  return new DesktopPet({ logger: noopLogger(), dataDir });
}

test('默认文案：未配置时返回内置默认且非空', () => {
  const pet = makePet(tmpDir());
  const lines = pet.getLines();
  assert.ok(Array.isArray(lines) && lines.length >= 3, '默认文案至少 3 句');
  lines.forEach((l) => assert.strictEqual(typeof l, 'string'));
});

test('saveLines：按行拆分、去空行、落盘，重启后可读回', () => {
  const dir = tmpDir();
  const pet = makePet(dir);
  const saved = pet.saveLines('  喵～ 你好  \n\n  喵呜～ 测试  \n');
  assert.deepStrictEqual(saved, ['喵～ 你好', '喵呜～ 测试']);
  // 模拟重启：新实例读同一目录
  const pet2 = makePet(dir);
  assert.deepStrictEqual(pet2.getLines(), ['喵～ 你好', '喵呜～ 测试']);
});

test('saveLines：全部清空时回落默认文案（不落空数组）', () => {
  const dir = tmpDir();
  const pet = makePet(dir);
  const saved = pet.saveLines('   \n\n  ');
  assert.ok(saved.length >= 3, '清空输入应回落默认文案');
  assert.deepStrictEqual(pet.getLines(), saved);
});

test('saveLines：损坏的落盘文件回落默认（不抛异常）', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'pet-lines.json'), '{broken json', 'utf-8');
  const pet = makePet(dir);
  const lines = pet.getLines();
  assert.ok(lines.length >= 3);
});

test('randomLine：返回 getLines 里的一句', () => {
  const dir = tmpDir();
  const pet = makePet(dir);
  pet.saveLines('只有这一句喵');
  assert.strictEqual(pet.randomLine(), '只有这一句喵');
});
