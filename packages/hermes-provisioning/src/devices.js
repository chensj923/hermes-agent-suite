'use strict';

const MAX_DEVICES = 32;
// 与 workbuddy/server.js 的 normalizeDeploymentDevices 保持同构：客户端先拦一遍，
// 用户在 UI 上立刻看到原因，而不是提交后拿到一句 400。
const TYPE_PATTERN = /^[a-z0-9_-]{1,32}$/i;
const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\//i;
const CREDENTIAL_PATTERN = /@|[?&](token|key|password|secret)=/i;
const KNOWN_TYPES = Object.freeze(['camera', 'microphone', 'speaker', 'display', 'gpu', 'sensor', 'light', 'switch']);

class DeviceError extends Error {
  constructor(message) { super(message); this.name = 'DeviceError'; }
}

function normalizeDevice(device, index) {
  if (!device || typeof device !== 'object') throw new DeviceError(`devices[${index}] 无效`);
  const type = String(device.type || '').trim();
  const endpoint = String(device.endpoint || '').trim();
  if (!TYPE_PATTERN.test(type)) throw new DeviceError(`devices[${index}].type 无效: ${device.type}`);
  if (endpoint) {
    if (!SCHEME_PATTERN.test(endpoint)) throw new DeviceError(`devices[${index}].endpoint 必须带协议前缀`);
    // 凭据属于服务端密钥库，部署清单里出现即视为配置错误。
    if (CREDENTIAL_PATTERN.test(endpoint)) throw new DeviceError(`devices[${index}].endpoint 不能包含凭据`);
  }
  // 类型统一小写后再派生 id，保证同一台设备在客户端与服务端清单里是同一个 id。
  const normalizedType = type.toLowerCase();
  const id = String(device.id || `${normalizedType}-${index + 1}`).replace(/[^a-z0-9_-]/ig, '').slice(0, 64);
  if (!id) throw new DeviceError(`devices[${index}].id 无效`);
  return { id, type: normalizedType, endpoint };
}

/** 规范化设备数组，重复 id 直接报错，避免服务端后写覆盖前写。 */
function normalizeDevices(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new DeviceError('devices 必须是数组');
  if (value.length > MAX_DEVICES) throw new DeviceError(`devices 最多 ${MAX_DEVICES} 项`);
  const seen = new Set();
  return value.map((device, index) => {
    const normalized = normalizeDevice(device, index);
    if (seen.has(normalized.id)) throw new DeviceError(`devices 中存在重复 id: ${normalized.id}`);
    seen.add(normalized.id);
    return normalized;
  });
}

/** 未在白名单里的类型不阻断安装，只回报提示，方便先接入再补清单。 */
function unknownDeviceTypes(devices) {
  return [...new Set(devices.map((device) => device.type).filter((type) => !KNOWN_TYPES.includes(type)))];
}

module.exports = { MAX_DEVICES, KNOWN_TYPES, DeviceError, normalizeDevice, normalizeDevices, unknownDeviceTypes };
