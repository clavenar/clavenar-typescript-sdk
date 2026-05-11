/**
 * Structural shapes for the subset of Anthropic SDK types this SDK
 * touches. We deliberately do NOT import from `@anthropic-ai/sdk` —
 * keeping it a peer-dep means partners aren't forced onto a specific
 * SDK version, and our type surface stays narrow.
 *
 * Source: https://github.com/anthropics/anthropic-sdk-typescript
 * (validated against v0.30.x; if v1.x renames any of these, narrow
 * the field set rather than chasing the upstream surface area).
 */

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export type AnthropicContentBlock =
  | AnthropicToolUseBlock
  | AnthropicTextBlock
  | { type: string; [k: string]: unknown };

export interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  [k: string]: unknown;
}

/**
 * Minimum shape we need from an Anthropic-like client: a
 * `messages.create` that returns a {@link AnthropicMessage}.
 *
 * Streaming + raw-response variants are out of scope for v1 (roadmap
 * week 1-2). They show up in the SDK as overloads — we narrow to the
 * non-streaming overload via `Promise<AnthropicMessage>`.
 */
export interface AnthropicLike {
  messages: {
    create: (...args: unknown[]) => Promise<AnthropicMessage>;
  };
}

/** Type guard: is this content block a tool_use? */
export function isToolUseBlock(b: AnthropicContentBlock): b is AnthropicToolUseBlock {
  return b.type === 'tool_use';
}

/**
 * Anthropic streaming events. We narrow to the subset our stream
 * wrapper inspects: tool_use openings, JSON input deltas, and
 * content_block stops. Everything else flows through opaquely as
 * `{ type: string; [k: string]: unknown }`.
 *
 * Source: https://docs.anthropic.com/en/api/messages-streaming
 */
export interface AnthropicContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: AnthropicContentBlock;
}

export interface AnthropicInputJsonDelta {
  type: 'input_json_delta';
  partial_json: string;
}

export interface AnthropicContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta: AnthropicInputJsonDelta | { type: string; [k: string]: unknown };
}

export interface AnthropicContentBlockStop {
  type: 'content_block_stop';
  index: number;
}

export type AnthropicMessageStreamEvent =
  | AnthropicContentBlockStart
  | AnthropicContentBlockDelta
  | AnthropicContentBlockStop
  | { type: string; [k: string]: unknown };

export function isContentBlockStart(e: AnthropicMessageStreamEvent): e is AnthropicContentBlockStart {
  return e.type === 'content_block_start';
}
export function isContentBlockDelta(e: AnthropicMessageStreamEvent): e is AnthropicContentBlockDelta {
  return e.type === 'content_block_delta';
}
export function isContentBlockStop(e: AnthropicMessageStreamEvent): e is AnthropicContentBlockStop {
  return e.type === 'content_block_stop';
}
export function isInputJsonDelta(
  d: AnthropicContentBlockDelta['delta'],
): d is AnthropicInputJsonDelta {
  return d.type === 'input_json_delta';
}
