'use strict';

const { GatewayClient } = require('@hermes/connection');
const { normalizeDevices, unknownDeviceTypes, DeviceError, MAX_DEVICES, KNOWN_TYPES } = require('./devices');

const SCHEMA_VERSION = 1;
const DEPLOYMENTS = Object.freeze(['windows', 'server', 'hybrid']);
const DEFAULT_MANAGEMENT_PORT = '8700';
// 任何一个键出现在清单里都说明调用方混淆了"配置"和"凭据"，宁可抛错也不发出去。
const FORBIDDEN_KEYS = Object.freeze(['apikey', 'api_key', 'key', 'token', 'password', 'secret', 'authorization']);

const PRODUCTS = Object.freeze({
  buddy: { id: 'buddy', profile: 'buddy', capabilities: ['chat', 'desktop-tools'], deployments: ['windows', 'hybrid'] },
  home: { id: 'home', profile: 'home-manager', capabilities: ['voice', 'vision', 'home-control'], deployments: ['windows', 'server', 'hybrid'] }
});

class ProvisioningError extends Error {
  constructor(message) { super(message); this.name = 'ProvisioningError'; }
}

/** 递归检查清单里没有凭据字段。清单会落到服务端磁盘，出现密钥就是事故。 */
function assertCredentialFree(value, trail = 'payload') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCredentialFree(item, `${trail}[${index}]`));
    return value;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.includes(key.toLowerCase())) throw new ProvisioningError(`${trail}.${key} 不允许出现在部署清单里`);
      assertCredentialFree(item, `${trail}.${key}`);
    }
  }
  return value;
}

function buildProvisioningRequest({ product, deployment = 'windows', devices = [] }) {
  const definition = PRODUCTS[product];
  if (!definition) throw new ProvisioningError(`未知产品: ${product}`);
  if (!DEPLOYMENTS.includes(deployment)) throw new ProvisioningError('未知部署位置');
  if (!definition.deployments.includes(deployment)) {
    throw new ProvisioningError(`${definition.id} 不支持 ${deployment} 部署（可选: ${definition.deployments.join(' / ')}）`);
  }
  const payload = {
    schema_version: SCHEMA_VERSION,
    product: definition.id,
    profile: definition.profile,
    deployment,
    capabilities: definition.capabilities,
    devices: normalizeDevices(devices)
  };
  return assertCredentialFree(payload);
}

/**
 * 下发产品部署清单。
 * registry 可选（@hermes/capability-registry 的 resolveRequirements），传入时会先在本地
 * 算一遍 skills 缺口，把"服务端装不了什么"提前告诉用户。
 */
async function provision({ gateway, product, deployment, devices, registry }) {
  if (!gateway || typeof gateway.request !== 'function') throw new ProvisioningError('缺少 Gateway 客户端');
  const payload = buildProvisioningRequest({ product, deployment, devices });
  const plan = registry && typeof registry.resolveRequirements === 'function'
    ? registry.resolveRequirements(payload.capabilities, payload.deployment)
    : null;
  if (plan && plan.missing.length) {
    throw new ProvisioningError(`本机能力清单未覆盖: ${plan.missing.join(', ')}，请更新 capability-registry 后重试`);
  }
  // 这个端点是稳定的服务端契约，负载里永远不带 key。
  const result = await gateway.request('/api/provisioning/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return {
    ...(result && typeof result === 'object' ? result : { raw: result }),
    request: payload,
    plan,
    warnings: unknownDeviceTypes(payload.devices).map((type) => `设备类型 ${type} 不在已知列表中，服务端可能没有对应技能`)
  };
}

/** 读取设备/产品的当前配置状态，端点缺失时返回 configured:false 而不是抛错。 */
async function fetchProvisioningStatus(gateway) {
  if (!gateway || typeof gateway.request !== 'function') throw new ProvisioningError('缺少 Gateway 客户端');
  try {
    const data = await gateway.request('/api/provisioning/status');
    return { configured: true, ...(data && typeof data === 'object' ? data : { raw: data }) };
  } catch (error) {
    if (error && (error.code === 'not_found' || error.status === 404)) return { configured: false, reason: '服务端未提供 provisioning 状态端点' };
    throw error;
  }
}

/** 会话网关与部署管理服务不同端口，默认管理端在 8700。 */
function deriveManagementUrl(gatewayUrl, port = DEFAULT_MANAGEMENT_PORT) {
  const url = new URL(gatewayUrl);
  url.port = String(port);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function createGateway(connection) { return new GatewayClient(connection); }

module.exports = {
  SCHEMA_VERSION,
  DEPLOYMENTS,
  DEFAULT_MANAGEMENT_PORT,
  MAX_DEVICES,
  KNOWN_TYPES,
  PRODUCTS,
  ProvisioningError,
  DeviceError,
  normalizeDevices,
  unknownDeviceTypes,
  assertCredentialFree,
  buildProvisioningRequest,
  provision,
  fetchProvisioningStatus,
  createGateway,
  deriveManagementUrl
};
