[![GitHub Last Commit](https://img.shields.io/github/last-commit/ruaan-deysel/community.unraid.api)](https://github.com/ruaan-deysel/community.unraid.api/commits/main)
[![License](https://img.shields.io/github/license/ruaan-deysel/community.unraid.api)](./LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ruaan-deysel/community.unraid.api)

# Unraid API Homey App

Monitor and control your Unraid server from Homey. The app polls Unraid's GraphQL API without waking disks from standby and provides tiles, flows, and alerts for system, storage, UPS, containers, and VMs.

## Features
- Array status, parity state, and total/free/used storage
- Per-disk usage tiles (up to 30) with dynamic capability management so only present disks appear
- Cache and flash (boot USB) usage tiles
- Disk health/temp warnings and high-usage triggers
- Container and VM counts and start/stop flows
- UPS status, battery, load, runtime
- Flow triggers/conditions for array, disks, containers, VMs, UPS

## Project Layout
- App entry: [app.ts](app.ts)
- Driver: [drivers/unraid-server/driver.ts](drivers/unraid-server/driver.ts)
- Device implementation & polling: [drivers/unraid-server/device.ts](drivers/unraid-server/device.ts)
- GraphQL client & queries: [lib/api](lib/api)
- Schemas: [lib/schemas](lib/schemas)
- Utilities (poll manager, naming, formatting): [lib/utils](lib/utils)
- Capabilities: [.homeycompose/capabilities](.homeycompose/capabilities)
- Homey driver composition: [.homeycompose/drivers/unraid-server/driver.compose.json](.homeycompose/drivers/unraid-server/driver.compose.json)

## Development
> Use the Dev Container. Tooling is preconfigured for Node.js and Homey CLI.

### Prerequisites
- Node.js 18+
- Homey CLI (`npm i -g homey`), though the dev container has it installed

### Install
```sh
npm ci
```

### Lint
```sh
npm run lint -- --ignore-pattern vitest.config.ts
```
(ESLint must pass with zero warnings before committing.)

### Build
```sh
npm run build
```

### Test
```sh
npm test
```

### Run in debug against a Self-Hosted Homey
```sh
npx homey app run
```

## GitHub Actions
- Validate: [.github/workflows/homey-app-validate.yml](.github/workflows/homey-app-validate.yml) (runs `homey-app-validate` after installing dependencies)
- Version bump: [.github/workflows/homey-app-version.yml](.github/workflows/homey-app-version.yml)
- Publish (manual): [.github/workflows/homey-app-publish.yml](.github/workflows/homey-app-publish.yml) — requires `HOMEY_PAT`

## Key Implementation Notes
- Disk standby safety: polling uses `array.disks` (cached) and never the root `disks` SMART query, so disks can spin down normally.
- Dynamic capabilities: disk tiles are added/removed based on detected disks; cache/flash tiles are added only when present.
- Logging: use `this.log()` within the app/driver for consistency.

## Releasing
1. Ensure lint/tests pass.
2. Update changelog/version via the version workflow (or manually bump `app.json` if needed).
3. Run the Publish workflow with `HOMEY_PAT` configured.

## Support / Contributions
- Issues and PRs are welcome. Follow linting/test requirements and keep Homey SDK best practices.

---
Note: README.txt is kept for Homey App Store publishing; this README.md is for developers.

---
## Trademark Notice

Unraid® is a registered trademark of Lime Technology, Inc. This application is not affiliated with, endorsed, or sponsored by Lime Technology, Inc.
