'use strict';

/**
 * 更新检查。这里刻意不引入 electron-updater：
 *   1. NSIS 静默更新需要代码签名，当前发布流程还没有证书；
 *   2. 中国大陆直连 GitHub 不稳定，需要可切换的镜像。
 * 所以只做"发现新版本 → 给出下载地址"，安装动作交给用户运行新的安装包。
 */

const REPO = 'chensj923/hermes-agent-suite';
const { fetchLenient } = require('./fetch-lenient');
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET_NAME = 'hermes-suite-windows-x86_64.exe';
// 大陆网络下的镜像前缀，与 4.1 网络约束一致。
const MIRROR_PREFIX = 'https://ghfast.top/';

function parseVersion(value) {
  const raw = String(value || '').trim().replace(/^v/i, '');
  const [core, prerelease = ''] = raw.split('-');
  const parts = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return { parts: parts.slice(0, 3), prerelease };
}

/** 语义化比较：2.0.0 > 2.0.0-dev > 1.9.9。返回 -1 / 0 / 1。 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] > right.parts[i] ? 1 : -1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;   // 正式版大于任何预发布
  if (!right.prerelease) return -1;
  return left.prerelease > right.prerelease ? 1 : -1;
}

function pickAsset(release) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const exact = assets.find((asset) => asset && asset.name === ASSET_NAME);
  const fallback = assets.find((asset) => asset && /\.exe$/i.test(String(asset.name || '')));
  return exact || fallback || null;
}

function mirrorUrl(url) {
  return url ? `${MIRROR_PREFIX}${String(url).replace(/^https?:\/\//, '')}` : null;
}

/**
 * 查询最新 release 并与当前版本比较。
 * 网络失败不视为错误状态，返回 { ok: false, reason }，UI 只做提示不打断使用。
 */
async function checkForUpdates({ currentVersion, feedUrl = RELEASES_API, fetchImpl = globalThis.fetch, timeoutMs = 8000, useMirror = false } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no_fetch' };
  const url = useMirror ? mirrorUrl(feedUrl) : feedUrl;
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchLenient(fetchImpl, url, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hermes-buddy-desktop' }
    });
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    const release = await response.json();
    const latest = String(release.tag_name || release.name || '').trim();
    if (!latest) return { ok: false, reason: 'no_tag' };
    const asset = pickAsset(release);
    const downloadUrl = asset ? asset.browser_download_url : (release.html_url || null);
    return {
      ok: true,
      current: String(currentVersion || ''),
      latest,
      updateAvailable: compareVersions(latest, currentVersion) > 0,
      downloadUrl,
      mirrorUrl: mirrorUrl(downloadUrl),
      assetSize: asset ? Number(asset.size) || 0 : 0,
      releasePage: release.html_url || null,
      publishedAt: release.published_at || null,
      notes: String(release.body || '').slice(0, 2000)
    };
  } catch (error) {
    return { ok: false, reason: error && error.name === 'AbortError' ? 'timeout' : 'network', message: error && error.message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { REPO, RELEASES_API, ASSET_NAME, MIRROR_PREFIX, parseVersion, compareVersions, pickAsset, mirrorUrl, checkForUpdates };
