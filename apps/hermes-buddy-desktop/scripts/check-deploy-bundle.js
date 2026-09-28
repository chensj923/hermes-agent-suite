'use strict';

/**
 * 校验「服务端部署压缩包」与仓库事实源是否一致。
 *
 * 背景（v4.11.0 真实事故）：
 *   改了 packages/hermes-buddy-channel/buddy-channel.py（BUILD 15 -> 16）后，
 *   直接调 electron-builder 打包，跳过了 build-server-deploy-bundle.js。
 *   结果安装包内嵌的 server-deploy/*.tar.gz 仍是 build 12 ——
 *   客户端「一键部署」显示成功、服务端版本却永远不变，
 *   用户看到「部署后通道脚本仍过旧（build 12）请手动重跑 deploy.sh」却无从下手。
 *
 * 本脚本在打包后解包产物里的 bundle，逐项比对仓库事实源，任何不一致即非零退出。
 * 建议接在构建之后、stage 之前执行（见 scripts/stage-installer.js）。
 *
 * 用法：
 *   node scripts/check-deploy-bundle.js [bundle 路径] [--resources <win-unpacked/resources>] [--asar <app.asar 路径>]
 * 退出码：0 一致；1 不一致或缺少文件。
 *
 * 说明：客户端 main.js 的 initDeployIfNeeded() 按下列顺序找部署包，
 *   process.resourcesPath/server-deploy/hermes-buddy-server-deploy.tar.gz  （主）
 *   app.getAppPath()/server-deploy/...                                      （asar 内，回退）
 * 因此 resources 目录下那份才是真实交付位置，asar 内的缺失不算问题。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const APP_ROOT = __dirname.replace(/[\\/]scripts$/, '');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');

const DEFAULT_BUNDLE = path.join(APP_ROOT, 'server-deploy', 'hermes-buddy-server-deploy.tar.gz');
const DEFAULT_ASAR = process.env.HERMES_DIST_ASAR || '';

/** 极简 tar 解析：只取普通文件的 {name, content}。 */
function untar(buf) {
  const files = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const hdr = buf.subarray(off, off + 512);
    if (hdr[0] === 0) break; // 结束块
    let name = hdr.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeStr = hdr.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr.replace(/[^0-7]/g, '') || '0', 8);
    const type = hdr[156];
    const pfx = hdr.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    if (pfx) name = pfx + '/' + name;
    off += 512;
    if (type === 0 || type === 0x30 || type === 0x38) {
      files[name.replace(/^\.\//, '')] = buf.subarray(off, off + size);
    }
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

function readGz(p) {
  return untar(zlib.gunzipSync(fs.readFileSync(p)));
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function firstMatch(text, re) {
  const m = text.match(re);
  return m ? m[1] : null;
}

/** 在候选路径里挑第一个存在的文件。 */
function pick(candidates) {
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function main() {
  const args = process.argv.slice(2);
  let bundle = DEFAULT_BUNDLE;
  let asar = DEFAULT_ASAR;
  let resources = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--asar') asar = args[++i];
    else if (args[i] === '--resources') resources = args[++i];
    else if (!args[i].startsWith('--')) bundle = args[i];
  }

  // 真实交付位置优先：resources/server-deploy/*.tar.gz（客户端主查找路径）
  if (!resources && process.env.HERMES_DIST_RESOURCES) resources = process.env.HERMES_DIST_RESOURCES;
  if (resources) {
    const cand = path.join(resources, 'server-deploy', 'hermes-buddy-server-deploy.tar.gz');
    if (fs.existsSync(cand)) bundle = cand;
  }

  const problems = [];
  const notes = [];

  const channelSrc = pick([
    path.join(REPO_ROOT, 'packages/hermes-buddy-channel/buddy-channel.py'),
    path.join(APP_ROOT, 'src/buddy-channel.py'),
  ]);
  const proxySrc = pick([
    path.join(REPO_ROOT, 'packages/hermes-buddy-proxy/buddy-inference-proxy.py'),
    path.join(APP_ROOT, 'src/buddy-inference-proxy.py'),
  ]);
  const deployShSrc = path.join(APP_ROOT, 'deploy', 'deploy.sh');

  if (!fs.existsSync(bundle)) {
    console.error('[check-bundle] 找不到部署压缩包：' + bundle);
    console.error('[check-bundle] 请先执行：node scripts/build-server-deploy-bundle.js');
    process.exit(1);
  }

  const files = readGz(bundle);
  console.log('[check-bundle] 压缩包：' + bundle);
  console.log('[check-bundle] 包内文件：' + Object.keys(files).join(', '));

  // 1) 通道脚本：build / version / 内容哈希必须与事实源一致
  const srcChannel = fs.readFileSync(channelSrc);
  const srcText = srcChannel.toString('utf8');
  const srcBuild = firstMatch(srcText, /CHANNEL_BUILD\s*=\s*"(\d+)"/);
  const srcVersion = firstMatch(srcText, /CHANNEL_VERSION\s*=\s*"([\d.]+)"/);
  const pkgChannel = files['buddy-channel.py'];
  if (!pkgChannel) {
    problems.push('压缩包内缺少 buddy-channel.py');
  } else {
    const pkgText = pkgChannel.toString('utf8');
    const pkgBuild = firstMatch(pkgText, /CHANNEL_BUILD\s*=\s*"(\d+)"/);
    const pkgVersion = firstMatch(pkgText, /CHANNEL_VERSION\s*=\s*"([\d.]+)"/);
    const same = sha256(pkgChannel) === sha256(srcChannel);
    notes.push(
      'buddy-channel.py  仓库 build=' + srcBuild + ' version=' + srcVersion +
      ' | 包内 build=' + pkgBuild + ' version=' + pkgVersion +
      ' | 内容一致=' + (same ? '是' : '否')
    );
    if (pkgBuild !== srcBuild) {
      problems.push(
        '通道脚本 build 不一致：包内 ' + pkgBuild + ' vs 仓库 ' + srcBuild +
        ' —— 说明构建前没有重跑 build-server-deploy-bundle.js，' +
        '客户端一键部署会把旧脚本推上服务器'
      );
    }
    if (!same) problems.push('buddy-channel.py 内容与仓库事实源不一致（哈希不同）');
  }

  // 2) 推理代理脚本
  if (proxySrc && files['buddy-inference-proxy.py']) {
    const a = fs.readFileSync(proxySrc);
    const b = files['buddy-inference-proxy.py'];
    const same = sha256(a) === sha256(b);
    notes.push('buddy-inference-proxy.py 内容一致=' + (same ? '是' : '否'));
    if (!same) problems.push('buddy-inference-proxy.py 与仓库事实源不一致');
  }

  // 3) deploy.sh 里声明的期望 build 必须与脚本真实 build 一致
  const deploySh = files['deploy.sh'] || (fs.existsSync(deployShSrc) ? fs.readFileSync(deployShSrc) : null);
  if (deploySh) {
    const expected = firstMatch(deploySh.toString('utf8'), /CHANNEL_BUILD_EXPECTED\s*=\s*"?(\d+)"?/);
    notes.push('deploy.sh CHANNEL_BUILD_EXPECTED=' + expected);
    if (srcBuild && expected && expected !== srcBuild) {
      problems.push(
        'deploy.sh 期望 build(' + expected + ') 与通道脚本实际 build(' + srcBuild + ') 不一致，' +
        '部署后自检会永远判定「脚本过旧」'
      );
    }
  }

  // 4) 可选：直接校验打好的 app.asar 内嵌的 bundle（最贴近用户拿到的产物）
  if (asar && fs.existsSync(asar)) {
    let asarMod = null;
    try {
      asarMod = require('@electron/asar');
    } catch (_) {
      notes.push('跳过 asar 校验：未找到 @electron/asar');
    }
    if (asarMod) {
      const list = asarMod.listPackage(asar);
      const key = list.find((k) => /server-deploy[/\\]hermes-buddy-server-deploy\.tar\.gz$/.test(k));
      if (!key) {
        // 部署包本来就放在 resources 目录（asar 只是回退路径），缺失不算问题
        notes.push('asar 内无内嵌部署包（正常，实际由 resources/server-deploy 提供）');
      } else {
        const raw = asarMod.extractFile(asar, key.replace(/^\\/, ''));
        const inner = untar(zlib.gunzipSync(raw));
        const innerChannel = inner['buddy-channel.py'];
        if (!innerChannel) {
          problems.push('asar 内压缩包缺少 buddy-channel.py');
        } else {
          const innerBuild = firstMatch(innerChannel.toString('utf8'), /CHANNEL_BUILD\s*=\s*"(\d+)"/);
          notes.push('asar 内嵌 bundle build=' + innerBuild);
          if (srcBuild && innerBuild !== srcBuild) {
            problems.push(
              'asar 内嵌脚本 build(' + innerBuild + ') 与仓库(' + srcBuild + ') 不一致 —— 用户装包后一键部署会推旧脚本'
            );
          }
        }
      }
    }
  }

  notes.forEach((n) => console.log('[check-bundle]   ' + n));

  if (problems.length) {
    console.error('');
    console.error('[check-bundle] FAIL —— 发现 ' + problems.length + ' 个问题：');
    problems.forEach((p, i) => console.error('  ' + (i + 1) + '. ' + p));
    console.error('');
    console.error('[check-bundle] 修复方式：');
    console.error('  cd apps/hermes-buddy-desktop && node scripts/build-server-deploy-bundle.js');
    console.error('  然后重新构建安装包（npm run build:win:local，勿直接调 electron-builder cli）。');
    console.error('  若服务器已装了旧脚本，可自助修复：bash scripts/fix-remote-channel.sh --host <IP>');
    process.exit(1);
  }

  console.log('[check-bundle] PASS —— 部署包与仓库事实源一致（build ' + srcBuild + '）');
}

main();
