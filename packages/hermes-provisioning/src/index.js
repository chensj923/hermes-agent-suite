'use strict';

const { GatewayClient } = require('@hermes/connection');

const PRODUCTS = Object.freeze({
  buddy: { id: 'buddy', profile: 'buddy', capabilities: ['chat', 'desktop-tools'] },
  home: { id: 'home', profile: 'home-manager', capabilities: ['voice', 'vision', 'home-control'] }
});

function buildProvisioningRequest({ product, deployment = 'windows', devices = [] }) {
  const definition = PRODUCTS[product];
  if (!definition) throw new Error(`未知产品: ${product}`);
  if (!['windows', 'server', 'hybrid'].includes(deployment)) throw new Error('未知部署位置');
  return { product: definition.id, profile: definition.profile, deployment, capabilities: definition.capabilities, devices };
}

async function provision({ gateway, product, deployment, devices }) {
  const payload = buildProvisioningRequest({ product, deployment, devices });
  // This endpoint is the stable server-side contract. No key is ever included in this payload.
  const result = await gateway.request('/api/provisioning/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { ...result, request: payload };
}

function deriveManagementUrl(gatewayUrl) {
  const url = new URL(gatewayUrl);
  url.port = '8700';
  url.pathname = '';
  return url.toString().replace(/\/$/, '');
}

function createGateway(connection) { return new GatewayClient(connection); }
module.exports = { PRODUCTS, buildProvisioningRequest, createGateway, deriveManagementUrl, provision };
