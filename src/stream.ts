/**
 * Streaming wrappers for both providers. Each is an async generator
 * that mirrors the upstream event sequence one-for-one, with two
 * differences:
 *
 *   1. Tool-call assembly is observed: `partial_json` deltas
 *      (Anthropic) and `function.arguments` deltas (OpenAI) are
 *      buffered per tool index until the call completes.
 *   2. The closing event (`content_block_stop` for Anthropic, the
 *      `finish_reason: 'tool_calls'` chunk for OpenAI) is held while
 *      clavenar inspects. On deny in enforce mode we throw before
 *      yielding that closing event — partner code never sees a
 *      denied tool call as actionable.
 *
 * onVerdict fires for every inspected tool call before any throw, so
 * observe-mode telemetry stays consistent with the non-streaming path.
 */

import {
  ClavenarConfigError,
  ClavenarDenied,
  ClavenarPending,
  ClavenarTransportError,
} from './errors.js';
import {
  isContentBlockStart,
  isContentBlockDelta,
  isContentBlockStop,
  isInputJsonDelta,
  isToolUseBlock,
} from './anthropic.js';
import type {
  AnthropicMessageStreamEvent,
  AnthropicToolUseBlock,
} from './anthropic.js';
import type {
  OpenAIChatCompletionChunk,
  OpenAIChatToolCallDelta,
} from './openai.js';
import { inspectToolUse, pollPendingOnce } from './transport.js';
import type { NormalizedToolCall, ClavenarOptions, ClavenarVerdict } from './types.js';

export async function* wrapAnthropicStream(
  upstream: AsyncIterable<AnthropicMessageStreamEvent>,
  opts: ClavenarOptions,
): AsyncGenerator<AnthropicMessageStreamEvent> {
  type ToolBuf = { id: string; name: string; argsBuf: string };
  const bufs = new Map<number, ToolBuf>();
  const enforce = (opts.mode ?? 'enforce') === 'enforce';

  for await (const event of upstream) {
    if (isContentBlockStart(event) && isToolUseBlock(event.content_block as AnthropicToolUseBlock)) {
      const block = event.content_block as AnthropicToolUseBlock;
      bufs.set(event.index, { id: block.id, name: block.name, argsBuf: '' });
      yield event;
      continue;
    }
    if (isContentBlockDelta(event)) {
      const buf = bufs.get(event.index);
      if (buf && isInputJsonDelta(event.delta)) {
        buf.argsBuf += event.delta.partial_json;
      }
      yield event;
      continue;
    }
    if (isContentBlockStop(event)) {
      const buf = bufs.get(event.index);
      if (!buf) {
        yield event;
        continue;
      }
      bufs.delete(event.index);
      const call = bufToCall(buf);
      // inspectAndMaybeThrow runs BEFORE we yield content_block_stop,
      // so a denied tool_use never reaches the partner as a closed block.
      await inspectAndMaybeThrow(call, opts, enforce);
      yield event;
      continue;
    }
    yield event;
  }
}

export async function* wrapOpenAIChatStream(
  upstream: AsyncIterable<OpenAIChatCompletionChunk>,
  opts: ClavenarOptions,
): AsyncGenerator<OpenAIChatCompletionChunk> {
  type ToolBuf = { id?: string; name?: string; argsBuf: string };
  // Keyed by `${choiceIndex}:${toolIndex}` so parallel tool_calls
  // within one choice and tool_calls across multiple choices stay
  // separate.
  const bufs = new Map<string, ToolBuf>();
  const enforce = (opts.mode ?? 'enforce') === 'enforce';

  for await (const chunk of upstream) {
    const choices = chunk.choices ?? [];
    const choicesToInspect: number[] = [];

    for (const choice of choices) {
      const deltas = choice.delta?.tool_calls;
      if (Array.isArray(deltas)) {
        for (const d of deltas as OpenAIChatToolCallDelta[]) {
          accumulate(bufs, choice.index, d);
        }
      }
      if (choice.finish_reason === 'tool_calls') {
        choicesToInspect.push(choice.index);
      }
    }

    // Inspect BEFORE yielding the finishing chunk — partner doesn't
    // see finish_reason='tool_calls' for a choice that has a denied
    // call until clavenar clears it. Parallel across all tool calls in
    // the choice; serial across choices (an unusual N>1 case).
    for (const choiceIdx of choicesToInspect) {
      await inspectChoiceBatch(drainChoice(bufs, choiceIdx), opts, enforce);
    }

    yield chunk;
  }
}

