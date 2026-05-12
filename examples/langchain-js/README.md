# LangChain.js + Agent Warden

Recipe for LangChain JS agents using OpenAI or Anthropic underneath.
LangChain wraps a model client and dispatches tool calls through its
own `RunnableSequence` / `AgentExecutor`. Warden sits at the tool
dispatch boundary — every tool the model emits is inspected before
LangChain runs your `tool.func`.

## The pattern

Two equally-valid integration shapes:

1. **`DynamicTool` with a wrapped `func`.** Each LangChain tool's
   `func` field gets a warden inspect call as the first line.
   Throws on deny, blocks on pending. This recipe shows the shape.
2. **`AgentExecutor` callbacks.** LangChain's `onToolStart`
   callback fires before the tool runs; route it through warden and
   abort the chain on a deny. Slightly more bookkeeping but doesn't
   require modifying every tool definition.

## Run it

```bash
npm install langchain @langchain/core @vanteguardlabs/warden-ai-sdk
node --import tsx run.ts
```

Python equivalent (using `warden-ai`): see
`warden-ai-py/examples/langchain.py`.
