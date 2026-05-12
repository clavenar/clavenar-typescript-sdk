# `@vanteguardlabs/warden-ai-sdk` examples

Recipes that show how to drop warden into the canonical agent
frameworks. Each subdirectory is self-contained: a `run.ts` you can
execute against a running `warden-lite`, and a `README.md` that
points at the load-bearing pattern in 30 seconds.

| Directory | What it demonstrates |
|---|---|
| [`demo/`](./demo) | Full three-tier walkthrough (green / red / yellow) with a mocked Anthropic client. Recorded as `demo.gif`. |
| [`native-anthropic/`](./native-anthropic) | Wrap an `@anthropic-ai/sdk` client directly with `wardenWrap`. Canonical minimal pattern. |
| [`native-openai/`](./native-openai) | Same shape against the `openai` SDK's `chat.completions.create`. |
| [`vercel-ai/`](./vercel-ai) | Intercept Vercel AI SDK's `toolCalls` array via `inspectToolUse` before dispatching. |
| [`mastra/`](./mastra) | `withWardenGate(name, execute)` helper that wraps any Mastra tool's `execute` function. |
| [`langchain-js/`](./langchain-js) | `wardenTool(name, description, func)` factory for LangChain DynamicTool registration. |
| [`anthropic-computer-use/`](./anthropic-computer-use) | Wrap an Anthropic client that uses `computer` / `bash` / `str_replace_editor` tools. Same `wardenWrap` pattern; the policy snippet shows how to gate destructive actions. |
| [`openai-realtime/`](./openai-realtime) | Inspect tool calls a Realtime websocket emits. `isRealtimeFunctionCallDone` + `inspectRealtimeFunctionCall` plug into your WS message pump. |

Python equivalents (using
[`warden-ai`](https://pypi.org/project/warden-ai) instead of this
TypeScript SDK) live in
[`warden-ai-py/examples/`](../../warden-ai-py/examples):

- `basic_anthropic.py`, `sync_openai.py`, `streaming_anthropic.py`
- `langchain_recipe.py`
- `llamaindex_recipe.py`

## The integration spectrum

Every recipe ends up at the same end state: warden inspects every
tool call before your handler runs. They differ in where the wrap
goes:

1. **Wrap the model client** (`native-anthropic`, `native-openai`,
   `examples/demo/`). One line at boot; everything downstream is
   automatic. Best fit when you control the client construction.
2. **Wrap the tool dispatcher** (`vercel-ai`, `mastra`, `langchain-js`).
   Use `inspectToolUse` per-call inside the framework's tool execute
   boundary. Best fit when the framework owns the model call and you
   only see post-generation tool dispatch.

The wire contract (`POST /mcp` to `warden-lite`) is identical in
both shapes — the SDK chooses the integration point based on what
the framework exposes.
