import { WardenConfigError, WardenDenied, WardenPending } from './errors.js';
import { isToolUseBlock } from './anthropic.js';
import type {
  AnthropicLike,
  AnthropicMessage,
  AnthropicMessageStreamEvent,
} from './anthropic.js';
import {
  isOpenAIChatToolCall,
  normalizeChatToolCall,
} from './openai.js';
import type {
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIChatLike,
  OpenAIChatToolCall,
} from './openai.js';
import { wrapAnthropicStream, wrapOpenAIChatStream } from './stream.js';
import { inspectToolUse } from './transport.js';
import type { NormalizedToolCall, WardenOptions } from './types.js';

/**
 * Wrap an Anthropic-like or OpenAI-like client so every tool call the
 * model emits is inspected by warden before the caller sees it.
 *
 * Detection is structural and runs once at wrap time:
 *
 * - `client.messages.create` → Anthropic. We intercept the response,
 *   walk `content[]` for `tool_use` blocks, normalize them, inspect.
 * - `client.chat.completions.create` → OpenAI. We intercept the
 *   response, walk `choices[].message.tool_calls`, JSON-parse the
 *   `arguments` string, normalize, inspect.
 *
 * Anything else is rejected with {@link WardenConfigError} — we'd
 * rather fail loudly at boot than silently pass a stranger client
 * through unwrapped. Other client properties (`client.beta`,
 * `client.models`, custom subclasses) pass through unchanged via the
 * outer `Proxy`.
 *
 * Behavior is governed by `opts.mode`:
 *
 * - `'enforce'` (default): the first denied tool call aborts the
 *   call with {@link WardenDenied}; a pending verdict aborts with
 *   {@link WardenPending}. The upstream response is discarded. The
 *   `onVerdict` callback fires for that block before the throw, so
 *   observe-mode telemetry stays consistent across both modes.
 *
 * - `'observe'`: no throw. Every verdict is surfaced via
 *   `onVerdict`, the response passes through, and the partner's
 *   existing tool-execution loop runs the denied tool. Use this for
 *   rollouts where you need warden visibility without breaking the
 *   agent.
 */
export function wardenWrap<T extends AnthropicLike>(client: T, opts: WardenOptions): T;
export function wardenWrap<T extends OpenAIChatLike>(client: T, opts: WardenOptions): T;
export function wardenWrap(
  client: AnthropicLike | OpenAIChatLike,
  opts: WardenOptions,
): AnthropicLike | OpenAIChatLike {
  validateOptions(opts);
  const kind = detectClient(client);
  if (kind === 'anthropic') return wrapAnthropic(client as AnthropicLike, opts);
  return wrapOpenAIChat(client as OpenAIChatLike, opts);
}

type ClientKind = 'anthropic' | 'openai-chat';

function detectClient(client: unknown): ClientKind {
  if (!client || typeof client !== 'object') {
    throw new WardenConfigError('wardenWrap: client must be an object');
  }
  const c = client as Record<string, unknown>;
  const anthropicCreate = (c['messages'] as { create?: unknown } | undefined)?.create;
  if (typeof anthropicCreate === 'function') return 'anthropic';
  const openaiCreate = (
    (c['chat'] as { completions?: { create?: unknown } } | undefined)?.completions
  )?.create;
  if (typeof openaiCreate === 'function') return 'openai-chat';
  throw new WardenConfigError(
    'wardenWrap: client must expose messages.create() (Anthropic) or chat.completions.create() (OpenAI)',
  );
}

