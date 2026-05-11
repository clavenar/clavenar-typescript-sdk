import { describe, expect, it, vi } from 'vitest';
import { wardenWrap, WardenConfigError } from '../src/index.js';
import type { AnthropicMessage } from '../src/anthropic.js';
import type { WardenVerdict, WardenVerdictContext } from '../src/types.js';

function makeMessage(content: AnthropicMessage['content']): AnthropicMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content,
    stop_reason: 'end_turn',
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

describe('wardenWrap (config validation)', () => {
  const fakeClient = { messages: { create: async () => makeMessage([]) } };

  it('rejects empty endpoint', () => {
    expect(() => wardenWrap(fakeClient, { endpoint: '' })).toThrow(WardenConfigError);
  });
  it('rejects malformed endpoint', () => {
    expect(() => wardenWrap(fakeClient, { endpoint: 'not-a-url' })).toThrow(WardenConfigError);
  });
  it('rejects clients without messages.create', () => {
    expect(() => wardenWrap({} as never, { endpoint: 'http://localhost:8088' })).toThrow(
      WardenConfigError,
    );
  });
  it('rejects negative timeout', () => {
    expect(() =>
      wardenWrap(fakeClient, { endpoint: 'http://localhost:8088', timeoutMs: -1 }),
    ).toThrow(WardenConfigError);
  });
});

describe('wardenWrap (interception)', () => {
  it('passes through messages without tool_use unchanged', async () => {
    const message = makeMessage([{ type: 'text', text: 'hi' }]);
    const fetch = vi.fn();
    const client = { messages: { create: vi.fn().mockResolvedValue(message) } };

    const wrapped = wardenWrap(client, { endpoint: 'http://w', fetch });
    const result = await wrapped.messages.create({});

    expect(result).toBe(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('inspects every tool_use block in order', async () => {
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_a', name: 'fetch_user', input: { id: 1 } },
      { type: 'text', text: 'thinking...' },
      { type: 'tool_use', id: 'toolu_b', name: 'delete_user', input: { id: 1 } },
    ]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(allowResponse())
      .mockResolvedValueOnce(denyResponse('delete_user'));
    const create = vi.fn().mockResolvedValue(message);

    const verdicts: Array<[WardenVerdict, WardenVerdictContext]> = [];
    const wrapped = wardenWrap(
      { messages: { create } },
      {
        endpoint: 'http://w',
        fetch,
        onVerdict: (v, c) => {
          verdicts.push([v, c]);
        },
      },
    );

    const result = await wrapped.messages.create({});

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]?.[0]).toEqual({ kind: 'allow' });
    expect(verdicts[0]?.[1].toolName).toBe('fetch_user');
    expect(verdicts[0]?.[1].toolUseId).toBe('toolu_a');
    expect(verdicts[1]?.[0].kind).toBe('deny');
    expect(verdicts[1]?.[1].toolName).toBe('delete_user');
    expect(result).toBe(message);
  });

  it('does NOT throw on deny in week-1 wrap (Thursday adds throw)', async () => {
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_x', name: 'drop_table', input: {} },
    ]);
    const fetch = vi.fn().mockResolvedValue(denyResponse('drop_table'));
    const wrapped = wardenWrap(
      { messages: { create: async () => message } },
      { endpoint: 'http://w', fetch },
    );
    await expect(wrapped.messages.create({})).resolves.toBe(message);
  });

  it('forwards arbitrary create() args to the upstream client', async () => {
    const create = vi.fn().mockResolvedValue(makeMessage([]));
    const wrapped = wardenWrap(
      { messages: { create } },
      { endpoint: 'http://w', fetch: vi.fn() },
    );
    await wrapped.messages.create({ model: 'claude-opus-4-7', max_tokens: 1024 }, { signal: undefined });
    expect(create).toHaveBeenCalledWith({ model: 'claude-opus-4-7', max_tokens: 1024 }, { signal: undefined });
  });

  it('preserves non-messages client properties', async () => {
    const client = {
      messages: { create: vi.fn().mockResolvedValue(makeMessage([])) },
      extras: { baseURL: 'https://api.anthropic.com' },
    };
    const wrapped = wardenWrap(client, { endpoint: 'http://w', fetch: vi.fn() });
    // @ts-expect-error — extras is not on AnthropicLike but rides through.
    expect(wrapped.extras.baseURL).toBe('https://api.anthropic.com');
  });

  it('propagates upstream messages.create errors', async () => {
    const upstream = new Error('rate limited');
    const wrapped = wardenWrap(
      { messages: { create: async () => { throw upstream; } } },
      { endpoint: 'http://w', fetch: vi.fn() },
    );
    await expect(wrapped.messages.create({})).rejects.toBe(upstream);
  });

  it('handles a message with missing content array', async () => {
    const message = { ...makeMessage([]) } as AnthropicMessage;
    delete (message as unknown as { content?: unknown }).content;
    const fetch = vi.fn();
    const wrapped = wardenWrap(
      { messages: { create: async () => message } },
      { endpoint: 'http://w', fetch },
    );
    await expect(wrapped.messages.create({})).resolves.toBe(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('awaits async onVerdict callbacks before resolving', async () => {
    let callbackResolved = false;
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_a', name: 'ping', input: {} },
    ]);
    const fetch = vi.fn().mockResolvedValue(allowResponse());
    const wrapped = wardenWrap(
      { messages: { create: async () => message } },
      {
        endpoint: 'http://w',
        fetch,
        onVerdict: async () => {
          await new Promise((r) => setTimeout(r, 10));
          callbackResolved = true;
        },
      },
    );
    await wrapped.messages.create({});
    expect(callbackResolved).toBe(true);
  });
});
