'use strict';

/**
 * Hermes Buddy · WS 工具通道（外挂组件）的源码模板。
 *
 * 与推理直通代理（inference-proxy-template.js）同构：返回 Python 源码字符串，
 * 由服务端准备脚本以 heredoc 方式写到 Hermes 主机并启动。
 *
 * 真正可运行的源码在 packages/hermes-buddy-channel/buddy-channel.py（单一事实来源）；
 * 这里优先读 src/buddy-channel.py（随 Buddy 安装包打进 asar，安装包用），
 * 找不到时回退到仓库里的 packages 路径（开发期用）。
 */

const fs = require('fs');
const path = require('path');

function channelSource() {
  const candidates = [
    path.join(__dirname, 'buddy-channel.py'),
    path.resolve(__dirname, '..', '..', 'packages', 'hermes-buddy-channel', 'buddy-channel.py'),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, 'utf8'); } catch (_) { /* 下一个 */ }
  }
  throw new Error('找不到 buddy-channel.py（请确认已随安装包打包到 src/）');
}

module.exports = { channelSource };