function wrapAnthropic(client: AnthropicLike, opts: WardenOptions): AnthropicLike {
  const messagesProxy = new Proxy(client.messages, {
    get(target, prop, receiver) {
      if (prop !== 'create') return Reflect.get(target, prop, receiver);
      return async (...args: unknown[]): Promise<AnthropicMessage | AsyncIterable<AnthropicMessageStreamEvent>> => {
        const result = await Reflect.apply(target.create, target, args);
        if (isAsyncIterable(result)) {
          return wrapAnthropicStream(result as AsyncIterable<AnthropicMessageStreamEvent>, opts);
        }
        const calls = extractAnthropicCalls(result as AnthropicMessage);
        await inspectAllToolCalls(calls, opts);
        return result as AnthropicMessage;
      };
    },
  });
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'messages') return messagesProxy;
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapOpenAIChat(client: OpenAIChatLike, opts: WardenOptions): OpenAIChatLike {
  const completionsProxy = new Proxy(client.chat.completions, {
    get(target, prop, receiver) {
      if (prop !== 'create') return Reflect.get(target, prop, receiver);
      return async (...args: unknown[]): Promise<OpenAIChatCompletion | AsyncIterable<OpenAIChatCompletionChunk>> => {
        const result = await Reflect.apply(target.create, target, args);
        if (isAsyncIterable(result)) {
          return wrapOpenAIChatStream(result as AsyncIterable<OpenAIChatCompletionChunk>, opts);
        }
        const calls = extractOpenAIChatCalls(result as OpenAIChatCompletion);
        await inspectAllToolCalls(calls, opts);
        return result as OpenAIChatCompletion;
      };
    },
  });
  const chatProxy = new Proxy(client.chat, {
    get(target, prop, receiver) {
      if (prop === 'completions') return completionsProxy;
      return Reflect.get(target, prop, receiver);
    },
  });
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'chat') return chatProxy;
      return Reflect.get(target, prop, receiver);
    },
  });
}

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    Symbol.asyncIterator in (v as object) &&
    typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

function extractAnthropicCalls(result: AnthropicMessage): NormalizedToolCall[] {
  const content = result.content ?? [];
  return content.filter(isToolUseBlock).map((b) => ({
    id: b.id,
    name: b.name,
    input: b.input,
  }));
}

function extractOpenAIChatCalls(result: OpenAIChatCompletion): NormalizedToolCall[] {
  const choices = result.choices ?? [];
  const out: NormalizedToolCall[] = [];
  for (const choice of choices) {
    const calls = choice.message?.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls as OpenAIChatToolCall[]) {
      if (!isOpenAIChatToolCall(call)) continue;
      out.push(normalizeChatToolCall(call));
    }
  }
  return out;
}

/**
 * Inspect every normalized tool call concurrently, fire the verdict
 * callback in submission order, and (in enforce mode) throw on the
 * first deny/pending.
 *
 * Calls are kicked off in parallel via `Promise.all` so a turn with
 * three tool_uses doesn't serialize three warden round-trips. The
 * `for` loop that consumes the results still preserves submission
 * order — the first deny in `calls[]` is the one that throws, not
 * the first deny to come back over the wire. A single transient
 * transport error rejects the whole batch (Promise.all semantics);
 * the surviving verdicts go to the ledger but don't surface to the
 * caller, which is fine because we're aborting the turn anyway.
 */
async function inspectAllToolCalls(
  calls: NormalizedToolCall[],
  opts: WardenOptions,
): Promise<void> {
  const enforce = (opts.mode ?? 'enforce') === 'enforce';
  if (calls.length === 0) return;
  const verdicts = await Promise.all(calls.map((c) => inspectToolUse(c, opts)));
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    const verdict = verdicts[i]!;
    if (opts.onVerdict) {
      await opts.onVerdict(verdict, {
        toolName: call.name,
        toolUseId: call.id,
        toolInput: call.input,
      });
    }
    if (!enforce) continue;
    if (verdict.kind === 'deny') {
      throw new WardenDenied({
        toolName: call.name,
        reasons: verdict.payload.reasons,
        reviewReasons: verdict.payload.review_reasons,
        intentCategory: verdict.payload.intent_category,
        ...(verdict.correlationId !== undefined && { correlationId: verdict.correlationId }),
      });
    }
    if (verdict.kind === 'pending') {
      throw new WardenPending({
        toolName: call.name,
        correlationId: verdict.correlationId,
      });
    }
  }
}

function validateOptions(opts: WardenOptions): void {
  if (!opts || typeof opts.endpoint !== 'string' || opts.endpoint.length === 0) {
    throw new WardenConfigError('wardenWrap: opts.endpoint is required');
  }
  try {
    new URL(opts.endpoint);
  } catch {
    throw new WardenConfigError(`wardenWrap: opts.endpoint is not a valid URL: ${opts.endpoint}`);
  }
  if (opts.timeoutMs !== undefined && (opts.timeoutMs <= 0 || !Number.isFinite(opts.timeoutMs))) {
    throw new WardenConfigError('wardenWrap: opts.timeoutMs must be a positive finite number');
  }
  if (opts.mode !== undefined && opts.mode !== 'enforce' && opts.mode !== 'observe') {
    throw new WardenConfigError(`wardenWrap: opts.mode must be 'enforce' or 'observe' (got '${opts.mode}')`);
  }
}
