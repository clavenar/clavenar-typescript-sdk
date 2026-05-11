# @warden/ai-sdk

TypeScript SDK for [Agent Warden](https://warden.vanteguardlabs.com).
Wraps your Anthropic / OpenAI client; every `tool_use` block is
inspected by warden-lite before your code sees it.

```ts
import Anthropic from '@anthropic-ai/sdk';
import { wardenWrap } from '@warden/ai-sdk';

const client = wardenWrap(new Anthropic(), {
  endpoint: 'http://localhost:8088',  // warden-lite ingress
  token: process.env.WARDEN_LITE_TOKEN,
});

const msg = await client.messages.create({
  model: 'claude-opus-4-7',
  max_tokens: 1024,
  tools: [/* your tool schemas */],
  messages: [{ role: 'user', content: 'delete the alice user' }],
});
// If the model emits a tool_use that warden denies, this call throws
// `WardenDenied` — your existing tool-execution loop never sees the block.
```

## Status

Week 1 skeleton. `wardenWrap` validates options and returns the
client untouched today. Real interception lands by end of week per
the workspace roadmap.

## Wire shape

The SDK speaks the warden-lite `POST /mcp` contract (JSON-RPC 2.0,
optional `Authorization: Bearer <token>`). One inspection per
`tool_use` block in the model's response. See
`warden-lite/src/proxy.rs` for the server side.

## Build

```sh
pnpm install
pnpm build       # tsup → dist/{index.mjs, index.cjs, index.d.ts}
pnpm test
pnpm typecheck
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
