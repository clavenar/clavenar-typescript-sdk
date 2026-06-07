# Native Anthropic + Clavenar

Mirrors the `native-openai` recipe but against the Anthropic SDK.
`clavenarWrap` detects the client shape automatically; the same wrapper
function handles either provider.

## Run it

```bash
npm install @anthropic-ai/sdk @clavenar/agent-sdk
ANTHROPIC_API_KEY=sk-ant-... node --import tsx run.ts
```

Same three outcomes as `examples/demo/`:

- Green — model emits an allowed tool_use; clavenar returns the
  response untouched.
- Red — policy denies; `ClavenarDenied` is thrown with the rejection
  reasons in `e.reasons`.
- Yellow — policy parks for review; `ClavenarPending` is thrown.
  `await e.resolve()` blocks until an operator decides
  (via `clavenarctl pending decide` or the console).
