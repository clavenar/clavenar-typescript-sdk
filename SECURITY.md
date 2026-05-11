# Security policy

## Reporting

Email `vanteguardlabs@gmail.com`. Please do not file public issues
for security-sensitive findings.

## Scope

This package is a client-side wrapper that POSTs tool-call metadata
to a warden-lite ingress. It does NOT:

- Run policy evaluation locally (the warden-lite process does).
- Persist anything to disk.
- Reach the network except to the configured `endpoint`.

## What we audit

- Every release tag carries a generated SBOM.
- `pnpm audit` runs in CI on every PR.
- Peer-dep on `@anthropic-ai/sdk` is intentional — we do not ship a
  vendored copy of upstream client code.

## Threat model boundary

The SDK trusts the warden-lite ingress at `opts.endpoint`. If that
endpoint is reachable but operated by an attacker, the attacker can
silently allow tool calls that should have been denied. Run
warden-lite in your own infra (per the roadmap's hosting model) or
pin a TLS cert at the network layer.
