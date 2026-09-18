'use strict';

/**
 * 安装向导辅助器（Electron 主进程专用，但纯逻辑可在 node 下测试）。
 *
 * 职责：
 *   1. 读取 NSIS 安装向导写的 install-auth.json（用户在安装时是否勾选了授权）
 *   2. 把授权状态合并到 PredictConfig
 *   3. 提供 firstRunNeeded() 判断是否需要弹出首次运行引导
 *
 * NSIS 向导在安装时写：
 *   %APPDATA%\@hermes\buddy-desktop\predict\install-auth.json
 *   内容: {"authorized":true/false,"defenderExcluded":true/false}
 *
 * 应用启动时调用 mergeInstallAuth(appDir) 读取该文件并合并到 config。
 * 合并后删除该文件（只读一次），避免重复覆盖用户后续手动修改的设置。
 */

const fs = require('fs');
const path = require('path');

const INSTALL_AUTH_FILE = 'install-auth.json';

/**
 * 读取安装向导写的授权文件。
 * @param {string} appDir  userData 目录
 * @returns {{authorized:boolean,defenderExcluded:boolean}|null}
 */
function readInstallAuth(appDir) {
  if (!appDir) return null;
  const file = path.join(appDir, 'predict', INSTALL_AUTH_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (_) {
    return null;
  }
  try {
    const obj = JSON.parse(raw);
    return {
      authorized: Boolean(obj.authorized),
      defenderExcluded: Boolean(obj.defenderExcluded),
    };
  } catch (_) {
    return null;
  }
}

/**
 * 删除安装向导写的授权文件（合并后调用，避免重复覆盖）。
 * @param {string} appDir  userData 目录
 */
function deleteInstallAuth(appDir) {
  if (!appDir) return;
  const file = path.join(appDir, 'predict', INSTALL_AUTH_FILE);
  try { fs.unlinkSync(file); } catch (_) { /* 不存在就算了 */ }
}

/**
 * 把安装向导写的授权状态合并到 PredictConfig。
 * 只在文件存在且 authorized=true 时才写 config.authorized=true。
 * 不写 false（避免覆盖用户可能已经在设置里手动授权为 true 的情况）。
 *
 * @param {string} appDir  userData 目录
 * @param {object} config  PredictConfig 实例
 * @param {object} [logger]
 * @returns {{authorized:boolean,defenderExcluded:boolean}|null} 合并结果（null 表示无安装向导文件）
 */
function mergeInstallAuth(appDir, config, logger) {
  const log = logger || { info() {}, warn() {}, error() {}, debug() {} };
  const auth = readInstallAuth(appDir);
  if (!auth) return null;

  if (auth.authorized && config && typeof config.set === 'function') {
    config.set({ authorized: true });
    log.info('install-auth-merged', { authorized: true, defenderExcluded: auth.defenderExcluded });
  }

  // 合并后删除文件，避免下次启动重复覆盖
  deleteInstallAuth(appDir);

  return auth;
}

/**
 * 判断是否需要首次运行引导（config 中 authorized=false 且 install-auth.json 不存在或 authorized=false）。
 * 用于决定是否在 renderer 中弹出引导提示。
 *
 * @param {string} appDir  userData 目录
 * @param {object} config  PredictConfig 实例
 * @returns {boolean}
 */
function firstRunNeeded(appDir, config) {
  // 已经授权了就不需要引导
  if (config && config.get && config.get('authorized')) return false;
  // 安装向导文件还在（还没合并），先不弹引导（等合并完再决定）
  const auth = readInstallAuth(appDir);
  if (auth && auth.authorized) return false;
  // 没授权 + 没安装向导授权 = 需要首次引导
  return true;
}

module.exports = {
  readInstallAuth,
  deleteInstallAuth,
  mergeInstallAuth,
  firstRunNeeded,
  INSTALL_AUTH_FILE,
};
