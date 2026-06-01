import { describe, expect, it, vi } from 'vitest';
import { clavenarWrap, ClavenarDenied } from '../src/index.js';
import type {
  AnthropicMessageStreamEvent,
} from '../src/anthropic.js';
import type { ClavenarVerdict, ClavenarVerdictContext } from '../src/types.js';

function allowResponse(): Response {
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function denyResponse(toolName: string): Response {
  return new Response(
    JSON.stringify({
      error: 'security_violation',
      reasons: [`policy: ${toolName} blocked`],
      review_reasons: [],
      intent_category: 'PolicyDeny',
    }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );
}

async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

/**
 * Emit the canonical event sequence for a single tool_use block:
 * content_block_start → N input_json_delta → content_block_stop. The
 * args are split across two deltas so the buffer-across-deltas path
 * is exercised.
 */
function toolUseEvents(
  index: number,
  id: string,
  name: string,
  args: object,
): AnthropicMessageStreamEvent[] {
  const argStr = JSON.stringify(args);
  const half = Math.floor(argStr.length / 2);
  const part1 = argStr.slice(0, half);
  const part2 = argStr.slice(half);
  return [
    {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name, input: {} },
    },
    {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: part1 },
    },
    {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: part2 },
    },
    { type: 'content_block_stop', index },
  ];
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('clavenarWrap (Anthropic streaming)', () => {
  it('allow: streams every upstream event through unchanged', async () => {
    const events: AnthropicMessageStreamEvent[] = [
      { type: 'message_start', message: { id: 'msg_1', role: 'assistant' } },
      ...toolUseEvents(0, 'toolu_a', 'fetch_user', { id: 1 }),
      { type: 'message_stop' },
    ];
    const fetch = vi.fn().mockResolvedValue(allowResponse());
    const create = vi.fn().mockResolvedValue(fromArray(events));
    const wrapped = clavenarWrap(
      { messages: { create } },
      { endpoint: 'http://w', fetch },
    );
    const stream = (await wrapped.messages.create({ stream: true })) as AsyncIterable<AnthropicMessageStreamEvent>;
    const collected = await collect(stream);
    expect(collected.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_stop',
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('enforce + deny: throws mid-iteration BEFORE yielding content_block_stop', async () => {
    const events: AnthropicMessageStreamEvent[] = [
      ...toolUseEvents(0, 'toolu_x', 'drop_table', { table: 'users' }),
      { type: 'message_stop' },
    ];
    const fetch = vi.fn().mockResolvedValue(denyResponse('drop_table'));
    const create = vi.fn().mockResolvedValue(fromArray(events));
    const wrapped = clavenarWrap(
      { messages: { create } },
      { endpoint: 'http://w', fetch },
    );
    const stream = (await wrapped.messages.create({ stream: true })) as AsyncIterable<AnthropicMessageStreamEvent>;
    const collected: AnthropicMessageStreamEvent[] = [];
    try {
      for await (const e of stream) collected.push(e);
      expect.fail('expected ClavenarDenied');
    } catch (e) {
      expect(e).toBeInstanceOf(ClavenarDenied);
      expect((e as ClavenarDenied).toolName).toBe('drop_table');
    }
    // Partner saw block_start + both deltas, but NEVER content_block_stop.
    expect(collected.map((x) => x.type)).toEqual([
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
    ]);
  });

  it('observe + deny: every event passes through, onVerdict fires, no throw', async () => {
    const events: AnthropicMessageStreamEvent[] = [
      ...toolUseEvents(0, 'toolu_x', 'drop_table', { table: 'users' }),
      { type: 'message_stop' },
    ];
    const fetch = vi.fn().mockResolvedValue(denyResponse('drop_table'));
    const verdicts: ClavenarVerdict[] = [];
    const create = vi.fn().mockResolvedValue(fromArray(events));
    const wrapped = clavenarWrap(
      { messages: { create } },
      {
        endpoint: 'http://w',
        fetch,
        mode: 'observe',
        onVerdict: (v) => {
          verdicts.push(v);
        },
      },
    );
    const stream = (await wrapped.messages.create({ stream: true })) as AsyncIterable<AnthropicMessageStreamEvent>;
    const collected = await collect(stream);
    expect(collected.map((e) => e.type)).toEqual([
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_stop',
    ]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.kind).toBe('deny');
  });

  it('parallel tool_uses (different indexes) are buffered separately', async () => {
    const events: AnthropicMessageStreamEvent[] = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_a', name: 'fetch_user', input: {} },
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_b', name: 'fetch_org', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"id":1}' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"id":2}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_stop' },
    ];
    const fetch = vi.fn().mockResolvedValue(allowResponse());
    const create = vi.fn().mockResolvedValue(fromArray(events));
    const verdicts: ClavenarVerdictContext[] = [];
    const wrapped = clavenarWrap(
      { messages: { create } },
      {
        endpoint: 'http://w',
        fetch,
        onVerdict: (_v, ctx) => {
          verdicts.push(ctx);
        },
      },
    );
    const stream = (await wrapped.messages.create({ stream: true })) as AsyncIterable<AnthropicMessageStreamEvent>;
    await collect(stream);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(verdicts.map((c) => c.toolUseId)).toEqual(['toolu_a', 'toolu_b']);
    expect(verdicts.map((c) => c.toolInput)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('non-tool_use blocks pass through without inspection', async () => {
    const events: AnthropicMessageStreamEvent[] = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      },
      { type: 'content_block_stop', index: 0 },
    ];
    const fetch = vi.fn();
    const create = vi.fn().mockResolvedValue(fromArray(events));
    const wrapped = clavenarWrap(
      { messages: { create } },
      { endpoint: 'http://w', fetch },
    );
    const stream = (await wrapped.messages.create({ stream: true })) as AsyncIterable<AnthropicMessageStreamEvent>;
    await collect(stream);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('onVerdict fires BEFORE the throw in enforce mode', async () => {
    const events: AnthropicMessageStreamEvent[] = toolUseEvents(0, 'toolu_x', 'drop_table', {});
    const fetch = vi.fn().mockResolvedValue(denyResponse('drop_table'));
    const verdicts: ClavenarVerdict[] = [];
    const create = vi.fn().mockResolvedValue(fromArray(events));
    const wrapped = clavenarWrap(
      { messages: { create } },
      {
        endpoint: 'http://w',
        fetch,
        onVerdict: (v) => {
          verdicts.push(v);
        },
      },
    );
    const stream = (await wrapped.messages.create({ stream: true })) as AsyncIterable<AnthropicMessageStreamEvent>;
    await expect(collect(stream)).rejects.toBeInstanceOf(ClavenarDenied);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.kind).toBe('deny');
  });
});
