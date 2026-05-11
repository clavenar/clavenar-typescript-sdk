# Changelog

All notable changes to `@vanteguardlabs/warden-ai-sdk` are documented here. Format
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html);
0.x means the public API is still settling — we'll cut 1.0 when the
shape stabilizes against the first 3 design partners.

## [0.1.0] - 2026-05-11

First published release. Wraps your Anthropic or OpenAI client so
every tool call the model emits is inspected by Agent Warden before
your tool-execution loop runs it.

### Added

- `wardenWrap(client, opts)` — transparent `Proxy` over the model
  client. Structural detection routes Anthropic
  (`messages.create`) and OpenAI (`chat.completions.create`) without
  a manual provider switch. Non-Anthropic/OpenAI clients are rejected
  at wrap time with `WardenConfigError`.
- Streaming for both providers via `create({ stream: true })`. The
  closing event (`content_block_stop` on Anthropic,
  `finish_reason: 'tool_calls'` on OpenAI) is held until warden
  returns a verdict; denied calls throw mid-iteration before the
  partner's tool-execution loop can act on them.
- Parallel inspection — multi-tool turns kick off all warden
  round-trips concurrently via `Promise.all`. Submission order
  preserved when surfacing the first deny, so semantics stay
  deterministic.
- Transient retry: `opts.retry` defaults to `{ maxAttempts: 3,
  baseDelayMs: 100 }` with jittered exponential backoff. Network
  failures and 5xx responses retry; 200, 403, and other 4xx never do.
  Set `maxAttempts: 1` to disable.
- `X-Warden-Correlation-Id` round-trips from the warden-lite
  response onto `WardenDenied.correlationId` and
  `WardenPending.correlationId` — partners get the ledger lookup key
  directly off the thrown error.
- Mode option: `'enforce'` (default) throws `WardenDenied` /
  `WardenPending`; `'observe'` records every verdict via `onVerdict`
  and never blocks. Rollout knob — observe everywhere first, flip to
  enforce per-call once verdicts are trusted.
- 65 unit tests across `wrap`, `stream`, `transport` (Anthropic +
  OpenAI surfaces); 5 live e2e tests gated on `WARDEN_E2E_ENDPOINT`.
- Week-1 demo (`pnpm demo`) boots warden-lite + a stub upstream,
  runs allow + deny scenarios against the wrap pattern end-to-end.

### Notes

- `messages.stream()` (Anthropic helper) is **not** yet wrapped —
  use `messages.create({ stream: true })` for streaming.
- Both `@anthropic-ai/sdk` and `openai` are peer-deps. Install
  whichever you use; the SDK has no hard import on either.

[0.1.0]: https://github.com/vanteguardlabs/warden-ai-sdk/releases/tag/v0.1.0
