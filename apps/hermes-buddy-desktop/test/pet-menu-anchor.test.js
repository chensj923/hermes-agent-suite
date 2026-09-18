'use strict';

/**
 * v4.8.1 回归测试：桌宠菜单弹出锚点。
 * 历史 bug：popup 的 x/y 是【相对窗口】坐标，旧代码错传屏幕绝对坐标，
 * 菜单被弹到与猫无关的位置。这里 mock electron.screen 锁死三种场景。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MOCK = {
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  display: { workArea: null },
};
MOCK.display.workArea = MOCK.workArea;

const mockElectron = {
  screen: {
    getDisplayMatching: () => MOCK.display,
    getPrimaryDisplay: () => MOCK.display,
  },
};

// 在 require desktop-pet 之前劫持 require('electron')（Node 下它会解析到包的路径字符串导出）
const electronId = require.resolve('electron');
require.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: mockElectron };

const { DesktopPet, PET_WIDTH, PET_HEIGHT } = require('../src/predict/desktop-pet');

function makePet() {
  return new DesktopPet({ logger: { info() {}, warn() {}, error() {} } });
}

function boundsOf(x, y) {
  return { getBounds: () => ({ x, y, width: PET_WIDTH, height: PET_HEIGHT }) };
}

test('猫在屏幕中部 → 菜单弹右侧（x = 窗口宽+4，y=12）', () => {
  const pet = makePet();
  pet.win = boundsOf(500, 300);
  const a = pet._menuAnchor();
  assert.strictEqual(a.x, PET_WIDTH + 4);
  assert.strictEqual(a.y, 12);
});

test('猫贴近屏幕右缘 → 翻到左侧（负 x，越过窗口左缘）', () => {
  const pet = makePet();
  pet.win = boundsOf(1900, 300); // 右缘 1900+170=2070 > 1920
  const a = pet._menuAnchor();
  assert.ok(a.x < 0, `x 应为负（${a.x}）`);
  assert.strictEqual(a.y, 12);
});

test('猫贴近屏幕底部 → 向上展开（负 y）', () => {
  const pet = makePet();
  pet.win = boundsOf(500, 1010); // 1010+12 之后剩 58px，不够菜单高
  const a = pet._menuAnchor();
  assert.strictEqual(a.x, PET_WIDTH + 4);
  assert.ok(a.y < 0, `y 应为负（${a.y}）`);
});

test('坐标一定是相对窗口的小数值，绝不能出现屏幕绝对坐标（回归锁）', () => {
  const pet = makePet();
  for (const [x, y] of [[500, 300], [1900, 300], [500, 1010], [100, 900]]) {
    pet.win = boundsOf(x, y);
    const a = pet._menuAnchor();
    assert.ok(Math.abs(a.x) < 500 && Math.abs(a.y) < 500,
      `(${x},${y}) -> (${a.x},${a.y}) 超出相对坐标合理范围`);
  }
});

test('screen 不可用 → 返回安全 fallback 而不抛错', () => {
  const pet = makePet();
  pet.win = boundsOf(500, 300);
  const saved = mockElectron.screen;
  delete mockElectron.screen;
  try {
    const a = pet._menuAnchor();
    assert.strictEqual(a.x, PET_WIDTH + 4);
    assert.strictEqual(a.y, 12);
  } finally {
    mockElectron.screen = saved;
  }
});
