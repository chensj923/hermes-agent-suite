'use strict';

const assert = require('assert');
const { test } = require('node:test');
const { getForegroundWindowInfo, EXE_TO_CLASS } = require('../src/predict/win-info');

test('解析 "类名|标题|exe" 并剥离长度', () => {
  const info = getForegroundWindowInfo({
    execFileSync: () => 'OpusApp|季度报告.docx - Word|WINWORD\n',
  });
  assert.strictEqual(info.windowClass, 'OpusApp');
  assert.strictEqual(info.title, '季度报告.docx - Word');
  assert.strictEqual(info.exeName, 'WINWORD');
});

test('VSCode(exe=code) 合成 VSCodeIDE 类，避免与 Chrome 同窗类碰撞', () => {
  const info = getForegroundWindowInfo({
    execFileSync: () => 'Chrome_WidgetWin_1|main.py - Visual Studio Code|code\n',
  });
  assert.strictEqual(info.windowClass, 'VSCodeIDE', 'code.exe 应映射成 VSCodeIDE 合成类');
  assert.strictEqual(info.exeName, 'code');
});

test('无类名但有 exe 时回退用 exe 名', () => {
  const info = getForegroundWindowInfo({
    execFileSync: () => '|无标题|notepad\n',
  });
  assert.strictEqual(info.windowClass, 'notepad');
});

test('exec 抛错返回 null', () => {
  const info = getForegroundWindowInfo({ execFileSync: () => { throw new Error('boom'); } });
  assert.strictEqual(info, null);
});

test('EXE_TO_CLASS 含 code→VSCodeIDE', () => {
  assert.strictEqual(EXE_TO_CLASS.code, 'VSCodeIDE');
});
