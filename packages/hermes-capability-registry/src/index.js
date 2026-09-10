'use strict';

const fs = require('fs');
const path = require('path');

const CAPABILITY_DIR = path.join(__dirname, '..', 'capabilities');
const DEPLOYMENTS = Object.freeze(['windows', 'server', 'hybrid']);
const KNOWN_REQUIREMENTS = Object.freeze(['chat', 'voice', 'vision', 'home-control', 'desktop-tools']);

class CapabilityError extends Error {
  constructor(message) { super(message); this.name = 'CapabilityError'; }
}

function asStringArray(value, field, id) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CapabilityError(`${id}.${field} 必须是数组`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) throw new CapabilityError(`${id}.${field}[${index}] 必须是非空字符串`);
    return item.trim();
  });
}

/** 校验一份能力清单，返回冻结后的规范对象。清单是安装时下发给 Gateway 的依据，宁可早失败。 */
function validateCapability(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new CapabilityError('能力清单必须是对象');
  const id = String(manifest.id || '').trim();
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new CapabilityError(`能力 id 非法: ${manifest.id}`);
  const displayName = String(manifest.displayName || id).trim();
  const requires = asStringArray(manifest.requires, 'requires', id);
  const unknown = requires.filter((item) => !KNOWN_REQUIREMENTS.includes(item));
  if (unknown.length) throw new CapabilityError(`${id}.requires 含未知能力: ${unknown.join(', ')}`);
  const deployment = asStringArray(manifest.deployment, 'deployment', id);
  if (!deployment.length) throw new CapabilityError(`${id}.deployment 不能为空`);
  const badDeployment = deployment.filter((item) => !DEPLOYMENTS.includes(item));
  if (badDeployment.length) throw new CapabilityError(`${id}.deployment 含未知部署位置: ${badDeployment.join(', ')}`);
  return Object.freeze({
    id,
    displayName,
    requires: Object.freeze(requires),
    skills: Object.freeze(asStringArray(manifest.skills, 'skills', id)),
    mcp: Object.freeze(asStringArray(manifest.mcp, 'mcp', id)),
    deployment: Object.freeze(deployment)
  });
}

/** 从目录加载全部 *.json 能力清单，按 id 排序，重复 id 直接报错。 */
function loadCapabilities(dir = CAPABILITY_DIR) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    throw new CapabilityError(`无法读取能力目录 ${dir}: ${error.message}`);
  }
  const byId = new Map();
  for (const name of files) {
    const full = path.join(dir, name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (error) {
      throw new CapabilityError(`${name} 不是合法 JSON: ${error.message}`);
    }
    const capability = validateCapability(parsed);
    if (byId.has(capability.id)) throw new CapabilityError(`能力 id 重复: ${capability.id}`);
    byId.set(capability.id, capability);
  }
  return [...byId.values()];
}

/** 某个部署位置可用的能力清单。 */
function capabilitiesForDeployment(deployment, capabilities = loadCapabilities()) {
  if (!DEPLOYMENTS.includes(deployment)) throw new CapabilityError(`未知部署位置: ${deployment}`);
  return capabilities.filter((capability) => capability.deployment.includes(deployment));
}

/**
 * 给定产品需要的能力（如 ['voice','vision']）与部署位置，算出应安装的 skills / mcp。
 * missing 列出没有任何清单覆盖的能力，安装向导据此提示用户，而不是静默少装。
 */
function resolveRequirements(requires, deployment, capabilities = loadCapabilities()) {
  const wanted = Array.isArray(requires) ? requires : [];
  const available = capabilitiesForDeployment(deployment, capabilities);
  const matched = available.filter((capability) => capability.requires.some((item) => wanted.includes(item)));
  const covered = new Set(matched.flatMap((capability) => capability.requires));
  return {
    deployment,
    capabilities: matched.map((capability) => capability.id),
    skills: [...new Set(matched.flatMap((capability) => capability.skills))],
    mcp: [...new Set(matched.flatMap((capability) => capability.mcp))],
    missing: wanted.filter((item) => !covered.has(item))
  };
}

module.exports = {
  CAPABILITY_DIR,
  DEPLOYMENTS,
  KNOWN_REQUIREMENTS,
  CapabilityError,
  validateCapability,
  loadCapabilities,
  capabilitiesForDeployment,
  resolveRequirements
};
