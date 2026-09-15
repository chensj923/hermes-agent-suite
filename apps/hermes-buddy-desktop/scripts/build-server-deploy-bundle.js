'use strict';

/**
 * 构建「Hermes 服务端部署压缩包」。
 *
 * 把两个外挂组件的真实 .py 文件 + 执行脚本（deploy.sh / deploy.ps1）+ README
 * 打进 server-deploy/hermes-buddy-server-deploy.tar.gz，随 Buddy 安装包一起发出。
 *
 * 这样 Buddy 安装包内就自带一份可独立交付的压缩包：用户/运维把它拷到 Hermes、
 * 解开跑 deploy.sh（或 Windows 侧用 deploy.ps1 一键推送）即可完成服务端部署与调整，
 * 无需再从 Buddy 运行时动态生成 bash 脚本。
 *
 * 用法：
 *   node scripts/build-server-deploy-bundle.js
 * 输出：
 *   server-deploy/hermes-buddy-server-deploy.tar.gz
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_ROOT = __dirname.replace(/[\\/]scripts$/, '');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');

// 切到应用根目录，后续全部用相对路径，避开 Windows tar.exe 把 `C:` 当成远程主机的问题。
process.chdir(APP_ROOT);

const OUT_DIR = 'server-deploy';
const OUT_FILE = 'server-deploy/hermes-buddy-server-deploy.tar.gz';
const STAGE = 'server-deploy/.stage';

/** 在候选路径里挑第一个存在的文件，都不在就报错。 */
function pick(candidates) {
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  console.error('缺少源文件（已尝试）：\n  ' + candidates.join('\n  '));
  process.exit(1);
}

// 压缩包内相对路径 → 真实源文件（仓库根 packages 为单一事实来源，src/ 为安装包副本回退）
const ENTRIES = [
  [pick([
    path.join(REPO_ROOT, 'packages/hermes-buddy-proxy/buddy-inference-proxy.py'),
    path.join(APP_ROOT, 'src/buddy-inference-proxy.py'),
  ]), 'buddy-inference-proxy.py'],
  [pick([
    path.join(REPO_ROOT, 'packages/hermes-buddy-channel/buddy-channel.py'),
    path.join(APP_ROOT, 'src/buddy-channel.py'),
  ]), 'buddy-channel.py'],
  [path.join(APP_ROOT, 'deploy/deploy.sh'), 'deploy.sh'],
  [path.join(APP_ROOT, 'deploy/deploy.ps1'), 'deploy.ps1'],
  [path.join(APP_ROOT, 'deploy/start-channel.sh'), 'start-channel.sh'],
  [path.join(APP_ROOT, 'deploy/README.md'), 'README.md'],
];

function main() {
  const stage = STAGE;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  try {
    const posix = (p) => p.replace(/\\/g, '/');
    for (const [from, dest] of ENTRIES) {
      const to = posix(path.join(stage, dest));
      fs.copyFileSync(from, to);
      fs.chmodSync(to, 0o755);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    // 系统 tar；Windows 10+ 自带 tar.exe 也支持 -czf。全部用相对路径，避开盘符冒号。
    try {
      execFileSync('tar', ['--version'], { stdio: 'ignore' });
    } catch (_) {
      console.error('未找到 tar 命令，无法打包。请安装 Git for Windows 或确保 tar 在 PATH。');
      process.exit(1);
    }
    execFileSync('tar', ['-czf', posix(OUT_FILE), '-C', posix(stage), '.'], { stdio: 'inherit' });

    const size = fs.statSync(OUT_FILE).size;
    console.log('已生成部署压缩包：' + path.resolve(OUT_FILE) + ' （' + (size / 1024).toFixed(1) + ' KB）');
    console.log('包含：' + ENTRIES.map((e) => e[1]).join('  '));
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

main();
