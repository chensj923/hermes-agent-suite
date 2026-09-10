'use strict';

/**
 * Hermes 服务端可达性诊断。
 *
 * 区别于 hermes-connection 包里的 health() —— 后者只问"通不通"，
 * 这个模块要做的是告诉用户"不通的话具体怎么修"。它会在三种端点上跑：
 *
 *   - llmUrl        推理端点（决策用，OpenAI 兼容）：必须通，缺它 Buddy 啥也干不了
 *   - gatewayBase   Gateway API（会话登记）：可选，不通降级
 *   - managementUrl 部署清单（provisioning）：可选，不通降级
 *
 * 返回的状态码不是 HTTP 状态码本身，而是被归类后的"原因"，便于 UI 渲染对应文案：
 *
 *   ok              200/204，对端存活、鉴权通过
 *   unauthorized    401/403，端口通但 Key 不对
 *   not_found       404，端口通但路由不对（多半不是 Hermes）
 *   refused         TCP refused，端口没起
 *   unreachable     DNS / 网络层失败（IP 错、VLAN 不通、主机宕）
 *   timeout         TCP 通了但没在 timeout 内响应
 *   wrong_protocol  URL 不是 http/https（Hermes 不支持别的）
 *   no_endpoint     该端点未配置（用户留空）
 *
 * 每种状态都带一段 userMessage 给渲染层直接展示。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 5000;
const PROBE_PATH = '/health';

class DiagnosticError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DiagnosticError';
    this.code = code;
  }
}

/** 把形如 "192.168.0.246:22122" / "http://host:8800" 解析成 URL 字符串，失败抛错。 */
function parseEndpoint(value, label) {
  const raw = String(value || '').trim();
  if (!raw) throw new DiagnosticError(`${label} 未填写`, 'no_endpoint');
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch (_) {
    throw new DiagnosticError(`${label} 地址无法解析: ${raw}`, 'wrong_protocol');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new DiagnosticError(`${label} 必须是 HTTP 或 HTTPS 协议`, 'wrong_protocol');
  }
  return url;
}

/**
 * 用底层 net/http 探一次端点。避免拉 fetch polyfill，Electron 自带也兼容。
 * `fetchImpl` 是为了让单测能注入一个伪造实现，避免真去连网。
 */
function probe(rawUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl } = {}) {
  const url = parseEndpoint(rawUrl, '端点');
  const lib = url.protocol === 'https:' ? https : http;

  if (typeof fetchImpl === 'function') {
    return fetchImpl(url.toString());
  }

  return new Promise((resolve) => {
    const req = lib.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: PROBE_PATH,
        timeout: timeoutMs
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode || 0 });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (error) => {
      // ECONNREFUSED：端口没监听；ENOTFOUND：DNS；ETIMEDOUT：路由层超时。
      const code = error && error.code;
      if (code === 'ECONNREFUSED') resolve({ status: 0, reason: 'refused' });
      else if (code === 'ENOTFOUND') resolve({ status: 0, reason: 'unreachable' });
      else if (code === 'ETIMEDOUT' || code === 'EAI_AGAIN') resolve({ status: 0, reason: 'timeout' });
      else if (error && error.message === 'timeout') resolve({ status: 0, reason: 'timeout' });
      else resolve({ status: 0, reason: 'unreachable', detail: error && error.message });
    });
    req.end();
  });
}

/** 把探测结果归类成"原因"。同样的 status=0 也可能是 refused / unreachable / timeout。 */
function classify(status, explicitReason) {
  if (explicitReason) return explicitReason;
  if (status === 200 || status === 204) return 'ok';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 0) return 'unreachable';
  if (status >= 500) return 'unreachable';
  return 'unreachable';
}

/**
 * 给每个 reason 配一段给最终用户看的中文消息 + 修复动作。
 * userMessage 是给用户看的，actionHint 是 UI 上加按钮或链接的目标。
 */
const GUIDANCE = {
  ok: {
    label: '正常',
    userMessage: '端口正常响应，鉴权通过。',
    actionHint: null
  },
  unauthorized: {
    label: '鉴权失败',
    userMessage: '端口通了，但 API Key 不对。回去服务端 `cat /root/.hermes/.api_server_key` 重新拷贝。',
    actionHint: 'verify_key'
  },
  not_found: {
    label: '路径不对',
    userMessage: '端口通了但 `/health` 返回 404，多半这不是 Hermes / 你打错了端口。',
    actionHint: null
  },
  refused: {
    label: '端口未监听',
    userMessage: 'TCP 直接被拒，对应端口根本没起。去服务端确认 Hermes 是否在跑，并检查端口绑定是否对外。',
    actionHint: 'bootstrap_server'
  },
  unreachable: {
    label: '网络层失败',
    userMessage: '连不上 —— DNS 不通、IP 错、或主机宕。检查地址 / 网段 / 防火墙。',
    actionHint: null
  },
  timeout: {
    label: '超时',
    userMessage: 'TCP 通了但没在限定时间内响应。可能是防火墙 DROP、服务端卡死、或中间设备 QoS。',
    actionHint: null
  },
  wrong_protocol: {
    label: '协议错误',
    userMessage: '地址必须是 http:// 或 https://，不能填 file://、ssh:// 之类。',
    actionHint: null
  },
  no_endpoint: {
    label: '未填写',
    userMessage: '这个端点留空了 —— Buddy 不强求它，但填上能解锁会话登记等高级功能。',
    actionHint: null
  }
};

function guidanceFor(reason) {
  return GUIDANCE[reason] || GUIDANCE.unreachable;
}

/**
 * 一次性诊断全部端点。返回的数组顺序固定，便于 UI 一一对应渲染。
 * options.llmUrl / options.gatewayBaseUrl / options.managementUrl 任一可空。
 */
async function diagnose(options = {}) {
  const endpoints = [
    { key: 'llmUrl', label: '推理端点 (LLM)', value: options.llmUrl, critical: true },
    { key: 'gatewayBaseUrl', label: 'Gateway', value: options.gatewayBaseUrl, critical: false },
    { key: 'managementUrl', label: '部署管理', value: options.managementUrl, critical: false }
  ];

  const results = [];
  for (const ep of endpoints) {
    if (!ep.value || !String(ep.value).trim()) {
      const g = guidanceFor('no_endpoint');
      results.push({ key: ep.key, label: ep.label, value: ep.value || '', reason: 'no_endpoint', critical: ep.critical, ...g });
      continue;
    }
    try {
      const { status, reason } = await probe(ep.value, { timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl });
      const finalReason = classify(status, reason);
      const g = guidanceFor(finalReason);
      results.push({ key: ep.key, label: ep.label, value: ep.value, status, reason: finalReason, critical: ep.critical, ...g });
    } catch (error) {
      const reason = error && error.code ? error.code : 'unreachable';
      const g = guidanceFor(reason);
      results.push({ key: ep.key, label: ep.label, value: ep.value, reason, critical: ep.critical, ...g });
    }
  }

  const blocking = results.find((r) => r.critical && r.reason !== 'ok');
  return { ok: !blocking, blocking: blocking || null, results };
}

module.exports = { diagnose, probe, classify, guidanceFor, GUIDANCE, DiagnosticError, DEFAULT_TIMEOUT_MS };