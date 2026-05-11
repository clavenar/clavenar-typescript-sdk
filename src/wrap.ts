import { WardenConfigError } from './errors.js';
import type { AnthropicLike } from './anthropic.js';
import type { WardenOptions } from './types.js';

/**
 * Wrap an Anthropic-like client so every `tool_use` block in the
 * response is inspected by warden before the caller sees it.
 *
 * Stub for week 1 Monday: validates options, returns the client
 * untouched. Tuesday rewires `messages.create` through a Proxy and
 * calls warden-lite's `POST /mcp` for each `tool_use` block. Thursday
 * adds verdict→error translation.
 */
export function wardenWrap<T extends AnthropicLike>(client: T, opts: WardenOptions): T {
  validateOptions(opts);
  if (!client || typeof client.messages?.create !== 'function') {
    throw new WardenConfigError('wardenWrap: client must expose messages.create()');
  }
  // TODO(tue): replace with Proxy that intercepts messages.create.
  return client;
}

function validateOptions(opts: WardenOptions): void {
  if (!opts || typeof opts.endpoint !== 'string' || opts.endpoint.length === 0) {
    throw new WardenConfigError('wardenWrap: opts.endpoint is required');
  }
  try {
    // Parse cheap-validates; we don't keep the URL object.
    new URL(opts.endpoint);
  } catch {
    throw new WardenConfigError(`wardenWrap: opts.endpoint is not a valid URL: ${opts.endpoint}`);
  }
  if (opts.timeoutMs !== undefined && (opts.timeoutMs <= 0 || !Number.isFinite(opts.timeoutMs))) {
    throw new WardenConfigError('wardenWrap: opts.timeoutMs must be a positive finite number');
  }
}
