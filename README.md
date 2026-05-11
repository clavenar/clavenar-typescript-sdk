# @warden/ai-sdk

TypeScript SDK for [Agent Warden](https://warden.vanteguardlabs.com).
Wraps your Anthropic client and inspects every `tool_use` block
against your policies *before* your tool-execution loop runs it.

```ts
import Anthropic from '@anthropic-ai/sdk';
import { wardenWrap, WardenDenied } from '@warden/ai-sdk';

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

## What it does

`wardenWrap` is a transparent `Proxy` around your Anthropic client.
The only method it intercepts is `messages.create`; every other
property — `client.beta`, `client.models`, custom subclasses — passes
through unchanged.

On every response, every `tool_use` content block is sent to
warden-lite's `POST /mcp` for inspection. The verdict drives:

| mode | verdict | result |
|---|---|---|
| `enforce` (default) | allow | response passes through |
| `enforce` | deny | `throw WardenDenied` |
| `enforce` | pending | `throw WardenPending` (warden-lite Yellow-tier; roadmap week 4) |
| `observe` | any | response passes through, `onVerdict` fires |

`observe` is the rollout knob: warden inspects + records every call,
your code keeps running. Flip to `enforce` once you trust the
verdicts.

## Install

```sh
pnpm add @warden/ai-sdk @anthropic-ai/sdk
```

Run a warden-lite instance somewhere reachable. The
[`warden-lite`](https://github.com/vanteguardlabs/warden-lite) binary
is a single Rust binary, self-hosted in your infra. 60-second
deploy via Fly.io / Railway / Render button (roadmap week 3).

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
| `fetch` | `typeof fetch` | `globalThis.fetch` | override for testing |

### Exceptions

- `WardenDenied` — verdict was `deny`. Carries `toolName`, `reasons`,
  `reviewReasons`, `intentCategory`.
- `WardenPending` — verdict was `pending` (HIL parked the call).
  Carries `toolName`, `correlationId`. Not emitted by warden-lite
  today; full edition only.
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
  "id":      "<Anthropic tool_use id>"
}
```

The Anthropic tool_use id (`toolu_*`) round-trips into warden's audit
ledger so a single ledger lookup correlates back to the model's
exact call. See [`warden-lite/src/proxy.rs`](https://github.com/vanteguardlabs/warden-lite/blob/main/src/proxy.rs)
for the server side.

## Develop

```sh
pnpm install
pnpm build       # tsup → dist/{index.mjs, index.cjs, index.d.ts}
pnpm test        # vitest, 32 unit tests
pnpm typecheck   # tsc --noEmit
pnpm demo        # full e2e against local warden-lite
```

End-to-end tests (5 cases against live warden-lite) skip unless
`WARDEN_E2E_ENDPOINT` is set:

```sh
WARDEN_E2E_ENDPOINT=http://localhost:8088 WARDEN_E2E_TOKEN=... pnpm test
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
