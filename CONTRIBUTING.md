# Contributing

Thanks for taking a look. Small, focused changes are easiest to review.

## Setup

Requires Node 20 or newer (see `.nvmrc`).

```sh
npm ci
npm test
npm run typecheck
npm run build
```

Tests use the MCP SDK's in-memory transports with fake capability servers.
No sibling repos or child processes are required.

## Pull requests

- Keep the diff scoped to one concern.
- Add or update tests with behavior changes.
- Run `npm test` and `npm run typecheck` before opening a PR.
- Do not commit `gateway.config.json`, `.env`, credentials, or vault data.
  Use `gateway.config.example.json` as the template.

## Security

Report vulnerabilities privately via the
[GitHub security advisory form](https://github.com/toothbrush-inc/toy-box-gateway/security/advisories/new).
See [SECURITY.md](SECURITY.md) for the trust boundary.

## Release notes for maintainers

Publishing runs `prepublishOnly` (typecheck, test, build). The package must
not use the `@local/` scope. Prefer a tagged GitHub release that matches the
npm version.
