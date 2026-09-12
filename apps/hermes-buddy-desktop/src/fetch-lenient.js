'use strict';

/**
 * 网络请求的"证书宽容"包装。
 *
 * 背景：国内用户常挂系统代理（SakuraCat / Clash 等），HTTPS 会被 MITM，
 * Node 的 undici fetch 不读 Windows 证书库，遇到代理证书直接抛
 * SELF_SIGNED_CERT_IN_CHAIN / UNABLE_TO_VERIFY_LEAF_SIGNATURE 等错误，
 * 导致"检查更新"失败。
 *
 * 策略：先按严格模式请求；只有当失败原因是证书/TLS 类时，
 * 临时关闭 NODE_TLS_REJECT_UNAUTHORIZED 重试一次，用完立即还原，
 * 不影响进程内其它请求的默认安全策略。
 */

const CERT_ERROR_RE = /cert|ssl|tls|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|CERT_HAS_EXPIRED|DEPTH_ZERO/i;

async function fetchLenient(fetchImpl, url, opts = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch 不可用');
  try {
    return await fetchImpl(url, opts);
  } catch (error) {
    const message = String((error && error.message) || (error && error.cause && error.cause.message) || '');
    if (!CERT_ERROR_RE.test(message)) throw error;
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      return await fetchImpl(url, opts);
    } finally {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  }
}

module.exports = { fetchLenient, CERT_ERROR_RE };
