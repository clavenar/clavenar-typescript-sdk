# Changelog

All notable changes to `@clavenar/agent-sdk` are documented here. Format
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
1.0.0 marks the move to the `@clavenar` scope; the public API matches 0.3.0.

## [Unreleased]

## [1.6.0] - 2026-07-26

### Added

- `SecureTransportProfile` supplies reloadable CA/client-identity sources,
  per-request token acquisition, separate connect/request deadlines, and
  direct/environment/explicit proxy policy to every inspection and poll.

## [1.5.0] - 2026-07-21

### Changed

- Package the exact `clavenar.client-migration/v1` fixture and schema and
  document the client-first rollout. Inspection remains an explicit
  side-effect-free decision with its canonical pre-network request ID.

## [1.4.0] - 2026-07-21

### Changed

- Automatic retries are explicitly confined to the side-effect-free decision
  transport with one stable pre-network idempotency ID. Registered executor
  failures remain single-attempt, and the shared retry-separation fixture is
  packaged for cross-language conformance.

## [1.3.0] - 2026-07-21

### Changed

- Single-tool provider turns use the concrete side-effect-free decision wire
  shape; the atomic batch envelope remains reserved for turns with two or more
  sibling calls. This keeps Lite and Proxy interoperability without weakening
  multi-call atomicity.

## [1.2.0] - 2026-07-21

### Added

- Governed execution with a construction-time registered executor, durable
  intent/completion store, workload receipt signer, stable prepared requests,
  and actual provider-result return.
- The shared `clavenar.sdk-cross-language/v1` conformance fixture.

### Changed

- Inspection now explicitly selects the side-effect-free
  `clavenar.decision/v1` contract with a client-generated UUID retained across
  safe retries. Multi-tool provider turns use one ordered atomic decision
  instead of independent sibling requests.

### Added

- 429 rate-limit verdicts: the transport now parses the spec's
  `rate_limited` / `quota_exceeded` envelope instead of collapsing a
  429 into a generic `ClavenarTransportError`. Enforce mode throws the
  new `ClavenarRateLimited` (carrying `code`, `retryAfterSecs`,
  `reasons`, `correlationId`); observe mode surfaces the new
  `{ kind: 'rate_limited' }` verdict via `onVerdict` and passes the
  response through. 429s are never auto-retried — honor
  `retryAfterSecs` in the caller.

## [1.1.0] - 2026-06-08

### Added

- **Dev-mode deny rendering.** With `devMode: true`, a `ClavenarDenied`
  carrying a verbose `detail` breakdown prints a per-detector panel to
  stderr (layer, intent, correlation, fired detectors). The panel string
  is also exported as `renderDenyPanel(err)` for callers that want it
  without writing to stderr. `detail` is populated only when the gateway
  runs with `CLAVENAR_PROXY_VERBOSE_VERDICTS=true` (Lite:
  `--verbose-verdicts`); detailed denials are an attacker oracle, so keep
  `devMode` to dev/staging.

## [1.0.0] - 2026-06-07

### Changed

- **Moved to the `@clavenar` npm scope: `@vanteguardlabs/clavenar-ai-sdk`
  is now `@clavenar/agent-sdk`.** The GitHub repository was renamed to
  `clavenar-typescript-sdk`. No API changes from 0.3.0 — update your
  install to `pnpm add @clavenar/agent-sdk` and your import specifier; the
  exported surface is byte-for-byte identical.

## [0.3.0] - 2026-05-12

### Added

- **`onPolicyError` callback** on `ClavenarOptions`. Fires when an
  inspection fails at the transport layer (clavenar unreachable, 5xx
  after retries exhausted, malformed body, …). In `mode: 'observe'`
  this is the new signal partners log/alert on instead of try/catch
  around `create()`. In `mode: 'enforce'` the SDK still throws —
  fail-closed is the safer enforce semantic, and the callback is
  not invoked.

### Fixed

- **Observe-mode transport-error resilience.** Previously, a clavenar
  outage during inspection would propagate the `ClavenarTransportError`
  back through `create()` in observe mode too, contradicting the
  documented contract ("no throw, every verdict via `onVerdict`,
  response passes through"). Now observe catches transport failures
  per-call so one clavenar outage doesn't poison a Promise.all of
  parallel tool_use inspections; the underlying agent call passes
  through and `onPolicyError` fires. Enforce mode is unchanged.

## [0.2.1] - 2026-05-11

Docs-only patch. No code changes — same `dist/` bytes as 0.2.0.

### Fixed

- CHANGELOG previously claimed v0.2.0 of the SDK "pairs with
  `clavenar-lite` 0.2.0+". Not true: the async-HIL wire contract (202
  Accepted, `/pending/{id}` endpoints, decide endpoint) only landed
  in `clavenar-lite` v0.3.0. The 0.2.0 entry now carries a clarifying
  note pinning the floor at v0.3.0.
- README quickstart's `docker run … clavenar-lite` referenced an
  unqualified image name; switched to
  `ghcr.io/clavenar/clavenar-lite:latest`. Dropped the broken
  `cargo install clavenar-lite` reference (the crate isn't on
  crates.io).

## [0.2.0] - 2026-05-11

Yellow-tier release. Pairs with `clavenar-lite` 0.3.0+'s async-HIL wire
contract (`202 Accepted` from `/mcp`, `GET /pending/{id}` poll,
`POST /pending/{id}/decide`). Adds the `ClavenarPending.resolve()`
helper so partners can `try { create() } catch (ClavenarPending) { await
e.resolve() }` without writing poll loops or callback servers.

