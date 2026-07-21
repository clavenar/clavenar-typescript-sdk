import {
  ClavenarConfigError,
  ClavenarDenied,
  ClavenarPending,
  ClavenarRateLimited,
  ClavenarTransportError,
} from './errors.js';
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
import { inspectToolUses, pollPendingOnce } from './transport.js';
import { emitDenyPanel } from './devmode.js';
import type { NormalizedToolCall, ClavenarOptions } from './types.js';

/**
 * Wrap an Anthropic-like or OpenAI-like client so every tool call the
 * model emits is inspected by clavenar before the caller sees it.
 *
 * Detection is structural and runs once at wrap time:
 *
 * - `client.messages.create` → Anthropic. We intercept the response,
 *   walk `content[]` for `tool_use` blocks, normalize them, inspect.
 * - `client.chat.completions.create` → OpenAI. We intercept the
 *   response, walk `choices[].message.tool_calls`, JSON-parse the
 *   `arguments` string, normalize, inspect.
 *
 * Anything else is rejected with {@link ClavenarConfigError} — we'd
 * rather fail loudly at boot than silently pass a stranger client
 * through unwrapped. Other client properties (`client.beta`,
 * `client.models`, custom subclasses) pass through unchanged via the
 * outer `Proxy`.
 *
 * Behavior is governed by `opts.mode`:
 *
 * - `'enforce'` (default): the first denied tool call aborts the
 *   call with {@link ClavenarDenied}; a pending verdict aborts with
 *   {@link ClavenarPending}. The upstream response is discarded. The
 *   `onVerdict` callback fires for that block before the throw, so
 *   observe-mode telemetry stays consistent across both modes.
 *
 * - `'observe'`: no throw. Every verdict is surfaced via
 *   `onVerdict`, the response passes through, and the partner's
 *   existing tool-execution loop runs the denied tool. Use this for
 *   rollouts where you need clavenar visibility without breaking the
 *   agent.
 */
export function clavenarWrap<T extends AnthropicLike>(client: T, opts: ClavenarOptions): T;
export function clavenarWrap<T extends OpenAIChatLike>(client: T, opts: ClavenarOptions): T;
export function clavenarWrap(
  client: AnthropicLike | OpenAIChatLike,
  opts: ClavenarOptions,
): AnthropicLike | OpenAIChatLike {
  validateOptions(opts);
  const kind = detectClient(client);
  if (kind === 'anthropic') return wrapAnthropic(client as AnthropicLike, opts);
  return wrapOpenAIChat(client as OpenAIChatLike, opts);
}

type ClientKind = 'anthropic' | 'openai-chat';

function detectClient(client: unknown): ClientKind {
  if (!client || typeof client !== 'object') {
    throw new ClavenarConfigError('clavenarWrap: client must be an object');
  }
  const c = client as Record<string, unknown>;
  const anthropicCreate = (c['messages'] as { create?: unknown } | undefined)?.create;
  if (typeof anthropicCreate === 'function') return 'anthropic';
  const openaiCreate = (
    (c['chat'] as { completions?: { create?: unknown } } | undefined)?.completions
  )?.create;
  if (typeof openaiCreate === 'function') return 'openai-chat';
  throw new ClavenarConfigError(
    'clavenarWrap: client must expose messages.create() (Anthropic) or chat.completions.create() (OpenAI)',
  );
}

/** Refuse the un-wrappable `.stream()` helpers loudly instead of
 * letting tool calls slip past inspection (the SDK's whole value is
 * "every tool call inspected"). `create({ stream: true })` is the
 * inspected path; `allowUninspectedStream: true` is the explicit,
 * dangerous opt-out. */
function uninspectedStreamGuard(helper: string, opts: ClavenarOptions): unknown | null {
  if (opts.allowUninspectedStream) return null;
  return (): never => {
    throw new ClavenarConfigError(
      `clavenarWrap: ${helper} bypasses clavenar inspection and is blocked. ` +
        `Use create({ stream: true }) (inspected), or set allowUninspectedStream: true ` +
        `to explicitly accept uninspected streaming.`,
    );
  };
}

