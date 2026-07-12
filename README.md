# Flash Price

Price services for Flash. This repository contains two Node 20 workspaces:

- `realtime`: serves near real-time BTC price data over gRPC.
- `history`: serves historical BTC price data over gRPC.

## Requirements

- Node.js 20
- Yarn 1.x
- Docker, for container builds

Install dependencies from the repository root:

```bash
yarn install --frozen-lockfile
```

## Common Commands

Run workspace commands through the root scripts:

```bash
yarn realtime build
yarn realtime tsc-check
yarn realtime eslint-check
yarn realtime ci:test:unit

yarn history build
yarn history tsc-check
yarn history eslint-check
yarn history ci:test:unit
```

The Makefile wraps the same checks:

```bash
make realtime-check-code
make realtime-unit-in-ci
make history-check-code
make history-unit-in-ci
```

## Configuration

Each service loads `default.yaml` from its workspace and then merges an optional
custom YAML file.

By default, custom config is read from:

```text
/var/yaml/custom.yaml
```

Override that path with:

```bash
YAML_CONFIG_PATH=/path/to/custom.yaml
```

Realtime Ibex exchange credentials use the current `ibex-client` credential
shape:

```bash
IBEX_CLIENT_ID=...
IBEX_CLIENT_SECRET=...
IBEX_ENVIRONMENT=production # or sandbox
```

For deployment compatibility, the realtime service still falls back to the old
env names when the new ones are not present:

```bash
IBEX_EMAIL=...
IBEX_PASSWORD=...
IBEX_URL=...
```

Use the new names for new deployments.

## Docker

Build images from the repository root:

```bash
docker build -f ./realtime/Dockerfile -t flash-price-realtime .
docker build -f ./history/Dockerfile -t flash-price-history .
```

Docker builds use `yarn install --frozen-lockfile` so dependency changes require
an updated `yarn.lock`.

## CI

GitHub Actions run on pull requests and pushes to `main`:

- TypeScript, ESLint, build, and unit tests for each workspace.
- CodeQL scanning.
- Dependency audit for production dependencies at high severity and above.
- Secret scanning with Gitleaks.
- Build-only Docker checks for both service images.
