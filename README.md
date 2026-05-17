# @vanteguardlabs/warden-ai-sdk

[![CI](https://github.com/vanteguardlabs/warden-ai-sdk/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vanteguardlabs/warden-ai-sdk/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@vanteguardlabs/warden-ai-sdk.svg)](https://www.npmjs.com/package/@vanteguardlabs/warden-ai-sdk)

TypeScript SDK for [Agent Warden](https://warden.vanteguardlabs.com).
Wraps your Anthropic or OpenAI client and inspects every tool call
the model emits against your policies *before* your tool-execution
loop runs it.

## Quickstart

Three commands from zero to a verdict:

```bash
# 1. Boot warden-lite locally. (Container, fly.io, or the static
#    binary asset — pick what's easy for you. See:
#    https://github.com/vanteguardlabs/warden-lite#run-it-in-60-seconds )
docker run -p 8088:8088 \
  -e WARDEN_LITE_UPSTREAM_URL=https://api.anthropic.com \
  -e WARDEN_LITE_MODE=observe \
  ghcr.io/vanteguardlabs/warden-lite:latest

# 2. Install the SDK in your agent project.
pnpm add @vanteguardlabs/warden-ai-sdk @anthropic-ai/sdk

# 3. Wrap your client. The snippet below catches a deny verdict;
#    in observe mode every call passes through and you read the
#    verdict off the `onVerdict` callback instead.
```

Then the snippet that catches a deny:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { wardenWrap, WardenDenied } from '@vanteguardlabs/warden-ai-sdk';

const client = wardenWrap(new Anthropic(), {
  endpoint: 'http://localhost:8088',         // warden-lite ingress
  token: process.env.WARDEN_LITE_TOKEN,      // optional bearer
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
  if (e instanceof WardenDenied) {
    log.warn('blocked', { tool: e.toolName, reasons: e.reasons });
  } else throw e;
}
```

### OpenAI

Same wrap, same options — the SDK auto-detects the client shape:

```ts
import OpenAI from 'openai';
import { wardenWrap, WardenDenied } from '@vanteguardlabs/warden-ai-sdk';

const client = wardenWrap(new OpenAI(), {
  endpoint: 'http://localhost:8088',
});

const completion = await client.chat.completions.create({
  model: 'gpt-4-turbo',
  tools: [/* your tool schemas */],
  messages: [{ role: 'user', content: 'delete the alice user' }],
});
// Every entry in choices[].message.tool_calls is inspected before
// this promise resolves; denied calls raise WardenDenied just like
// the Anthropic path.
```

### Streaming

Both providers' streaming surfaces are wrapped transparently. The
SDK detects an async-iterable return from `create()` and inspects
each tool call as it assembles from deltas. The closing event
(Anthropic `content_block_stop`, OpenAI `finish_reason: 'tool_calls'`)
is held until warden returns a verdict — denied calls throw
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
  if (e instanceof WardenDenied) {
    // partner never saw content_block_stop for the denied tool_use
  } else throw e;
}
```

Same shape with OpenAI's `chat.completions.create({ stream: true })`.
For Anthropic's `messages.stream()` helper, use
`messages.create({ stream: true })` instead until that helper's
wrap lands in a follow-up.

## What it does

`wardenWrap` is a transparent `Proxy` around your model client.
Detection is structural: a client with `messages.create` is wrapped
as Anthropic, a client with `chat.completions.create` as OpenAI.
Every other property — `client.beta`, `client.models`, custom
subclasses — passes through unchanged.

On every response, every tool call (Anthropic `tool_use` content
block / OpenAI `tool_calls` entry) is sent to warden-lite's
`POST /mcp` for inspection. The verdict drives:

| mode | verdict | result |
|---|---|---|
| `enforce` (default) | allow | response passes through |
| `enforce` | deny | `throw WardenDenied` |
| `enforce` | pending | `throw WardenPending` — `await e.resolve()` blocks for human approval, then returns void or throws `WardenDenied` |
| `observe` | any | response passes through, `onVerdict` fires |

`observe` is the rollout knob: warden inspects + records every call,
your code keeps running. Flip to `enforce` once you trust the
verdicts.

## Install

```sh
pnpm add @vanteguardlabs/warden-ai-sdk @anthropic-ai/sdk     # Anthropic
pnpm add @vanteguardlabs/warden-ai-sdk openai                # OpenAI
```

`@anthropic-ai/sdk` and `openai` are peer dependencies — install
whichever ones you use. The SDK has no hard import on either.

Run a warden-lite instance somewhere reachable.
[`warden-lite`](https://github.com/vanteguardlabs/warden-lite) is a
single Rust binary, self-hosted in your infra — container, Fly.io
button, or `cargo install`. See its [Run it in 60 seconds](https://github.com/vanteguardlabs/warden-lite#run-it-in-60-seconds)
section.

## Demo

```sh
pnpm install
pnpm demo
```

See [`examples/demo/`](./examples/demo/) — runs two canned scenarios
end-to-end against a local warden-lite:

```
[1/2] agent: "fetch user 42"        warden: [ALLOW]  passes through
[2/2] agent: "delete user 42"       warden: [DENY]   throws WardenDenied
```

## API

### `wardenWrap(client, opts) → client`

| opts field | type | default | what |
|---|---|---|---|
| `endpoint` | `string` | required | warden-lite ingress URL |
| `token` | `string` | `undefined` | bearer for warden-lite |
| `mode` | `'enforce' \| 'observe'` | `'enforce'` | throw on deny vs. record only |
| `timeoutMs` | `number` | `10_000` | per-inspection HTTP timeout |
| `onVerdict` | `(v, ctx) => void \| Promise<void>` | `undefined` | fires per inspected `tool_use` (before any throw) |
| `onPolicyError` | `(e, ctx) => void \| Promise<void>` | `undefined` | observe mode only — fires when warden inspection fails at the transport layer (unreachable, 5xx after retries, malformed body). The underlying agent call passes through regardless. In enforce mode the SDK throws `WardenTransportError` and this callback does not fire. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | override for testing |
| `retry` | `{ maxAttempts, baseDelayMs }` | `{ 3, 100 }` | network errors + 5xx retry with jittered exponential backoff. `maxAttempts: 1` disables. |

### Exceptions

- `WardenDenied` — verdict was `deny`. Carries `toolName`, `reasons`,
  `reviewReasons`, `intentCategory`, and `correlationId` (when
  warden-lite emits `X-Warden-Correlation-Id`) for direct ledger
  lookup.
- `WardenPending` — verdict was `pending` (HIL parked the call).
  Carries `toolName`, `correlationId`, and `reviewReasons`. Also
  exposes `resolve({pollIntervalMs?, timeoutMs?}): Promise<void>` —
  polls warden-lite until the operator decides. Resolves on `allow`,
  throws `WardenDenied` on `deny`, throws `WardenTransportError` on
  timeout (default 10 min). Lift this into a tool-execution loop:
  ```ts
  try {
    const msg = await wrapped.messages.create({...});
  } catch (e) {
    if (e instanceof WardenPending) {
      await e.resolve();                  // blocks until decided
      return wrapped.messages.create({...}); // retry now that operator approved
    }
    throw e;
  }
  ```
- `WardenConfigError` — bad options passed to `wardenWrap`.
- `WardenTransportError` — warden ingress unreachable or returned an
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

The tool-call id round-trips into warden's audit ledger so a single
ledger lookup correlates back to the model's exact call. Anthropic
emits `toolu_*`, OpenAI emits `call_*` — both pass through verbatim.
See [`warden-lite/src/proxy.rs`](https://github.com/vanteguardlabs/warden-lite/blob/main/src/proxy.rs)
for the server side.

## Develop

```sh
pnpm install
pnpm build       # tsup → dist/{index.mjs, index.cjs, index.d.ts}
pnpm test        # vitest, 65 unit tests
pnpm typecheck   # tsc --noEmit
pnpm demo        # full e2e against local warden-lite
```

End-to-end tests (5 cases against live warden-lite) skip unless
`WARDEN_E2E_ENDPOINT` is set:

```sh
WARDEN_E2E_ENDPOINT=http://localhost:8088 WARDEN_E2E_TOKEN=... pnpm test
```

## Wire contract

The HTTP shape this SDK speaks against the inspect endpoint
(`POST /inspect`, the verdict envelope, the pending / resolve
contract, and the `X-Warden-*` header set) is documented in the
workspace's source of truth:
[`warden-specs/TECH_SPEC.md`](https://github.com/vanteguardlabs/warden-specs/blob/main/TECH_SPEC.md).
This SDK is a faithful client of that contract — if you observe a
divergence, file the bug against the spec first.

The Python sibling at
[`warden-ai-py`](https://github.com/vanteguardlabs/warden-ai-py)
implements the same wire contract with parity guarantees.

## License

Apache-2.0. See [LICENSE](./LICENSE).