function wrapAnthropic(client: AnthropicLike, opts: ClavenarOptions): AnthropicLike {
  const messagesProxy = new Proxy(client.messages, {
    get(target, prop, receiver) {
      if (prop === 'stream') {
        const guard = uninspectedStreamGuard('messages.stream()', opts);
        if (guard) return guard;
      }
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

function wrapOpenAIChat(client: OpenAIChatLike, opts: ClavenarOptions): OpenAIChatLike {
  const completionsProxy = new Proxy(client.chat.completions, {
    get(target, prop, receiver) {
      if (prop === 'stream') {
        const guard = uninspectedStreamGuard('chat.completions.stream()', opts);
        if (guard) return guard;
      }
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
 * Decide a complete ordered sibling set atomically, then fire callbacks in
 * submission order. No sibling gets an independent allow before the whole
 * turn clears policy.
 */
async function inspectAllToolCalls(
  calls: NormalizedToolCall[],
  opts: ClavenarOptions,
): Promise<void> {
  const enforce = (opts.mode ?? 'enforce') === 'enforce';
  if (calls.length === 0) return;
  let verdict;
  try {
    verdict = await inspectToolUses(calls, opts);
  } catch (e) {
    if (!enforce && e instanceof ClavenarTransportError) {
      for (const call of calls) {
        if (opts.onPolicyError) {
          await opts.onPolicyError(e, {
            toolName: call.name,
            toolUseId: call.id,
            toolInput: call.input,
          });
        }
      }
      return;
    }
    throw e;
  }
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    const ctx = {
      toolName: call.name,
      toolUseId: call.id,
      toolInput: call.input,
    };
    if (opts.onVerdict) {
      await opts.onVerdict(verdict, ctx);
    }
    if (!enforce) continue;
    if (verdict.kind === 'deny') {
      const denied = new ClavenarDenied({
        toolName: call.name,
        reasons: verdict.payload.reasons,
        reviewReasons: verdict.payload.review_reasons,
        intentCategory: verdict.payload.intent_category,
        ...(verdict.payload.layer !== undefined && { layer: verdict.payload.layer }),
        ...(verdict.correlationId !== undefined && { correlationId: verdict.correlationId }),
        ...(verdict.payload.detail !== undefined && { detail: verdict.payload.detail }),
      });
      if (opts.devMode) emitDenyPanel(denied);
      throw denied;
    }
    if (verdict.kind === 'pending') {
      throw new ClavenarPending({
        toolName: call.name,
        correlationId: verdict.correlationId,
        reviewReasons: verdict.reviewReasons,
        pollOnce: () => pollPendingOnce(verdict.correlationId, opts),
      });
    }
    if (verdict.kind === 'rate_limited') {
      throw new ClavenarRateLimited({
        toolName: call.name,
        code: verdict.payload.verdict,
        reasons: verdict.payload.reasons,
        ...(verdict.payload.retry_after_secs !== undefined && {
          retryAfterSecs: verdict.payload.retry_after_secs,
        }),
        ...(verdict.payload.layer !== undefined && { layer: verdict.payload.layer }),
        ...(verdict.correlationId !== undefined && { correlationId: verdict.correlationId }),
      });
    }
  }
}

function validateOptions(opts: ClavenarOptions): void {
  if (!opts || typeof opts.endpoint !== 'string' || opts.endpoint.length === 0) {
    throw new ClavenarConfigError('clavenarWrap: opts.endpoint is required');
  }
  try {
    new URL(opts.endpoint);
  } catch {
    throw new ClavenarConfigError(`clavenarWrap: opts.endpoint is not a valid URL: ${opts.endpoint}`);
  }
  if (opts.timeoutMs !== undefined && (opts.timeoutMs <= 0 || !Number.isFinite(opts.timeoutMs))) {
    throw new ClavenarConfigError('clavenarWrap: opts.timeoutMs must be a positive finite number');
  }
  if (opts.mode !== undefined && opts.mode !== 'enforce' && opts.mode !== 'observe') {
    throw new ClavenarConfigError(`clavenarWrap: opts.mode must be 'enforce' or 'observe' (got '${opts.mode}')`);
  }
}
