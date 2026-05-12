# Native Anthropic + Agent Warden

Mirrors the `native-openai` recipe but against the Anthropic SDK.
`wardenWrap` detects the client shape automatically; the same wrapper
function handles either provider.

## Run it

```bash
npm install @anthropic-ai/sdk @vanteguardlabs/warden-ai-sdk
ANTHROPIC_API_KEY=sk-ant-... node --import tsx run.ts
```

Same three outcomes as `examples/demo/`:

- Green — model emits an allowed tool_use; warden returns the
  response untouched.
- Red — policy denies; `WardenDenied` is thrown with the rejection
  reasons in `e.reasons`.
- Yellow — policy parks for review; `WardenPending` is thrown.
  `await e.resolve()` blocks until an operator decides
  (via `wardenctl pending decide` or the console).
