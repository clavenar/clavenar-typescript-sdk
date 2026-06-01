/**
 * Structural shapes for the subset of OpenAI Realtime server events
 * this SDK touches. Same posture as `anthropic.ts` / `openai.ts` — no
 * `openai` import, narrow field set, validated against the Realtime
 * API reference (gpt-4o-realtime-preview, 2024-12-17).
 *
 * Source: https://platform.openai.com/docs/api-reference/realtime-server-events
 *
 * The Realtime API is websocket-based. Tool calls arrive as a sequence
 * of `response.function_call_arguments.delta` events that accumulate
 * a JSON string, followed by exactly one
 * `response.function_call_arguments.done` event carrying the complete
 * arguments. The `done` event is the only one clavenar inspects — by
 * that point the model has committed to the call and we have the full
 * argument payload.
 */
import { inspectToolUse } from './transport.js';
import type { NormalizedToolCall, ClavenarOptions, ClavenarVerdict } from './types.js';

/**
 * Terminal event for one Realtime tool call. The accompanying
 * `response.output_item.added` carries the `call_id` + tool `name`;
 * `response.function_call_arguments.done` carries the same `call_id`
 * + the final JSON-encoded `arguments` string. We carry `name` on
 * the type so callers building a single envelope from the two upstream
 * events can hand us one struct.
 */
export interface OpenAIRealtimeFunctionCallDone {
  type: 'response.function_call_arguments.done';
  response_id: string;
  item_id: string;
  output_index: number;
  call_id: string;
  /** JSON-encoded string per OpenAI's Realtime contract. */
  arguments: string;
  /** Tool name from the matching `response.output_item.added` event. */
  name: string;
}

/**
 * Anything else that arrives over the Realtime WS — `session.created`,
 * `response.audio.delta`, `response.text.delta`, deltas of the arg
 * stream we don't gate on, and so forth. We type the surface
 * structurally so a Realtime partner's existing handler can keep
 * receiving these untouched.
 */
export interface OpenAIRealtimeOtherEvent {
  type: string;
  [k: string]: unknown;
}

export type OpenAIRealtimeServerEvent =
  | OpenAIRealtimeFunctionCallDone
  | OpenAIRealtimeOtherEvent;

export function isRealtimeFunctionCallDone(
  evt: OpenAIRealtimeServerEvent,
): evt is OpenAIRealtimeFunctionCallDone {
  return (
    evt.type === 'response.function_call_arguments.done' &&
    typeof (evt as OpenAIRealtimeFunctionCallDone).call_id === 'string' &&
    typeof (evt as OpenAIRealtimeFunctionCallDone).arguments === 'string' &&
    typeof (evt as OpenAIRealtimeFunctionCallDone).name === 'string'
  );
}

/**
 * Normalize a Realtime `function_call_arguments.done` event into the
 * shape `inspectToolUse` accepts. Parses the JSON-encoded `arguments`
 * string; on parse failure the call's `input` lands as the raw string
 * so clavenar can still inspect the *attempt* — a malformed-args policy
 * rule is a legitimate use case and the SDK shouldn't swallow it.
 */
export function normalizeRealtimeFunctionCall(
  evt: OpenAIRealtimeFunctionCallDone,
): NormalizedToolCall {
  let input: unknown;
  try {
    input = JSON.parse(evt.arguments);
  } catch {
    input = evt.arguments;
  }
  return { id: evt.call_id, name: evt.name, input };
}

/**
 * One-shot inspection helper for a Realtime function call. Equivalent
 * to `inspectToolUse(normalizeRealtimeFunctionCall(evt), opts)` but
 * gives partners a single import to point at from their WS message
 * pump.
 *
 * Usage:
 *
 * ```ts
 * for await (const evt of realtimeEvents(ws)) {
 *   if (isRealtimeFunctionCallDone(evt)) {
 *     const verdict = await inspectRealtimeFunctionCall(evt, opts);
 *     if (verdict.kind === 'deny') {
 *       ws.send(JSON.stringify({
 *         type: 'conversation.item.create',
 *         item: { type: 'function_call_output', call_id: evt.call_id,
 *                 output: `denied: ${verdict.payload.reasons.join('; ')}` },
 *       }));
 *       continue;
 *     }
 *     // allow / pending — fall through to the handler dispatch
 *   }
 * }
 * ```
 *
 * Pending verdicts return as-is — the caller decides whether to
 * surface the pending state to the agent (e.g., emit a placeholder
 * `function_call_output` and resume the conversation later) or to
 * block the WS message pump until the operator decides.
 */
export async function inspectRealtimeFunctionCall(
  evt: OpenAIRealtimeFunctionCallDone,
  opts: ClavenarOptions,
): Promise<ClavenarVerdict> {
  return inspectToolUse(normalizeRealtimeFunctionCall(evt), opts);
}
