const fs = require('fs');
const path = require('path');
const { generateBootstrapScript } = require('../apps/hermes-buddy-desktop/src/server-bootstrap');

const out = generateBootstrapScript({
  host: '192.168.0.231',
  llmPort: 8645,
  gatewayPort: 22122,
  managementPort: 0
});

const target = path.join(__dirname, 'hermes-recon-192.168.0.231.sh');
fs.writeFileSync(target, out, { encoding: 'utf8' });
console.log('written:', target);
console.log('lines:', out.split('\n').length);
