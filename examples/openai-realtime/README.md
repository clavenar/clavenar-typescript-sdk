# OpenAI Realtime + Agent Warden

The Realtime API is websocket-based — there's no `client.method()` for
`wardenWrap` to intercept. Instead, drain the WS event stream and run
each `response.function_call_arguments.done` event through
`inspectRealtimeFunctionCall` before dispatching the tool handler.

## Run it

```bash
npm install ws @vanteguardlabs/warden-ai-sdk
node --import tsx run.ts
```

## Three outcomes

- **Allow** — `inspectRealtimeFunctionCall` returns `{ kind: 'allow' }`;
  dispatch the tool handler and reply via
  `conversation.item.create` with a `function_call_output` item.
- **Deny** — `{ kind: 'deny', payload }`; reply with a
  `function_call_output` whose `output` is a deny notice. The model
  will see the deny reasons and pick another action.
- **Pending** — `{ kind: 'pending', correlationId, reviewReasons }`;
  either block the WS pump on a `wardenctl pending wait` style poll,
  or send a placeholder `function_call_output` and reconcile when
  the operator decides. Both shapes are valid; pick the one that
  fits your latency budget.

## What the SDK gives you

- `isRealtimeFunctionCallDone(evt)` — type guard for the terminal
  arg event (skip deltas + unrelated events).
- `normalizeRealtimeFunctionCall(evt)` — parses the JSON-encoded
  `arguments` string into `NormalizedToolCall`.
- `inspectRealtimeFunctionCall(evt, opts)` — convenience wrapper
  around `inspectToolUse(normalizeRealtimeFunctionCall(evt), opts)`.

## See also

- `examples/native-openai/` — the same warden gate against the chat
  completions API (wrap-the-client pattern).
- `examples/vercel-ai/` — generic per-call inspect against any tool
  dispatcher.
