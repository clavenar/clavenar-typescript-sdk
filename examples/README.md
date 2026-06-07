# `@clavenar/agent-sdk` examples

Recipes that show how to drop clavenar into the canonical agent
frameworks. Each subdirectory is self-contained: a `run.ts` you can
execute against a running `clavenar-lite`, and a `README.md` that
points at the load-bearing pattern in 30 seconds.

| Directory | What it demonstrates |
|---|---|
| [`demo/`](./demo) | Full three-tier walkthrough (green / red / yellow) with a mocked Anthropic client. Recorded as `demo.gif`. |
| [`native-anthropic/`](./native-anthropic) | Wrap an `@anthropic-ai/sdk` client directly with `clavenarWrap`. Canonical minimal pattern. |
| [`native-openai/`](./native-openai) | Same shape against the `openai` SDK's `chat.completions.create`. |
| [`vercel-ai/`](./vercel-ai) | Intercept Vercel AI SDK's `toolCalls` array via `inspectToolUse` before dispatching. |
| [`mastra/`](./mastra) | `withClavenarGate(name, execute)` helper that wraps any Mastra tool's `execute` function. |
| [`langchain-js/`](./langchain-js) | `clavenarTool(name, description, func)` factory for LangChain DynamicTool registration. |
| [`anthropic-computer-use/`](./anthropic-computer-use) | Wrap an Anthropic client that uses `computer` / `bash` / `str_replace_editor` tools. Same `clavenarWrap` pattern; the policy snippet shows how to gate destructive actions. |
| [`openai-realtime/`](./openai-realtime) | Inspect tool calls a Realtime websocket emits. `isRealtimeFunctionCallDone` + `inspectRealtimeFunctionCall` plug into your WS message pump. |

Python equivalents (using
[`clavenar-agent-sdk`](https://pypi.org/project/clavenar-agent-sdk) instead of this
TypeScript SDK) live in
[`clavenar-python-sdk/examples/`](../../clavenar-python-sdk/examples):

- `basic_anthropic.py`, `sync_openai.py`, `streaming_anthropic.py`
- `langchain_recipe.py`
- `llamaindex_recipe.py`

## The integration spectrum

Every recipe ends up at the same end state: clavenar inspects every
tool call before your handler runs. They differ in where the wrap
goes:

1. **Wrap the model client** (`native-anthropic`, `native-openai`,
   `examples/demo/`). One line at boot; everything downstream is
   automatic. Best fit when you control the client construction.
2. **Wrap the tool dispatcher** (`vercel-ai`, `mastra`, `langchain-js`).
   Use `inspectToolUse` per-call inside the framework's tool execute
   boundary. Best fit when the framework owns the model call and you
   only see post-generation tool dispatch.

The wire contract (`POST /mcp` to `clavenar-lite`) is identical in
both shapes — the SDK chooses the integration point based on what
the framework exposes.
