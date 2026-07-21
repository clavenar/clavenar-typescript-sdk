import { describe, expect, it, vi } from 'vitest';
import { clavenarWrap, ClavenarConfigError, ClavenarDenied } from '../src/index.js';
import type { OpenAIChatCompletion, OpenAIChatToolCall } from '../src/openai.js';
import type { ClavenarVerdict, ClavenarVerdictContext } from '../src/types.js';

function makeCompletion(toolCalls: OpenAIChatToolCall[] | null): OpenAIChatCompletion {
  return {
    id: 'chatcmpl_1',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          ...(toolCalls === null ? {} : { tool_calls: toolCalls }),
        },
        finish_reason: 'tool_calls',
      },
    ],
  };
}

function toolCall(id: string, name: string, args: unknown): OpenAIChatToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

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

describe('clavenarWrap (OpenAI client detection)', () => {
  it('routes openai-shaped client through chat.completions wrap', async () => {
    const completion = makeCompletion(null);
    const create = vi.fn().mockResolvedValue(completion);
    const fetch = vi.fn();
    const wrapped = clavenarWrap(
      { chat: { completions: { create } } },
      { endpoint: 'http://w', fetch },
    );
    const result = await wrapped.chat.completions.create({});
    expect(result).toBe(completion);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a client that has neither shape', () => {
    expect(() =>
      clavenarWrap({ foo: { bar: () => null } } as never, { endpoint: 'http://w' }),
    ).toThrow(ClavenarConfigError);
  });
});

describe('clavenarWrap (OpenAI tool_calls inspection)', () => {
  it('passes through completions with no tool_calls unchanged', async () => {
    const completion = makeCompletion(null);
    const fetch = vi.fn();
    const create = vi.fn().mockResolvedValue(completion);
    const wrapped = clavenarWrap(
      { chat: { completions: { create } } },
      { endpoint: 'http://w', fetch },
    );
    const result = await wrapped.chat.completions.create({});
    expect(result).toBe(completion);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('observe mode: inspects every tool_call in order, no throw', async () => {
    const completion = makeCompletion([
      toolCall('call_a', 'fetch_user', { id: 1 }),
      toolCall('call_b', 'delete_user', { id: 1 }),
    ]);
    const fetch = vi.fn().mockResolvedValue(denyResponse('atomic-batch'));
    const create = vi.fn().mockResolvedValue(completion);

    const verdicts: Array<[ClavenarVerdict, ClavenarVerdictContext]> = [];
    const wrapped = clavenarWrap(
      { chat: { completions: { create } } },
      {
        endpoint: 'http://w',
        fetch,
        mode: 'observe',
        onVerdict: (v, c) => {
          verdicts.push([v, c]);
        },
      },
    );
    const result = await wrapped.chat.completions.create({});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]?.[1].toolUseId).toBe('call_a');
    expect(verdicts[0]?.[1].toolName).toBe('fetch_user');
    expect(verdicts[0]?.[1].toolInput).toEqual({ id: 1 });
    expect(verdicts[1]?.[0].kind).toBe('deny');
    expect(result).toBe(completion);
  });

  it('enforce mode: first deny throws ClavenarDenied with parsed payload', async () => {
    const completion = makeCompletion([toolCall('call_x', 'drop_table', { table: 'users' })]);
    const fetch = vi.fn().mockResolvedValue(denyResponse('drop_table'));
    const wrapped = clavenarWrap(
      { chat: { completions: { create: async () => completion } } },
      { endpoint: 'http://w', fetch },
    );
    try {
      await wrapped.chat.completions.create({});
      expect.fail('expected ClavenarDenied');
    } catch (e) {
      expect(e).toBeInstanceOf(ClavenarDenied);
      const d = e as ClavenarDenied;
      expect(d.toolName).toBe('drop_table');
      expect(d.reasons).toEqual(['policy: drop_table blocked']);
    }
  });

  it('inspects all tool_calls in one atomic decision; first sibling reports deny', async () => {
    const completion = makeCompletion([
      toolCall('call_a', 'drop_table', {}),
      toolCall('call_b', 'fetch_user', {}),
    ]);
    const fetch = vi.fn().mockResolvedValue(denyResponse('drop_table'));
    const wrapped = clavenarWrap(
      { chat: { completions: { create: async () => completion } } },
      { endpoint: 'http://w', fetch },
    );
    try {
      await wrapped.chat.completions.create({});
      expect.fail('expected ClavenarDenied');
    } catch (e) {
      expect(e).toBeInstanceOf(ClavenarDenied);
      expect((e as ClavenarDenied).toolName).toBe('drop_table');
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an unparseable arguments string with ClavenarConfigError', async () => {
    const completion = makeCompletion([
      {
        id: 'call_bad',
        type: 'function',
        function: { name: 'fetch_user', arguments: '{not json' },
      },
    ]);
    const wrapped = clavenarWrap(
      { chat: { completions: { create: async () => completion } } },
      { endpoint: 'http://w', fetch: vi.fn() },
    );
    await expect(wrapped.chat.completions.create({})).rejects.toBeInstanceOf(ClavenarConfigError);
  });

  it('forwards arbitrary create() args to the upstream client', async () => {
    const create = vi.fn().mockResolvedValue(makeCompletion(null));
    const wrapped = clavenarWrap(
      { chat: { completions: { create } } },
      { endpoint: 'http://w', fetch: vi.fn() },
    );
    await wrapped.chat.completions.create(
      { model: 'gpt-4-turbo', tools: [] },
      { signal: undefined },
    );
    expect(create).toHaveBeenCalledWith(
      { model: 'gpt-4-turbo', tools: [] },
      { signal: undefined },
    );
  });

  it('preserves non-chat client properties', async () => {
    const client = {
      chat: { completions: { create: vi.fn().mockResolvedValue(makeCompletion(null)) } },
      baseURL: 'https://api.openai.com',
    };
    const wrapped = clavenarWrap(client, { endpoint: 'http://w', fetch: vi.fn() });
    // @ts-expect-error — baseURL isn't on OpenAIChatLike but rides through.
    expect(wrapped.baseURL).toBe('https://api.openai.com');
  });

  it('walks tool_calls across multiple choices', async () => {
    const completion: OpenAIChatCompletion = {
      id: 'c1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [toolCall('call_a', 'fetch_user', { id: 1 })],
          },
          finish_reason: 'tool_calls',
        },
        {
          index: 1,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [toolCall('call_b', 'fetch_user', { id: 2 })],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const fetch = vi.fn().mockResolvedValue(allowResponse());
    const wrapped = clavenarWrap(
      { chat: { completions: { create: async () => completion } } },
      { endpoint: 'http://w', fetch },
    );
    await wrapped.chat.completions.create({});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
