'use strict';

class GatewayError extends Error {
  constructor(message, status) { super(message); this.name = 'GatewayError'; this.status = status; }
}

function normalizeGatewayUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new GatewayError('Hermes 地址不能为空');
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new GatewayError('Hermes 地址必须是 HTTP 或 HTTPS');
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

class GatewayClient {
  constructor({ baseUrl, apiKey, fetchImpl = globalThis.fetch }) {
    this.baseUrl = normalizeGatewayUrl(baseUrl);
    this.apiKey = String(apiKey || '').trim();
    this.fetch = fetchImpl;
    if (!this.apiKey) throw new GatewayError('API Key 不能为空');
    if (typeof this.fetch !== 'function') throw new GatewayError('当前运行时不支持网络请求');
  }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json', ...(options.headers || {}) }
    });
    const body = await response.text();
    let data = body;
    try { data = body ? JSON.parse(body) : {}; } catch (_) {}
    if (!response.ok) throw new GatewayError(data?.detail || data?.error || `Gateway 请求失败 (${response.status})`, response.status);
    return data;
  }

  // Hermes api_server exposes its unauthenticated liveness endpoint at /health.
  health() { return this.request('/health'); }
  createSession(profile) {
    return this.request('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'hermes-agent', ...(profile ? { profile } : {}) }) });
  }
}

module.exports = { GatewayClient, GatewayError, normalizeGatewayUrl };
