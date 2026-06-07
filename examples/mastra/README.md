# Mastra + Clavenar

Recipe for [Mastra](https://mastra.ai) agents. Mastra agents are
typed wrappers over a model client; clavenar plugs in at the
tool-dispatch layer, the same boundary as Vercel AI SDK.

## The pattern

Mastra agents are constructed with a `model` (an `ai-sdk`
LanguageModel) and a `tools` map. When the agent calls a tool, you
have two places to add clavenar:

1. **Wrap the model client.** If you constructed your model via
   `anthropic({ apiKey: ... })` or similar, you can `clavenarWrap` the
   underlying Anthropic SDK *before* passing it to Mastra. This
   requires Mastra to expose the raw client, which the current
   versions of the provider packages do via `provider.client`.
2. **Wrap the tool dispatcher.** Mastra accepts a custom
   `toolChoice` resolver and a per-tool `execute` function — wrap
   each `execute` in a clavenar inspect call so any tool the agent
   tries to run is policy-gated.

`run.ts` shows pattern (2): a Mastra-shaped tool registration where
each `execute` consults clavenar before doing real work. This pattern
is framework-agnostic — it works the same way for Vercel AI SDK,
LangChain, or Mastra.

## Run it

```bash
npm install @mastra/core @clavenar/agent-sdk
node --import tsx run.ts
```

The stubbed Mastra agent here doesn't actually call an LLM — the
example is about the tool-gate boundary, not the agent loop.
