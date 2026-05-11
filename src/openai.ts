/**
 * Structural shapes for the subset of OpenAI SDK types this SDK
 * touches. Same posture as `anthropic.ts` — no import from `openai`,
 * narrow field set, validated against the OpenAI Chat Completions
 * response (v4.x of the `openai` package).
 *
 * Source: https://github.com/openai/openai-node — `chat.completions`
 * tool-call shape.
 *
 * The Responses API (`openai.responses.create`) lands in a follow-up
 * — its `output[]` shape is different enough to warrant its own
 * normalizer rather than overloading this one.
 */

import { WardenConfigError } from './errors.js';
import type { NormalizedToolCall } from './types.js';

export interface OpenAIChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON-encoded string per OpenAI's contract. We parse on normalize. */
    arguments: string;
  };
}

export interface OpenAIChatMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: OpenAIChatToolCall[];
  [k: string]: unknown;
}

export interface OpenAIChatChoice {
  index: number;
  message: OpenAIChatMessage;
  finish_reason: string | null;
  [k: string]: unknown;
}

export interface OpenAIChatCompletion {
  id: string;
  object: 'chat.completion';
  choices: OpenAIChatChoice[];
  [k: string]: unknown;
}

/**
 * Minimum shape we need from an OpenAI-like client: a
 * `chat.completions.create` that returns an {@link OpenAIChatCompletion}.
 * Streaming and the Responses API are out of scope for v1.
 */
export interface OpenAIChatLike {
  chat: {
    completions: {
      create: (...args: unknown[]) => Promise<OpenAIChatCompletion>;
    };
  };
}

export function isOpenAIChatToolCall(v: unknown): v is OpenAIChatToolCall {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r['type'] !== 'function') return false;
  if (typeof r['id'] !== 'string') return false;
  const fn = r['function'];
  if (typeof fn !== 'object' || fn === null) return false;
  const fnR = fn as Record<string, unknown>;
  return typeof fnR['name'] === 'string' && typeof fnR['arguments'] === 'string';
}

/**
 * Parse the OpenAI tool call's JSON-encoded `arguments` and surface a
 * {@link NormalizedToolCall}. Throws {@link WardenConfigError} when
 * the upstream model emits a tool call whose `arguments` field isn't
 * valid JSON — that's a contract violation by the model, not
 * something warden can usefully forward to policy.
 */
export function normalizeChatToolCall(call: OpenAIChatToolCall): NormalizedToolCall {
  let input: unknown;
  try {
    input = JSON.parse(call.function.arguments);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new WardenConfigError(
      `OpenAI tool_call ${call.id} (${call.function.name}) had unparseable arguments: ${reason}`,
    );
  }
  return { id: call.id, name: call.function.name, input };
}
