# Hermes Suite 2.0 architecture

## Product boundary

`apps/` contains independently installable products. `packages/` contains reusable code and deployable capability definitions. The legacy `workbuddy/` service remains supported until its consumers migrate.

```
apps/
  hermes-buddy-desktop/       Windows personal assistant installer
  hermes-home-desktop/        Future home-manager installer
packages/
  hermes-connection/          Authenticated Gateway client and session creation
  hermes-provisioning/        Product pairing/configuration contract
  hermes-device-agent/        Windows device permissions and local media bridge
  hermes-capability-registry/ Skill/MCP capability manifests
```

## Provisioning contract

Every installer validates `GET /api/health`, creates a session through `POST /api/sessions` with `model: hermes-agent`, then sends a credential-free manifest to `POST /api/provisioning/products`. The Gateway owns server-side profile, Skill and MCP installation. API keys are never sent in the manifest or written into a product configuration file.

`Hermes Home` uses one of three explicit deployments: `windows` (media devices connected locally), `server` (devices are reachable by the Hermes host), or `hybrid` (Gateway orchestrates while a Windows Device Agent accesses local media).

## Windows packaging

`npm run build:buddy:win` emits `hermes-suite-windows-x86_64.exe` under `apps/hermes-buddy-desktop/dist/`. `.npmrc` selects npmmirror and its Electron binary mirror for mainland China builds.
