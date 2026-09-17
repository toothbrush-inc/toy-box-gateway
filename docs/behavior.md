Part of the [capability-gateway docs](../README.md#what-is-in-the-box). Back to [README](../README.md).

# Behavior details

- Tool results pass through verbatim — typed JSON `{ok, data}` /
  `{ok: false, error: {code, message}}`, `structuredContent` included. Child
  progress notifications are re-emitted upstream (long calls like
  `calsync__preview_sync` keep their progress), and cancelling a call at the
  agent cancels it in the child.
- A crashed capability's tools disappear from listings (`tools/list_changed`),
  its calls return `capability_offline`, and `gateway_reconnect` respawns it.
  The gateway never auto-respawns.
- Config errors, child stderr, and mount failures go to the gateway's stderr,
  prefixed `[<capability>]`.
- **Tool policy.** Per-capability `allowTools` / `denyTools` in the gateway
  config; deny wins; denied tools are hidden from listings and blocked at call
  time with a message naming the config to edit.
- **Audit log.** Append-only JSONL at
  `<gateway home>/audit/audit.jsonl` (macOS:
  `~/Library/Application Support/capability-gateway`; override with
  `GATEWAY_HOME` or `audit.dir`). One line per call: timestamp, capability,
  tool, outcome (`ok` | `error` | `denied`), duration, and a typed error code
  when there is one. **Tool arguments and results are never written**;
  gateway-originated error text is token-scrubbed first. Size-based rotation.

## Future (not built)

Rate limits per grant; calsync's internal adoption of `/token` (a
BrokeredAuthClient for googleapis — until then calsync reads its refresh
token in-process under explicit grants); non-GET egress and streaming bodies;
OS sandboxing; hosted mode with an install/grant UI. See
[toy-box-vault FUTURE.md](https://github.com/toothbrush-inc/toy-box-vault/blob/main/FUTURE.md).