Note: `clavenar-lite` v0.2.0 does not implement this wire contract —
202 responses + the pending endpoints landed in v0.3.0. Run
`ghcr.io/clavenar/clavenar-lite:latest` or pin to `:0.3.0` or
later if you're catching `ClavenarPending`.

### Added

- **`ClavenarPending.resolve(opts?)`** — polls clavenar-lite until an
  operator decides. Returns void on `allow`, throws `ClavenarDenied` on
  `deny`, throws `ClavenarTransportError` on timeout. Defaults:
  `pollIntervalMs: 2_000`, `timeoutMs: 600_000`. Transient transport
  errors (5xx, network blips) are swallowed between polls; 401 / 404
  surface immediately. The poll callback is pre-bound at throw time
  closing over `endpoint + token + fetch`, so resolve doesn't need to
  re-read the original options.
- **`ClavenarPending.reviewReasons`** — carries the `review_reasons`
  array clavenar-lite emits in the 202 body. Useful for surfacing in a
  UI (`"this call is awaiting approval because: …"`).
- **`pollPendingOnce(correlationId, opts)`** — exported low-level
  helper for callers who want to drive the poll loop themselves.
- **`ClavenarVerdict.pending`** now carries `reviewReasons: string[]`.
- **`ClavenarPendingResponse`** / **`ClavenarPendingView`** types model the
  202 body and the GET-pending body respectively.
- **Demo**: third scenario (`transfer_funds`) demonstrates the
  catch-resolve-retry pattern end-to-end. The demo runner auto-approves
  via `POST /pending/{id}/decide` after 1.5s; in production that's a
  Slack approval or dashboard click — the SDK side is identical.

### Migration notes

- The `ClavenarPending` constructor now requires `reviewReasons` and a
  `pollOnce` callback. Direct construction was always internal; only
  the wrap and stream code paths instantiate it, so partner code
  catching the throw is unaffected.
- A 202 response from `/mcp` was previously surfaced as
  `ClavenarTransportError` (unexpected status). It now parses cleanly to
  the pending verdict. If you had a `catch` branch on the transport
  error specifically expecting 202, update it to handle
  `ClavenarPending`.

## [0.1.0] - 2026-05-11

First published release. Wraps your Anthropic or OpenAI client so
every tool call the model emits is inspected by Clavenar before
your tool-execution loop runs it.

### Added

- `clavenarWrap(client, opts)` — transparent `Proxy` over the model
  client. Structural detection routes Anthropic
  (`messages.create`) and OpenAI (`chat.completions.create`) without
  a manual provider switch. Non-Anthropic/OpenAI clients are rejected
  at wrap time with `ClavenarConfigError`.
- Streaming for both providers via `create({ stream: true })`. The
  closing event (`content_block_stop` on Anthropic,
  `finish_reason: 'tool_calls'` on OpenAI) is held until clavenar
  returns a verdict; denied calls throw mid-iteration before the
  partner's tool-execution loop can act on them.
- Parallel inspection — multi-tool turns kick off all clavenar
  round-trips concurrently via `Promise.all`. Submission order
  preserved when surfacing the first deny, so semantics stay
  deterministic.
- Transient retry: `opts.retry` defaults to `{ maxAttempts: 3,
  baseDelayMs: 100 }` with jittered exponential backoff. Network
  failures and 5xx responses retry; 200, 403, and other 4xx never do.
  Set `maxAttempts: 1` to disable.
- `X-Clavenar-Correlation-Id` round-trips from the clavenar-lite
  response onto `ClavenarDenied.correlationId` and
  `ClavenarPending.correlationId` — partners get the ledger lookup key
  directly off the thrown error.
- Mode option: `'enforce'` (default) throws `ClavenarDenied` /
  `ClavenarPending`; `'observe'` records every verdict via `onVerdict`
  and never blocks. Rollout knob — observe everywhere first, flip to
  enforce per-call once verdicts are trusted.
- 65 unit tests across `wrap`, `stream`, `transport` (Anthropic +
  OpenAI surfaces); 5 live e2e tests gated on `CLAVENAR_E2E_ENDPOINT`.
- Week-1 demo (`pnpm demo`) boots clavenar-lite + a stub upstream,
  runs allow + deny scenarios against the wrap pattern end-to-end.

### Notes

- `messages.stream()` (Anthropic helper) is **not** yet wrapped —
  use `messages.create({ stream: true })` for streaming.
- Both `@anthropic-ai/sdk` and `openai` are peer-deps. Install
  whichever you use; the SDK has no hard import on either.

[1.1.0]: https://github.com/clavenar/clavenar-typescript-sdk/releases/tag/v1.1.0
[1.0.0]: https://github.com/clavenar/clavenar-typescript-sdk/releases/tag/v1.0.0
[0.3.0]: https://github.com/clavenar/clavenar-typescript-sdk/releases/tag/v0.3.0
[0.2.1]: https://github.com/clavenar/clavenar-typescript-sdk/releases/tag/v0.2.1
[0.2.0]: https://github.com/clavenar/clavenar-typescript-sdk/releases/tag/v0.2.0
[0.1.0]: https://github.com/clavenar/clavenar-typescript-sdk/releases/tag/v0.1.0
