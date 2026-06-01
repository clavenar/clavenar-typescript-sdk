# Native OpenAI + Clavenar

The simplest possible integration: wrap an `openai.OpenAI` (or
`AsyncOpenAI` in Python) client directly with `clavenarWrap`, then
use it everywhere you would have used the unwrapped client. No
framework, no glue layer.

## The pattern

`clavenarWrap(client, options)` returns a proxy of the same shape as
the input client. Method calls flow through normally; on
`client.chat.completions.create` the wrapper intercepts the
returned `tool_calls`, inspects each one against clavenar, and either
returns the response, throws `ClavenarDenied`, or throws
`ClavenarPending` (whose `.resolve()` waits for an operator).

This is the canonical wrap pattern — every other recipe in this
directory is a variation on it.

## Run it

```bash
npm install openai @vanteguardlabs/clavenar-ai-sdk
OPENAI_API_KEY=sk-... node --import tsx run.ts
```

The example uses a tool definition you can plug an existing OpenAI
function-calling workflow into. To test the deny path, ship a Rego
rule that denies one of your tool names; the recipe will surface
`ClavenarDenied`.
