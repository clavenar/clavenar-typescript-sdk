# @clavenar/agent-sdk

[![CI](https://github.com/clavenar/clavenar-typescript-sdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/clavenar/clavenar-typescript-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@clavenar/agent-sdk.svg)](https://www.npmjs.com/package/@clavenar/agent-sdk)

TypeScript SDK for [Clavenar](https://clavenar.com).
Wraps your Anthropic or OpenAI client and inspects every tool call
the model emits against your policies *before* your tool-execution
loop runs it.

Sequence diagrams for the five primary paths — `clavenarWrap` boot +
structural detection, non-streaming inspection, streaming
choice-end gating, `ClavenarPending.resolve` poll loop, and the
standalone OpenAI Realtime helper — plus a request decision-tree
flowchart, live in [`docs/SEQUENCES.md`](docs/SEQUENCES.md).

## Quickstart

Three commands from zero to a verdict:

```bash
# 1. Boot clavenar-lite locally. (Container, fly.io, or the static
#    binary asset — pick what's easy for you. See:
#    https://github.com/clavenar/clavenar-lite#run-it-in-60-seconds )
docker run -p 8088:8088 \
  -e CLAVENAR_LITE_UPSTREAM_URL=https://api.anthropic.com \
  -e CLAVENAR_LITE_MODE=observe \
  ghcr.io/clavenar/clavenar-lite:latest

# 2. Install the SDK in your agent project.
pnpm add @clavenar/agent-sdk @anthropic-ai/sdk

# 3. Wrap your client. The snippet below catches a deny verdict;
#    in observe mode every call passes through and you read the
#    verdict off the `onVerdict` callback instead.
```

Then the snippet that catches a deny:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { clavenarWrap, ClavenarDenied } from '@clavenar/agent-sdk';

const client = clavenarWrap(new Anthropic(), {
  endpoint: 'http://localhost:8088',         // clavenar-lite ingress
  token: process.env.CLAVENAR_LITE_TOKEN,      // optional bearer
});

try {
  const msg = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    tools: [/* your tool schemas */],
    messages: [{ role: 'user', content: 'delete the alice user' }],
  });
  // If the model emits a tool_use that policy denies, this never
  // resolves — the throw below fires instead. Your existing tool
  // loop only ever sees policy-cleared tool_use blocks.
} catch (e) {
  if (e instanceof ClavenarDenied) {
    log.warn('blocked', { tool: e.toolName, reasons: e.reasons });
  } else throw e;
}
```

### OpenAI

Same wrap, same options — the SDK auto-detects the client shape:

```ts
import OpenAI from 'openai';
import { clavenarWrap, ClavenarDenied } from '@clavenar/agent-sdk';

const client = clavenarWrap(new OpenAI(), {
  endpoint: 'http://localhost:8088',
});

const completion = await client.chat.completions.create({
  model: 'gpt-4-turbo',
  tools: [/* your tool schemas */],
  messages: [{ role: 'user', content: 'delete the alice user' }],
});
// Every entry in choices[].message.tool_calls is inspected before
// this promise resolves; denied calls raise ClavenarDenied just like
// the Anthropic path.
```

### Streaming

Both providers' streaming surfaces are wrapped transparently. The
SDK detects an async-iterable return from `create()` and inspects
each tool call as it assembles from deltas. The closing event
(Anthropic `content_block_stop`, OpenAI `finish_reason: 'tool_calls'`)
is held until clavenar returns a verdict — denied calls throw
mid-iteration *before* the partner sees the event that would let
their loop execute the tool.

```ts
const stream = await client.messages.create({
  model: 'claude-opus-4-7', max_tokens: 1024, stream: true,
  tools: [...], messages: [...],
});
try {
  for await (const event of stream) {
    /* process event */
  }
} catch (e) {
  if (e instanceof ClavenarDenied) {
    // partner never saw content_block_stop for the denied tool_use
  } else throw e;
}
```

Same shape with OpenAI's `chat.completions.create({ stream: true })`.
The provider SDKs' `.stream()` convenience helpers
(`messages.stream()`, `chat.completions.stream()`) are **blocked** by
the wrapper: their rich event interfaces can't be wrapped faithfully,
and tool calls made through them would bypass inspection entirely.
Calling one throws `ClavenarConfigError` pointing at
`create({ stream: true })`; set `allowUninspectedStream: true` only if
you explicitly accept uninspected streaming.

## Debugging a denial

When a tool call is denied you get a `ClavenarDenied` with `reasons`,
`layer`, and `correlationId`. To see *which detector* fired, run the
gateway with `CLAVENAR_PROXY_VERBOSE_VERDICTS=true` (Lite:
`--verbose-verdicts`) — the deny envelope then carries a per-detector
`detail` breakdown, exposed as `err.detail` and rendered to stderr when
you set `devMode: true`:

```ts
const client = clavenarWrap(anthropic, {
  endpoint: 'https://clavenar.internal',
  devMode: true, // dev/staging only — detailed denials are an attacker oracle
});
// On a deny, the SDK prints a panel to stderr:
//   ━━ clavenar denied: send_email ━━
//     layer=brain  intent=Exfiltration  correlation=abc-123
//     reasons:
//       - indirect prompt injection
//     detectors:
//       persona_drift         0.12
//       injection             0.91  ⚠ flagged
//     degraded: injection
```

Programmatic access (no `devMode` needed):

```ts
try {
  await client.messages.create(/* … */);
} catch (e) {
  if (e instanceof ClavenarDenied && e.detail) {
    const fired = e.detail.detectors.filter((d) => d.flagged || d.score >= 0.5);
    console.log('fired detectors:', fired);
  }
}
```

`detail` is present only when the gateway opts in; without it the panel
prints a hint to enable verbose verdicts. `renderDenyPanel(err)` is
exported if you want the string without writing to stderr.

## What it does

`clavenarWrap` is a transparent `Proxy` around your model client.
Detection is structural: a client with `messages.create` is wrapped
as Anthropic, a client with `chat.completions.create` as OpenAI.
Every other property — `client.beta`, `client.models`, custom
subclasses — passes through unchanged.

On every response, every tool call (Anthropic `tool_use` content
block / OpenAI `tool_calls` entry) is sent to clavenar-lite's
`POST /mcp` with `x-clavenar-decision-contract: clavenar.decision/v1` for
side-effect-free inspection. Each request gets a client-generated UUID before
the first network attempt, and multi-tool turns use one ordered atomic-batch
decision. Proxy 0.5.0 and Lite 0.9.0 reject unselected tool calls with HTTP 426;
upgrade this SDK before the gateway by following
<https://clavenar.com/docs/sdk-migration/>. The verdict drives:

| mode | verdict | result |
|---|---|---|
| `enforce` (default) | allow | response passes through |
| `enforce` | deny | `throw ClavenarDenied` |
| `enforce` | pending | `throw ClavenarPending` — `await e.resolve()` blocks for human approval, then returns void or throws `ClavenarDenied` |
| `observe` | any | response passes through, `onVerdict` fires |

`observe` is the rollout knob: clavenar inspects + records every call,
your code keeps running. Flip to `enforce` once you trust the
verdicts.

## Install

```sh
pnpm add @clavenar/agent-sdk @anthropic-ai/sdk     # Anthropic
pnpm add @clavenar/agent-sdk openai                # OpenAI
```

`@anthropic-ai/sdk` and `openai` are peer dependencies — install
whichever ones you use. The SDK has no hard import on either.

Run a clavenar-lite instance somewhere reachable.
[`clavenar-lite`](https://github.com/clavenar/clavenar-lite) is a
single Rust binary, self-hosted in your infra — container, Fly.io
button, or `cargo install`. See its [Run it in 60 seconds](https://github.com/clavenar/clavenar-lite#run-it-in-60-seconds)
section.

## Demo

```sh
pnpm install
pnpm demo
```

See [`examples/demo/`](./examples/demo/) — runs three canned scenarios
end-to-end against a local clavenar-lite:

```
[1/3] agent: "fetch user 42"        clavenar: [ALLOW]  passes through
[2/3] agent: "delete user 42"       clavenar: [DENY]   throws ClavenarDenied
[3/3] agent: "transfer $100"        clavenar: [PEND]   throws ClavenarPending
```

## API

### `clavenarWrap(client, opts) → client`

| opts field | type | default | what |
|---|---|---|---|
| `endpoint` | `string` | required | clavenar-lite ingress URL |
| `token` | `string` | `undefined` | bearer for clavenar-lite |
| `mode` | `'enforce' \| 'observe'` | `'enforce'` | throw on deny vs. record only |
| `timeoutMs` | `number` | `10_000` | per-inspection HTTP timeout |
| `onVerdict` | `(v, ctx) => void \| Promise<void>` | `undefined` | fires per inspected `tool_use` (before any throw) |
| `onPolicyError` | `(e, ctx) => void \| Promise<void>` | `undefined` | observe mode only — fires when clavenar inspection fails at the transport layer (unreachable, 5xx after retries, malformed body). The underlying agent call passes through regardless. In enforce mode the SDK throws `ClavenarTransportError` and this callback does not fire. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | override for testing |
| `retry` | `{ maxAttempts, baseDelayMs }` | `{ 3, 100 }` | network errors + 5xx retry with jittered exponential backoff. `maxAttempts: 1` disables. |

### Exceptions

- `ClavenarDenied` — verdict was `deny`. Carries `toolName`, `reasons`,
  `reviewReasons`, `intentCategory`, `layer` (the stage that said no —
  `brain`, `policy`, `hil`, `egress`, …, when the server reports it),
  and `correlationId` (when the server emits `X-Clavenar-Correlation-Id`)
  for direct ledger lookup. Works against both clavenar-lite and the
  full-edition proxy, which now share one JSON 403 envelope.
- `ClavenarPending` — verdict was `pending` (HIL parked the call).
  Carries `toolName`, `correlationId`, and `reviewReasons`. Also
  exposes `resolve({pollIntervalMs?, timeoutMs?}): Promise<void>` —
  polls clavenar-lite until the operator decides. Resolves on `allow`,
  throws `ClavenarDenied` on `deny`, throws `ClavenarTransportError` on
  timeout (default 10 min). Lift this into a tool-execution loop:
  ```ts
  try {
    const msg = await wrapped.messages.create({...});
  } catch (e) {
    if (e instanceof ClavenarPending) {
      await e.resolve();                  // blocks until decided
      return wrapped.messages.create({...}); // retry now that operator approved
    }
    throw e;
  }
  ```
- `ClavenarConfigError` — bad options passed to `clavenarWrap`.
- `ClavenarTransportError` — clavenar ingress unreachable or returned an
  unexpected status / body shape. Carries `status` when known.

## Wire format

`POST {endpoint}/mcp` with a JSON-RPC 2.0 envelope:

```json
{
  "jsonrpc": "2.0",
  "method":  "tools/call",
  "params":  { "name": "<tool name>", "arguments": <tool input> },
  "id":      "<provider tool-call id>"
}
```

The tool-call id round-trips into clavenar's audit ledger so a single
ledger lookup correlates back to the model's exact call. Anthropic
emits `toolu_*`, OpenAI emits `call_*` — both pass through verbatim.
See [`clavenar-lite/src/proxy.rs`](https://github.com/clavenar/clavenar-lite/blob/main/src/proxy.rs)
for the server side.

## Develop

```sh
pnpm install
pnpm build       # tsup → dist/{index.mjs, index.cjs, index.d.ts}
pnpm test        # vitest, 103 unit tests
pnpm typecheck   # tsc --noEmit
pnpm demo        # full e2e against local clavenar-lite
```

End-to-end tests (7 cases against live clavenar-lite) skip unless
`CLAVENAR_E2E_ENDPOINT` is set:

```sh
CLAVENAR_E2E_ENDPOINT=http://localhost:8088 CLAVENAR_E2E_TOKEN=... pnpm test
```

## Wire contract

The HTTP shape this SDK speaks against the inspect endpoint
(`POST /mcp`, the verdict envelope, the pending / resolve
contract, and the `X-Clavenar-*` header set) is documented in the
workspace's source of truth:
[`clavenar-specs/TECH_SPEC.md`](https://github.com/clavenar/clavenar-specs/blob/main/TECH_SPEC.md).
This SDK is a faithful client of that contract — if you observe a
divergence, file the bug against the spec first.

The Python sibling at
[`clavenar-python-sdk`](https://github.com/clavenar/clavenar-python-sdk)
implements the same wire contract with parity guarantees.

## License

Apache-2.0. See [LICENSE](./LICENSE).
