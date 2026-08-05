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
  ClavenarRateLimited,
  ClavenarTransportError,
} from './errors.js';
import { emitDenyPanel } from './devmode.js';
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
import { inspectToolUse, inspectToolUses, pollPendingOnce } from './transport.js';
import type { NormalizedToolCall, ClavenarOptions, ClavenarVerdict } from './types.js';

const MAX_STREAM_ARGUMENT_BYTES = 1 << 20;
const MAX_STREAM_BATCH_BYTES = 4 << 20;

export async function* wrapAnthropicStream(
  upstream: AsyncIterable<AnthropicMessageStreamEvent>,
  opts: ClavenarOptions,
): AsyncGenerator<AnthropicMessageStreamEvent> {
  type ToolBuf = { id: string; name: string; argsBuf: string; argumentBytes: number };
  const bufs = new Map<number, ToolBuf>();
  const ignored = new Set<number>();
  const enforce = (opts.mode ?? 'enforce') === 'enforce';
  let streamArgumentBytes = 0;

  for await (const event of upstream) {
    if (isContentBlockStart(event) && event.content_block?.type === 'tool_use') {
      const block = event.content_block as AnthropicToolUseBlock;
      if (
        !Number.isSafeInteger(event.index)
        || event.index < 0
        || !isToolUseBlock(block)
        || typeof block.id !== 'string'
        || !block.id
        || typeof block.name !== 'string'
        || !block.name
      ) {
        await handleStreamShapeError('Anthropic stream opened a malformed tool_use block', opts);
        ignored.add(event.index);
        yield event;
        continue;
      }
      if (bufs.has(event.index) || bufs.size >= 128) {
        const previous = bufs.get(event.index);
        streamArgumentBytes -= previous?.argumentBytes ?? 0;
        bufs.delete(event.index);
        ignored.add(event.index);
        await handleStreamShapeError(
          bufs.size >= 128
            ? 'Anthropic stream has more than 128 open tool-use buffers'
            : 'Anthropic stream opened a duplicate tool-use buffer',
          opts,
        );
        yield event;
        continue;
      }
      bufs.set(event.index, { id: block.id, name: block.name, argsBuf: '', argumentBytes: 0 });
      yield event;
      continue;
    }
    if (isContentBlockDelta(event)) {
      const buf = bufs.get(event.index);
      if (buf && isInputJsonDelta(event.delta)) {
        const fragmentBytes = Buffer.byteLength(event.delta.partial_json, 'utf8');
        if (
          buf.argumentBytes + fragmentBytes > MAX_STREAM_ARGUMENT_BYTES
          || streamArgumentBytes + fragmentBytes > MAX_STREAM_BATCH_BYTES
        ) {
          await handleStreamShapeError(
            'Anthropic streamed tool arguments exceed the safety limit',
            opts,
          );
          streamArgumentBytes -= buf.argumentBytes;
          bufs.delete(event.index);
          ignored.add(event.index);
          yield event;
          continue;
        }
        buf.argsBuf += event.delta.partial_json;
        buf.argumentBytes += fragmentBytes;
        streamArgumentBytes += fragmentBytes;
      }
      yield event;
      continue;
    }
    if (isContentBlockStop(event)) {
      if (ignored.delete(event.index)) {
        yield event;
        continue;
      }
      const buf = bufs.get(event.index);
      if (!buf) {
        yield event;
        continue;
      }
      bufs.delete(event.index);
      streamArgumentBytes -= buf.argumentBytes;
      let call: NormalizedToolCall;
      try {
        call = bufToCall(buf);
      } catch (error) {
        await handleStreamShapeError(
          error instanceof Error ? error.message : String(error),
          opts,
        );
        yield event;
        continue;
      }
      // inspectAndMaybeThrow runs BEFORE we yield content_block_stop,
      // so a denied tool_use never reaches the partner as a closed block.
      await inspectAndMaybeThrow(call, opts, enforce);
      yield event;
      continue;
    }
    yield event;
  }
  if (bufs.size > 0) {
    await handleStreamShapeError(
      'Anthropic stream ended before an open tool_use block was closed',
      opts,
    );
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
  const ignoredChoices = new Set<number>();
  const enforce = (opts.mode ?? 'enforce') === 'enforce';
  let streamArgumentBytes = 0;

  for await (const chunk of upstream) {
    if (!chunk || !Array.isArray(chunk.choices)) {
      await handleStreamShapeError('OpenAI stream chunk is missing its choices array', opts);
      yield chunk;
      continue;
    }
    const choices = chunk.choices;
    const choicesToInspect: number[] = [];

    for (const choice of choices) {
      if (!Number.isSafeInteger(choice?.index) || choice.index < 0) {
        await handleStreamShapeError('OpenAI stream choice has an invalid index', opts);
        continue;
      }
      const deltas = choice.delta?.tool_calls;
      if (Array.isArray(deltas)) {
        for (const d of deltas as OpenAIChatToolCallDelta[]) {
          if (ignoredChoices.has(choice.index)) continue;
          try {
            const fragmentBytes = Buffer.byteLength(d.function?.arguments ?? '', 'utf8');
            if (streamArgumentBytes + fragmentBytes > MAX_STREAM_BATCH_BYTES) {
              throw new ClavenarConfigError(
                'OpenAI streamed tool arguments exceed the batch safety limit',
              );
            }
            accumulate(bufs, choice.index, d);
            streamArgumentBytes += fragmentBytes;
          } catch (error) {
            streamArgumentBytes -= removeChoice(bufs, choice.index);
            ignoredChoices.add(choice.index);
            await handleStreamShapeError(
              error instanceof Error ? error.message : String(error),
              opts,
            );
          }
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
      if (ignoredChoices.delete(choiceIdx)) continue;
      let calls: NormalizedToolCall[];
      const choiceArgumentBytes = choiceBytes(bufs, choiceIdx);
      try {
        calls = drainChoice(bufs, choiceIdx);
        if (calls.length === 0) {
          throw new ClavenarConfigError(
            "OpenAI stream finished with finish_reason='tool_calls' but no tool call was buffered",
          );
        }
      } catch (error) {
        await handleStreamShapeError(
          error instanceof Error ? error.message : String(error),
          opts,
        );
        streamArgumentBytes -= choiceArgumentBytes;
        continue;
      }
      streamArgumentBytes -= choiceArgumentBytes;
      await inspectChoiceBatch(calls, opts, enforce);
    }

    yield chunk;
  }
  if (bufs.size > 0) {
    await handleStreamShapeError(
      'OpenAI stream ended before buffered tool calls reached a terminal chunk',
      opts,
    );
  }
}

function accumulate(
  bufs: Map<string, { id?: string; name?: string; argsBuf: string }>,
  choiceIndex: number,
  d: OpenAIChatToolCallDelta,
): void {
  if (!Number.isSafeInteger(d.index) || (d.index ?? -1) < 0) {
    throw new ClavenarConfigError('OpenAI stream tool_call delta has an invalid index');
  }
  const key = `${choiceIndex}:${d.index}`;
  let buf = bufs.get(key);
  if (!buf) {
    if (bufs.size >= 128) {
      throw new ClavenarConfigError('OpenAI stream has more than 128 open tool-call buffers');
    }
    buf = { argsBuf: '' };
    bufs.set(key, buf);
  }
  if (d.id) buf.id = d.id;
  if (d.function?.name) buf.name = d.function.name;
  if (d.function?.arguments) {
    if (
      Buffer.byteLength(buf.argsBuf, 'utf8')
        + Buffer.byteLength(d.function.arguments, 'utf8')
      > MAX_STREAM_ARGUMENT_BYTES
    ) {
      throw new ClavenarConfigError('OpenAI streamed tool arguments exceed the safety limit');
    }
    buf.argsBuf += d.function.arguments;
  }
}

function choiceBytes(
  bufs: Map<string, { id?: string; name?: string; argsBuf: string }>,
  choiceIndex: number,
): number {
  const prefix = `${choiceIndex}:`;
  let total = 0;
  for (const [key, buf] of bufs) {
    if (key.startsWith(prefix)) total += Buffer.byteLength(buf.argsBuf, 'utf8');
  }
  return total;
}

function removeChoice(
  bufs: Map<string, { id?: string; name?: string; argsBuf: string }>,
  choiceIndex: number,
): number {
  const bytes = choiceBytes(bufs, choiceIndex);
  const prefix = `${choiceIndex}:`;
  for (const key of bufs.keys()) {
    if (key.startsWith(prefix)) bufs.delete(key);
  }
  return bytes;
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

async function handleStreamShapeError(message: string, opts: ClavenarOptions): Promise<void> {
  if ((opts.mode ?? 'enforce') === 'enforce') throw new ClavenarConfigError(message);
  if (!opts.onPolicyError) return;
  await opts.onPolicyError(
    new ClavenarTransportError(`clavenar: provider stream shape was not inspectable: ${message}`),
    { toolName: '<unextractable>', toolUseId: '<unextractable>', toolInput: {} },
  );
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
 * OpenAI choice-end batch: every sibling is covered by one ordered atomic
 * decision before the closing event is released.
 */
async function inspectChoiceBatch(
  calls: NormalizedToolCall[],
  opts: ClavenarOptions,
  enforce: boolean,
): Promise<void> {
  if (calls.length === 0) return;
  let verdict;
  try {
    verdict = await inspectToolUses(calls, opts);
  } catch (e) {
    if (!enforce && e instanceof ClavenarTransportError) {
      for (const call of calls) await firePolicyError(e, call, opts);
      return;
    }
    throw e;
  }
  for (const call of calls) {
    await processVerdict(verdict, call, opts, enforce);
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
