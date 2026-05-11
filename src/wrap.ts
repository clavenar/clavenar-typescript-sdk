import { WardenConfigError } from './errors.js';
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
 * Week 1 Wednesday semantics: inspect every tool_use and surface the
 * verdict via {@link WardenOptions.onVerdict}, but do NOT throw on
 * deny — the response passes through unchanged. Thursday adds the
 * `WardenDenied` throw on the first deny verdict.
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
 * Walk every `tool_use` block in the response, inspect it, and fire
 * the verdict callback. Inspection is sequential — warden-lite
 * preserves the audit-ledger ordering, and one denied block before
 * another allowed block in the same message is meaningful context.
 */
async function inspectAllToolUses(
  result: AnthropicMessage,
  opts: WardenOptions,
): Promise<void> {
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
    // Thursday: throw WardenDenied here on verdict.kind === 'deny'.
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
}
