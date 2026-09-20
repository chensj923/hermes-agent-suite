'use strict';

const assert = require('assert');
const { test } = require('node:test');
const { getForegroundWindowInfo, EXE_TO_CLASS, titleToApp } = require('../src/predict/win-info');

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

test('titleToApp：从 "文档名 - WPS 文字" 反推 WPS 写作身份', () => {
  const id = titleToApp('Hermes-buddy4.5使用结论： - WPS 文字');
  assert.ok(id, '应识别 WPS');
  assert.strictEqual(id.app, 'word');
  assert.strictEqual(id.windowClass, 'Wps_Application');
  assert.strictEqual(id.exeName, 'wps');
});

test('titleToApp：文档名含 Hermes 也不会被误判成桌宠', () => {
  // 反例：桌面宠窗口标题是 "Hermes Buddy"，这里文档名含 Hermes 但后缀是 " - WPS 文字"
  const id = titleToApp('Hermes-buddy4.5使用结论： - WPS 文字');
  assert.ok(id, '仍能反推为真实应用，而非因含 Hermes 返回 null');
  assert.strictEqual(id.app, 'word');
});

test('titleToApp：Word / Excel / PPT / VSCode / 浏览器 各自归位', () => {
  assert.strictEqual(titleToApp('季度报告.docx - Word').app, 'word');
  assert.strictEqual(titleToApp('报表.xls - Excel').windowClass, 'XLMainClient');
  assert.strictEqual(titleToApp('演示.pptx - PowerPoint').app, 'ppt');
  assert.strictEqual(titleToApp('main.py - Visual Studio Code').windowClass, 'VSCodeIDE');
  assert.strictEqual(titleToApp('百度一下 - Google Chrome').app, 'browser');
});

test('titleToApp：整屏标记 / 空串返回 null', () => {
  assert.strictEqual(titleToApp('Screen 1'), null);
  assert.strictEqual(titleToApp(''), null);
  assert.strictEqual(titleToApp(null), null);
});
