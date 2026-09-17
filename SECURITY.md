# Security

Report suspected vulnerabilities privately through this repository's
[GitHub security advisory form](https://github.com/toothbrush-inc/toy-box-gateway/security/advisories/new).
If private reporting is unavailable, contact the repository maintainer
privately. Do not post credentials, personal data or working exploits in
public issues. Include the version, deployment mode, reproduction steps and
expected impact. Fixes target the latest release.

## Trust boundaries

Local children run under the gateway's OS user. They can access that user's
files, including a plaintext vault when the file backend is enabled. The
gateway's grants and broker-only environment setting are API controls, not
an OS sandbox. HTTP serve mode does not change this. Untrusted child packages
require deployment-level isolation and restricted filesystem/network access.

View transforms run in a separate QuickJS WebAssembly runtime with no host
APIs, a memory limit and an execution deadline. Keep the runtime and gateway
dependencies updated.

Hosted operators must set `serve.owners` for management access and
`serve.credentialUsers` for explicit user access to vault connections. Private
views belong to their authenticated creator; shareable views expose their
snapshots to every signed-in user. Before upgrading a previously exposed
instance, inspect existing pinned views and their owners: older versions
accepted caller-supplied owners. Remove or correct untrusted stored views
before restarting their schedules, and rotate credentials if compromise is
suspected.

Browser cookies are host-only by default. Enabling `sessionCookieDomain`
trusts every sibling host with that credential. Strip cookies at a trusted
sibling proxy after authentication and pass only the verified user header to
apps. Logout revokes the presented session token, including copies, on disk.
Allowlist changes take effect after the gateway reloads its configuration.
