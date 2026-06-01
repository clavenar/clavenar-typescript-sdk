# clavenar-ai-sdk sequence diagrams

Five sequence diagrams cover the wire-level paths the SDK can take:
`clavenarWrap` boot + structural client detection, the non-streaming
inspection of an Anthropic response (the OpenAI Chat path is the same
shape against `chat.completions.create`), the streaming OpenAI Chat
choice-end gate (Anthropic's `content_block_stop` parallels it), the
`ClavenarPending.resolve` polling loop, and the standalone
`inspectRealtimeFunctionCall` helper for the OpenAI Realtime WS
surface. A request decision-tree flowchart closes the file.

The SDK is a transparent client of `clavenar-lite`'s `POST /mcp` +
`GET /pending/{id}` surface — the diagrams treat the partner's model
client, `clavenar-lite`, the agent's tool loop, and (for Realtime) the
WS handler as the cross-process boundaries.

## 1. `clavenarWrap` — boot, validate, detect, install nested Proxies

`clavenarWrap` runs once per client. It validates the option bag,
walks the client structurally to pick a provider shape (Anthropic if
`messages.create` exists, OpenAI Chat if `chat.completions.create`
exists), then installs nested `Proxy` handlers so only `create` is
intercepted — every other property (`client.beta`, `client.models`,
custom subclasses) passes through `Reflect.get` unchanged.

```mermaid
sequenceDiagram
    autonumber
    participant Caller as Partner code
    participant Wrap as clavenarWrap
    participant V as validateOptions
    participant D as detectClient
    participant Outer as new Proxy(client)
    participant Inner as new Proxy(client.messages | client.chat.completions)

    Caller->>Wrap: clavenarWrap(client, { endpoint, token?, mode?, timeoutMs?, onVerdict?, onPolicyError?, fetch?, retry? })
    Wrap->>V: validateOptions(opts)
    V->>V: opts.endpoint is non-empty string AND new URL(opts.endpoint) succeeds
    V->>V: opts.timeoutMs is positive finite (if set)
    V->>V: opts.mode is 'enforce' or 'observe' (if set)
    alt any check fails
        V-->>Caller: throw ClavenarConfigError
    end
    Wrap->>D: detectClient(client)
    alt client.messages.create is function
        D-->>Wrap: 'anthropic'
        Wrap->>Inner: Proxy(client.messages, { get prop -> intercept 'create' only })
        Wrap->>Outer: Proxy(client, { get prop -> return messagesProxy for 'messages' })
    else client.chat.completions.create is function
        D-->>Wrap: 'openai-chat'
        Wrap->>Inner: Proxy(client.chat.completions, { get prop -> intercept 'create' only })
        Wrap->>Wrap: chatProxy = Proxy(client.chat, get -> completionsProxy)
        Wrap->>Outer: Proxy(client, get -> chatProxy for 'chat')
    else neither
        D-->>Caller: throw ClavenarConfigError — client must expose messages.create or chat.completions.create
    end
    Outer-->>Caller: wrapped client (same type as input via overload)
    Note over Caller,Outer: every Reflect.get for any other prop passes the original through<br/>opts is captured in the Proxy closures and consulted on every create()
```

## 2. Non-streaming Anthropic — extract tool_use, inspect in parallel, throw in order

When the partner awaits `wrapped.messages.create({...})`, the
intercepted `create` calls upstream, walks `content[]` for
`tool_use` blocks, normalises them, and `Promise.all`s an
`inspectToolUse` per call. Verdicts are then consumed in submission
order — the first deny / pending in `calls[]` is the one that
throws, not the first to come back over the wire — so two parallel
denies always produce the same `ClavenarDenied.toolName` deterministically.

```mermaid
sequenceDiagram
    autonumber
    participant Caller as Partner code
    participant Inner as messagesProxy
    participant Upstream as client.messages.create (real)
    participant Anth as api.anthropic.com
    participant Insp as inspectAllToolCalls
    participant T as inspectToolUse (per call)
    participant L as clavenar-lite POST /mcp

    Caller->>Inner: wrapped.messages.create({ model, tools, messages, ... })
    Inner->>Upstream: Reflect.apply(target.create, args)
    Upstream->>Anth: POST /v1/messages
    Anth-->>Upstream: AnthropicMessage { content: [text, tool_use, tool_use, ...] }
    Upstream-->>Inner: response
    Inner->>Inner: isAsyncIterable(response) — false, take non-streaming branch
    Inner->>Inner: extractAnthropicCalls — filter isToolUseBlock, map to NormalizedToolCall { id, name, input }
    Inner->>Insp: inspectAllToolCalls(calls, opts)
    par parallel inspect every tool_use
        Insp->>T: inspectToolUse(call_1, opts)
        T->>T: build JSON-RPC envelope { jsonrpc: 2.0, method: tools/call, params: { name, arguments: input }, id: call.id }
        T->>T: AbortController + timeoutMs (default 10s)
        T->>L: POST {endpoint}/mcp + Content-Type + (Bearer token if set)
        L-->>T: 200 (allow) OR 403 (deny + body) OR 202 (pending + body) OR 5xx
        T->>T: read X-Clavenar-Correlation-Id header
        alt 200
            T-->>Insp: { kind: 'allow', correlationId? }
        else 403
            T->>T: parseDenyBody — { error: security_violation, reasons, review_reasons, intent_category }
            T-->>Insp: { kind: 'deny', payload, correlationId? }
        else 202
            T->>T: parsePendingBody — { status: pending, correlation_id, review_reasons }
            T->>T: corr = header ?? body.correlation_id (else throw ClavenarTransportError 202)
            T-->>Insp: { kind: 'pending', correlationId, reviewReasons }
        else 5xx / network / abort
            T->>T: retry up to maxAttempts with jittered exponential backoff
            T-->>Insp: throw ClavenarTransportError on terminal failure (enforce) OR catch (observe)
        end
        Insp->>T: inspectToolUse(call_2, opts)
        T-->>Insp: verdict_2
    and
        Note over Insp: results gathered as Promise.all settles
    end
    loop verdicts in submission order calls[i]
        opt opts.onVerdict
            Insp->>Caller: await onVerdict(verdict, { toolName, toolUseId, toolInput })
        end
        alt enforce mode AND verdict.kind == 'deny'
            Insp-->>Caller: throw ClavenarDenied { toolName, reasons, reviewReasons, intentCategory, correlationId }
        else enforce AND verdict.kind == 'pending'
            Insp-->>Caller: throw ClavenarPending { toolName, correlationId, reviewReasons, pollOnce closure }
        else
            Insp->>Insp: continue (allow OR observe mode)
        end
    end
    Inner-->>Caller: AnthropicMessage (only reached if no enforce-mode throw fired)
```

## 3. Streaming OpenAI Chat — hold `finish_reason: tool_calls` until inspection clears

The wrapper is an async generator that mirrors upstream chunks
one-for-one and accumulates `tool_calls` arguments per
`choiceIndex:toolIndex`. When a chunk's `choice.finish_reason ==
'tool_calls'` arrives the wrapper inspects every accumulated call in
that choice — concurrently via `Promise.all` — and then yields the
finishing chunk. A deny in enforce mode throws *before* the partner
sees `finish_reason: 'tool_calls'`, so the upstream tool-execution
loop is never triggered for the blocked call.

```mermaid
sequenceDiagram
    autonumber
    participant Caller as Partner code (for await)
    participant Gen as wrapOpenAIChatStream
    participant Up as upstream chunk iterator
    participant Acc as accumulate (bufs Map)
    participant Drain as drainChoice
    participant Batch as inspectChoiceBatch
    participant T as inspectToolUse
    participant L as clavenar-lite POST /mcp

    Caller->>Gen: for await (chunk of wrapped.chat.completions.create({stream:true, ...}))
    loop every upstream chunk
        Gen->>Up: next chunk
        Up-->>Gen: OpenAIChatCompletionChunk { choices: [...] }
        loop every choice in chunk.choices
            alt choice.delta.tool_calls is Array
                Gen->>Acc: for each delta — bufs[choice.index:delta.index] += { id, name?, arguments delta }
            end
            alt choice.finish_reason == 'tool_calls'
                Gen->>Gen: choicesToInspect.push(choice.index)
            end
        end
        loop every choiceIdx queued for inspection (BEFORE yielding the chunk)
            Gen->>Drain: drainChoice(bufs, choiceIdx)
            Drain->>Drain: collect every key with prefix 'choiceIdx:' — JSON.parse(argsBuf) — error -> throw ClavenarConfigError unparseable arguments
            Drain-->>Gen: NormalizedToolCall[]
            Gen->>Batch: inspectChoiceBatch(calls, opts, enforce)
            par parallel inspect every tool call in the choice
                Batch->>T: inspectToolUse(call, opts)
                T->>L: POST /mcp (same envelope as Sec 2)
                L-->>T: 200 OR 403 OR 202 OR 5xx
                T-->>Batch: ClavenarVerdict OR throw
            end
            loop verdicts in submission order
                opt opts.onVerdict
                    Batch->>Caller: await onVerdict(verdict, ctx)
                end
                alt observe mode AND inspectToolUse threw ClavenarTransportError
                    Batch->>Caller: await onPolicyError(e, ctx) — continue (response passes through)
                else enforce AND deny
                    Batch-->>Caller: throw ClavenarDenied — chunk never yielded, partner never sees finish_reason
                else enforce AND pending
                    Batch-->>Caller: throw ClavenarPending — same — closure carries pollOnce
                else
                    Batch->>Batch: continue
                end
            end
        end
        Gen-->>Caller: yield chunk (only reached if no enforce throw fired)
    end
    Note over Gen,Caller: Anthropic content_block_stop path is parallel — same accumulate-then-inspect-before-yield logic —<br/>see wrapAnthropicStream in src/stream.ts
```

## 4. `ClavenarPending.resolve` — poll until decided, terminal vs transient errors

When enforce mode throws `ClavenarPending`, the partner catches it,
runs whatever side-work makes sense during the wait, then calls
`await pending.resolve(...)`. `resolve` polls
`GET /pending/{correlationId}` every `pollIntervalMs` (default 2s)
until the operator decides or the wall-clock deadline (default 10
min) trips. Terminal transport failures (401, 404) re-throw
immediately; transient ones (5xx, network blips) are swallowed
between polls.

```mermaid
sequenceDiagram
    autonumber
    participant Partner as Partner try/catch
    participant Pending as ClavenarPending.resolve
    participant Poll as pollPendingOnce (closure captured at throw time)
    participant L as clavenar-lite GET /pending/{id}

    Note over Partner: Sec 2 or Sec 3 threw ClavenarPending — partner caught it
    Partner->>Pending: await pending.resolve({ pollIntervalMs?, timeoutMs? })
    Pending->>Pending: validate intervals positive — compute deadline = Date.now() + timeoutMs
    loop while Date.now() < deadline
        Pending->>Poll: this._pollOnce()
        Poll->>Poll: AbortController + timeoutMs — build Bearer header if opts.token
        Poll->>L: GET /pending/{encodeURIComponent(correlationId)}
        alt 200
            L-->>Poll: ClavenarPendingView { correlation_id, agent_id, tool_type, method, review_reasons, requested_at, decided_at, decision, decider_note }
            Poll-->>Pending: view
            alt view.decision == 'allow'
                Pending-->>Partner: resolve (void)
            else view.decision == 'deny'
                Pending-->>Partner: throw ClavenarDenied { toolName, reasons: [decider_note OR 'operator denied'], reviewReasons, intentCategory: 'PendingDenied', correlationId }
            else view.decision == null
                Pending->>Pending: not decided yet — sleep min(pollIntervalMs, remaining)
            end
        else 401 or 404 (terminal)
            L-->>Poll: status
            Poll-->>Pending: throw ClavenarTransportError(status)
            Pending-->>Partner: re-throw immediately
        else 5xx or network or AbortError (transient)
            L-->>Poll: status / err
            Poll-->>Pending: throw ClavenarTransportError
            Pending->>Pending: swallow — continue loop
        end
    end
    Pending-->>Partner: throw ClavenarTransportError(clavenar pending {id} not decided within {timeoutMs}ms)
    Note over Partner: typical pattern:<br/>catch ClavenarPending → await e.resolve() → retry the original create() now that operator approved
```

## 5. OpenAI Realtime — one-shot `inspectRealtimeFunctionCall`

The Realtime API is websocket-based; there is no client-method shape
for `clavenarWrap` to intercept. Instead the SDK exposes a standalone
helper the partner's WS message pump calls when a
`response.function_call_arguments.done` event arrives. The helper
normalises the event (parsing the JSON-encoded `arguments` string,
falling back to the raw string on parse failure so clavenar can still
inspect the malformed-args attempt) and runs one `inspectToolUse`.

```mermaid
sequenceDiagram
    autonumber
    participant Partner as WS message pump
    participant Helper as inspectRealtimeFunctionCall
    participant Norm as normalizeRealtimeFunctionCall
    participant T as inspectToolUse
    participant L as clavenar-lite POST /mcp
    participant Rt as OpenAI Realtime WS

    Note over Rt,Partner: function calls assemble via:<br/>response.output_item.added — carries call_id + name<br/>then 1..N response.function_call_arguments.delta<br/>then exactly one response.function_call_arguments.done with the full arguments
    Rt-->>Partner: response.function_call_arguments.done { call_id, arguments, name (from earlier added event) }
    Partner->>Partner: isRealtimeFunctionCallDone(evt) — type guard
    Partner->>Helper: inspectRealtimeFunctionCall(evt, opts)
    Helper->>Norm: normalizeRealtimeFunctionCall(evt)
    Norm->>Norm: input = JSON.parse(evt.arguments) — on failure input = evt.arguments (raw string)
    Norm-->>Helper: NormalizedToolCall { id: evt.call_id, name: evt.name, input }
    Helper->>T: inspectToolUse(call, opts)
    T->>L: POST /mcp (same envelope, same retry semantics as Sec 2)
    L-->>T: 200 / 403 / 202 / 5xx
    T-->>Helper: ClavenarVerdict (no throw on deny — caller decides)
    Helper-->>Partner: verdict { kind: 'allow' | 'deny' | 'pending', correlationId?, ... }
    alt verdict.kind == 'deny'
        Partner->>Rt: send { type: 'conversation.item.create', item: { type: 'function_call_output', call_id, output: 'denied: ...' } }
        Partner->>Partner: continue WS pump (skip the tool dispatch)
    else verdict.kind == 'pending'
        Partner->>Partner: surface to operator / hold WS pump / synthesise placeholder output (caller's choice)
    else allow
        Partner->>Partner: dispatch the tool handler normally
    end
```

## 6. Request decision tree (flowchart)

A single `create()` invocation through the wrapped client fans out
across four orthogonal knobs: response shape (sync vs stream),
per-call verdict, enforcement mode, and transport health. The
flowchart captures the final outcomes — pass-through, `ClavenarDenied`,
`ClavenarPending`, `ClavenarTransportError`, or a `ClavenarConfigError`
raised before any of those.

```mermaid
flowchart TD
    Start([wrapped.create args]) --> Cfg{validateOptions OK<br/>+ detectClient OK?}
    Cfg -->|no| Cerr[throw ClavenarConfigError<br/>caller bug — bad endpoint, missing client, etc.]
    Cfg -->|yes| Up[upstream create runs]

    Up --> Shape{isAsyncIterable response?}
    Shape -->|no — Anthropic content or OpenAI Chat completion| Sync[extract NormalizedToolCalls<br/>walk content tool_use OR choices message tool_calls]
    Shape -->|yes — stream| Stream[wrap async generator<br/>accumulate per index<br/>inspect on content_block_stop OR finish_reason tool_calls]

    Sync --> Loop[inspectAllToolCalls — Promise.all per call<br/>then consume in submission order]
    Stream --> Loop

    Loop --> Insp{inspectToolUse outcome}
    Insp -->|transport timeout / 5xx after retries / network| Tport{mode}
    Tport -->|enforce| Te[throw ClavenarTransportError<br/>fail-closed]
    Tport -->|observe| Toe[await onPolicyError if set<br/>continue — treated as allow]

    Insp -->|verdict| Mode{mode}
    Mode -->|observe| Obs[await onVerdict if set<br/>continue]
    Mode -->|enforce| Vk{verdict.kind}
    Vk -->|allow| Ok[await onVerdict if set<br/>continue]
    Vk -->|deny| Dn[await onVerdict if set<br/>throw ClavenarDenied with reasons + intentCategory + correlationId]
    Vk -->|pending| Pn[await onVerdict if set<br/>throw ClavenarPending with closure-bound pollOnce]

    Pn --> Resolve[partner catches<br/>await pending.resolve poll loop]
    Resolve --> Rd{decision}
    Rd -->|allow within deadline| Rok[resolve void<br/>partner re-runs original create]
    Rd -->|deny within deadline| Rdn[throw ClavenarDenied with PendingDenied intent + decider_note]
    Rto[throw ClavenarTransportError — not decided within timeoutMs]
    Rd -->|deadline trip| Rto
    Rd -->|401 or 404 terminal| Rterm[throw ClavenarTransportError immediately]

    Obs --> Pass[response or stream chunks pass through to partner]
    Ok --> Pass
    Toe --> Pass
    Te --> End([throw lands at partner await])
    Dn --> End
    Pn --> End
    Cerr --> End
    Pass --> End
    Rok --> End
    Rdn --> End
    Rto --> End
    Rterm --> End
```
