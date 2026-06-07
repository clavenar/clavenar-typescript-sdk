# Vercel AI SDK + Clavenar

Wrap-pattern recipe for [Vercel AI SDK](https://sdk.vercel.ai)
(`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`). Drop clavenar in front
of the model call so every tool the model emits flows through the
proxy first.

## The pattern

Vercel's `generateText` / `streamText` accept any object that
implements its `LanguageModelV1` interface. Provider packages
(`@ai-sdk/anthropic`, `@ai-sdk/openai`) return one. Clavenar doesn't
replace that — it lives one layer up, intercepting the *resulting*
tool calls before your runtime executes them.

Two integration points:

1. **Tool-handler boundary.** When Vercel returns
   `result.toolCalls`, route each one through clavenar before
   dispatching to your local tool implementation. This is the
   minimum-change path and works with the default `generateText`.
2. **Provider-level wrap.** Construct the provider's underlying
   client (`anthropic.messages.create`), wrap it with `clavenarWrap`,
   then plug the wrapped client back into Vercel's model factory.
   Tighter integration, more code.

`run.ts` shows pattern (1) — operate on the post-generation
`toolCalls` array. Pattern (2) is left as an exercise; the SDK's
`clavenarWrap` works on any object exposing a compatible
`messages.create`.

## Run it

```bash
npm install ai @ai-sdk/anthropic @clavenar/agent-sdk
ANTHROPIC_API_KEY=sk-ant-... node --import tsx run.ts
```

The example uses Anthropic's small + cheap model for tool dispatch.
Tool calls are mocked locally — clavenar's wrap is the only thing
making real HTTP calls here (to the running `clavenar-lite`).