function accumulate(
  bufs: Map<string, { id?: string; name?: string; argsBuf: string }>,
  choiceIndex: number,
  d: OpenAIChatToolCallDelta,
): void {
  const key = `${choiceIndex}:${d.index ?? 0}`;
  let buf = bufs.get(key);
  if (!buf) {
    buf = { argsBuf: '' };
    bufs.set(key, buf);
  }
  if (d.id) buf.id = d.id;
  if (d.function?.name) buf.name = d.function.name;
  if (d.function?.arguments) buf.argsBuf += d.function.arguments;
}

function drainChoice(
  bufs: Map<string, { id?: string; name?: string; argsBuf: string }>,
  choiceIndex: number,
): NormalizedToolCall[] {
  const prefix = `${choiceIndex}:`;
  const out: NormalizedToolCall[] = [];
  for (const [key, buf] of bufs) {
    if (!key.startsWith(prefix)) continue;
    bufs.delete(key);
    if (!buf.id || !buf.name) {
      throw new ClavenarConfigError(
        `OpenAI stream chunk finished with finish_reason='tool_calls' but tool_call buffer ${key} is missing id or name`,
      );
    }
    let input: unknown;
    try {
      input = buf.argsBuf === '' ? {} : JSON.parse(buf.argsBuf);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new ClavenarConfigError(
        `OpenAI tool_call ${buf.id} (${buf.name}) streamed unparseable arguments: ${reason}`,
      );
    }
    out.push({ id: buf.id, name: buf.name, input });
  }
  return out;
}

function bufToCall(buf: { id: string; name: string; argsBuf: string }): NormalizedToolCall {
  let input: unknown;
  try {
    input = buf.argsBuf === '' ? {} : JSON.parse(buf.argsBuf);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new ClavenarConfigError(
      `Anthropic tool_use ${buf.id} (${buf.name}) streamed unparseable input_json: ${reason}`,
    );
  }
  return { id: buf.id, name: buf.name, input };
}

async function inspectAndMaybeThrow(
  call: NormalizedToolCall,
  opts: ClavenarOptions,
  enforce: boolean,
): Promise<void> {
  let verdict: ClavenarVerdict;
  try {
    verdict = await inspectToolUse(call, opts);
  } catch (e) {
    if (!enforce && e instanceof ClavenarTransportError) {
      await firePolicyError(e, call, opts);
      return;
    }
    throw e;
  }
  await processVerdict(verdict, call, opts, enforce);
}

/**
 * OpenAI choice-end batch: every tool call in one choice inspected
 * concurrently, verdicts processed in submission order. First deny
 * still throws first — same semantics as the non-streaming path.
 *
 * Observe-mode transport failures are caught per-call (mirroring
 * `inspectAllToolCalls` in wrap.ts) so one clavenar outage doesn't
 * abort the stream — observe mode's contract is "no throw, response
 * passes through" and the stream wrapper has to honor it too.
 */
async function inspectChoiceBatch(
  calls: NormalizedToolCall[],
  opts: ClavenarOptions,
  enforce: boolean,
): Promise<void> {
  if (calls.length === 0) return;
  const results = await Promise.all(
    calls.map(async (c) => {
      try {
        return { ok: true as const, verdict: await inspectToolUse(c, opts) };
      } catch (e) {
        if (!enforce && e instanceof ClavenarTransportError) {
          return { ok: false as const, error: e };
        }
        throw e;
      }
    }),
  );
  for (let i = 0; i < calls.length; i++) {
    const result = results[i]!;
    const call = calls[i]!;
    if (!result.ok) {
      await firePolicyError(result.error, call, opts);
      continue;
    }
    await processVerdict(result.verdict, call, opts, enforce);
  }
}

async function firePolicyError(
  error: ClavenarTransportError,
  call: NormalizedToolCall,
  opts: ClavenarOptions,
): Promise<void> {
  if (!opts.onPolicyError) return;
  await opts.onPolicyError(error, {
    toolName: call.name,
    toolUseId: call.id,
    toolInput: call.input,
  });
}

async function processVerdict(
  verdict: ClavenarVerdict,
  call: NormalizedToolCall,
  opts: ClavenarOptions,
  enforce: boolean,
): Promise<void> {
  if (opts.onVerdict) {
    await opts.onVerdict(verdict, {
      toolName: call.name,
      toolUseId: call.id,
      toolInput: call.input,
    });
  }
  if (!enforce) return;
  if (verdict.kind === 'deny') {
    throw new ClavenarDenied({
      toolName: call.name,
      reasons: verdict.payload.reasons,
      reviewReasons: verdict.payload.review_reasons,
      intentCategory: verdict.payload.intent_category,
      ...(verdict.correlationId !== undefined && { correlationId: verdict.correlationId }),
    });
  }
  if (verdict.kind === 'pending') {
    throw new ClavenarPending({
      toolName: call.name,
      correlationId: verdict.correlationId,
      reviewReasons: verdict.reviewReasons,
      pollOnce: () => pollPendingOnce(verdict.correlationId, opts),
    });
  }
}
