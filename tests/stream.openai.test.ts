import { describe, expect, it, vi } from 'vitest';
import { clavenarWrap, ClavenarDenied, ClavenarConfigError } from '../src/index.js';
import type { OpenAIChatCompletionChunk } from '../src/openai.js';
import type { ClavenarVerdict } from '../src/types.js';

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

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

/**
 * Emit canonical OpenAI streaming chunks for a single tool call:
 * first chunk carries id + name + part of arguments; later chunks
 * append more arguments; the final chunk has finish_reason
 * 'tool_calls' (no tool_calls delta in it). Mirrors the real wire
 * sequence.
 */
function toolCallChunks(
  id: string,
  name: string,
  args: object,
  toolIndex = 0,
  choiceIndex = 0,
): OpenAIChatCompletionChunk[] {
  const argStr = JSON.stringify(args);
  const half = Math.floor(argStr.length / 2);
  return [
    {
      id: 'chatcmpl_1',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: choiceIndex,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: toolIndex,
                id,
                type: 'function',
                function: { name, arguments: argStr.slice(0, half) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl_1',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: choiceIndex,
          delta: {
            tool_calls: [
              { index: toolIndex, function: { arguments: argStr.slice(half) } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl_1',
      object: 'chat.completion.chunk',
      choices: [{ index: choiceIndex, delta: {}, finish_reason: 'tool_calls' }],
    },
  ];
}

describe('clavenarWrap (OpenAI streaming)', () => {
  it('allow: forwards every chunk in order', async () => {
    const chunks = toolCallChunks('call_a', 'fetch_user', { id: 1 });
    const fetch = vi.fn().mockResolvedValue(allowResponse());
    const create = vi.fn().mockResolvedValue(fromArray(chunks));
    const wrapped = clavenarWrap(
      { chat: { completions: { create } } },
      { endpoint: 'http://w', fetch },
    );
    const stream = (await wrapped.chat.completions.create({ stream: true })) as AsyncIterable<OpenAIChatCompletionChunk>;
    const collected = await collect(stream);
    expect(collected).toHaveLength(3);
    expect(collected[2]?.choices[0]?.finish_reason).toBe('tool_calls');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('enforce + deny: throws BEFORE yielding the finish_reason chunk', async () => {
    const chunks = toolCallChunks('call_x', 'drop_table', { table: 'users' });
    const fetch = vi.fn().mockResolvedValue(denyResponse('drop_table'));
    const create = vi.fn().mockResolvedValue(fromArray(chunks));
    const wrapped = clavenarWrap(
      { chat: { completions: { create } } },
      { endpoint: 'http://w', fetch },
    );
    const stream = (await wrapped.chat.completions.create({ stream: true })) as AsyncIterable<OpenAIChatCompletionChunk>;
    const collected: OpenAIChatCompletionChunk[] = [];
    try {
      for await (const c of stream) collected.push(c);
      expect.fail('expected ClavenarDenied');
    } catch (e) {
      expect(e).toBeInstanceOf(ClavenarDenied);
      expect((e as ClavenarDenied).toolName).toBe('drop_table');
    }
    // Partner saw the two accumulation chunks but never the
    // finish_reason='tool_calls' chunk that would unlock execution.
    expect(collected).toHaveLength(2);
    expect(collected.every((c) => c.choices[0]?.finish_reason === null)).toBe(true);
  });

  it('observe + deny: every chunk passes through, onVerdict fires, no throw', async () => {
    const chunks = toolCallChunks('call_x', 'drop_table', {});
    const fetch = vi.fn().mockResolvedValue(denyResponse('drop_table'));
    const verdicts: ClavenarVerdict[] = [];
    const create = vi.fn().mockResolvedValue(fromArray(chunks));
    const wrapped = clavenarWrap(
      { chat: { completions: { create } } },
      {
        endpoint: 'http://w',
        fetch,
        mode: 'observe',
        onVerdict: (v) => {
          verdicts.push(v);
        },
      },
    );
    const stream = (await wrapped.chat.completions.create({ stream: true })) as AsyncIterable<OpenAIChatCompletionChunk>;
    const collected = await collect(stream);
    expect(collected).toHaveLength(3);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.kind).toBe('deny');
  });

  it('parallel tool_calls within one choice are buffered separately', async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      {
        id: 'c1',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', type: 'function', function: { name: 'fetch_user', arguments: '{"id":1}' } },
                { index: 1, id: 'call_b', type: 'function', function: { name: 'fetch_org', arguments: '{"id":2}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'c1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    ];
    const fetch = vi.fn().mockResolvedValue(allowResponse());
    const create = vi.fn().mockResolvedValue(fromArray(chunks));
    const wrapped = clavenarWrap(
      { chat: { completions: { create } } },
      { endpoint: 'http://w', fetch },
    );
    const stream = (await wrapped.chat.completions.create({ stream: true })) as AsyncIterable<OpenAIChatCompletionChunk>;
    await collect(stream);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects unparseable streamed arguments with ClavenarConfigError', async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      {
        id: 'c1',
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_x', type: 'function', function: { name: 'fetch_user', arguments: '{not json' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'c1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    ];
    const create = vi.fn().mockResolvedValue(fromArray(chunks));
    const wrapped = clavenarWrap(
      { chat: { completions: { create } } },
      { endpoint: 'http://w', fetch: vi.fn() },
    );
    const stream = (await wrapped.chat.completions.create({ stream: true })) as AsyncIterable<OpenAIChatCompletionChunk>;
    await expect(collect(stream)).rejects.toBeInstanceOf(ClavenarConfigError);
  });

  it('plain text streams (no tool_calls) pass through without inspection', async () => {
    const chunks: OpenAIChatCompletionChunk[] = [
      {
        id: 'c1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
      },
      {
        id: 'c1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ];
    const fetch = vi.fn();
    const create = vi.fn().mockResolvedValue(fromArray(chunks));
    const wrapped = clavenarWrap(
      { chat: { completions: { create } } },
      { endpoint: 'http://w', fetch },
    );
    const stream = (await wrapped.chat.completions.create({ stream: true })) as AsyncIterable<OpenAIChatCompletionChunk>;
    await collect(stream);
    expect(fetch).not.toHaveBeenCalled();
  });
});
