import { WardenConfigError, WardenDenied, WardenPending } from './errors.js';
import { isToolUseBlock } from './anthropic.js';
import type { AnthropicLike, AnthropicMessage, AnthropicToolUseBlock } from './anthropic.js';
import { inspectToolUse } from './transport.js';
import type { WardenOptions } from './types.js';

/**
 * Wrap an Anthropic-like client so every `tool_use` block in the
 * response is inspected by warden before the caller sees it.
 *
 * Implementation uses two layered `Proxy`s: one on the client to
 * intercept `messages`, and one on `messages` to intercept `create`.
 * Everything else (`models.list`, `client.beta.*`, etc.) routes
 * through `Reflect` unchanged so this stays a drop-in wrapper.
 *
 * Behavior is governed by `opts.mode`:
 *
 * - `'enforce'` (default): the first denied `tool_use` aborts the
 *   call with {@link WardenDenied}; a pending verdict aborts with
 *   {@link WardenPending}. The Anthropic response is discarded. The
 *   `onVerdict` callback fires for that block before the throw, so
 *   observe-mode telemetry stays consistent across both modes.
 *
 * - `'observe'`: no throw. Every verdict is surfaced via
 *   `onVerdict`, the response passes through, and the partner's
 *   existing tool-execution loop runs the denied tool. Use this for
 *   rollouts where you need warden visibility without breaking the
 *   agent.
 */
export function wardenWrap<T extends AnthropicLike>(client: T, opts: WardenOptions): T {
  validateOptions(opts);
  if (!client || typeof client.messages?.create !== 'function') {
    throw new WardenConfigError('wardenWrap: client must expose messages.create()');
  }

  const messagesProxy = new Proxy(client.messages, {
    get(target, prop, receiver) {
      if (prop !== 'create') return Reflect.get(target, prop, receiver);
      // Bind to `target` so the upstream SDK's internal `this`
      // expectations (auth headers, base URL config) stay intact.
      return wrappedCreate.bind(null, target, opts);
    },
  });

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'messages') return messagesProxy;
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}

async function wrappedCreate(
  messages: AnthropicLike['messages'],
  opts: WardenOptions,
  ...args: unknown[]
): Promise<AnthropicMessage> {
  const result = await Reflect.apply(messages.create, messages, args);
  await inspectAllToolUses(result, opts);
  return result;
}

/**
 * Walk every `tool_use` block in the response, inspect it, fire the
 * verdict callback, and (in enforce mode) throw on the first
 * deny/pending. Inspection stops at the first throw — once one
 * block is denied, the call is dead and subsequent inspections
 * would just add noise to the ledger.
 */
async function inspectAllToolUses(
  result: AnthropicMessage,
  opts: WardenOptions,
): Promise<void> {
  const enforce = (opts.mode ?? 'enforce') === 'enforce';
  const blocks: AnthropicToolUseBlock[] = (result.content ?? []).filter(isToolUseBlock);
  for (const block of blocks) {
    const verdict = await inspectToolUse(block, opts);
    if (opts.onVerdict) {
      await opts.onVerdict(verdict, {
        toolName: block.name,
        toolUseId: block.id,
        toolInput: block.input,
      });
    }
    if (!enforce) continue;
    if (verdict.kind === 'deny') {
      throw new WardenDenied({
        toolName: block.name,
        reasons: verdict.payload.reasons,
        reviewReasons: verdict.payload.review_reasons,
        intentCategory: verdict.payload.intent_category,
      });
    }
    if (verdict.kind === 'pending') {
      throw new WardenPending({
        toolName: block.name,
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
