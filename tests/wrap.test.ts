import { describe, expect, it, vi } from 'vitest';
import { wardenWrap, WardenConfigError, WardenDenied, WardenPending } from '../src/index.js';
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
  it('rejects unknown mode', () => {
    expect(() =>
      // @ts-expect-error — testing runtime guard against typo'd literals
      wardenWrap(fakeClient, { endpoint: 'http://localhost:8088', mode: 'enforcing' }),
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

  it('observe mode: inspects every tool_use block in order, no throw', async () => {
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
        mode: 'observe',
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

describe('wardenWrap (enforce-mode semantics — default)', () => {
  it('throws WardenDenied with parsed payload on first deny', async () => {
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_x', name: 'drop_table', input: { table: 'users' } },
    ]);
    const fetch = vi.fn().mockResolvedValue(denyResponse('drop_table'));
    const wrapped = wardenWrap(
      { messages: { create: async () => message } },
      { endpoint: 'http://w', fetch },
    );
    try {
      await wrapped.messages.create({});
      expect.fail('expected wardenWrap to throw WardenDenied');
    } catch (e) {
      expect(e).toBeInstanceOf(WardenDenied);
      const denied = e as WardenDenied;
      expect(denied.toolName).toBe('drop_table');
      expect(denied.reasons).toEqual(['policy: drop_table blocked']);
      expect(denied.intentCategory).toBe('PolicyDeny');
      expect(denied.reviewReasons).toEqual([]);
    }
  });

  it('stops inspecting after the first deny', async () => {
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_a', name: 'drop_table', input: {} },
      { type: 'tool_use', id: 'toolu_b', name: 'fetch_user', input: {} },
    ]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(denyResponse('drop_table'))
      .mockResolvedValueOnce(allowResponse());
    const wrapped = wardenWrap(
      { messages: { create: async () => message } },
      { endpoint: 'http://w', fetch },
    );
    await expect(wrapped.messages.create({})).rejects.toBeInstanceOf(WardenDenied);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fires onVerdict for the denied block BEFORE throwing', async () => {
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_x', name: 'drop_table', input: {} },
    ]);
    const fetch = vi.fn().mockResolvedValue(denyResponse('drop_table'));
    const verdicts: WardenVerdict[] = [];
    const wrapped = wardenWrap(
      { messages: { create: async () => message } },
      {
        endpoint: 'http://w',
        fetch,
        onVerdict: (v) => {
          verdicts.push(v);
        },
      },
    );
    await expect(wrapped.messages.create({})).rejects.toBeInstanceOf(WardenDenied);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.kind).toBe('deny');
  });

  it('allow-only messages return normally in enforce mode', async () => {
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_a', name: 'fetch_user', input: {} },
    ]);
    const fetch = vi.fn().mockResolvedValue(allowResponse());
    const wrapped = wardenWrap(
      { messages: { create: async () => message } },
      { endpoint: 'http://w', fetch },
    );
    await expect(wrapped.messages.create({})).resolves.toBe(message);
  });

});

describe('wardenWrap (pending verdict throws WardenPending)', () => {
  // warden-lite doesn't emit pending today (Yellow-tier is full-edition
  // only; SDK gets it in roadmap week 4). We mock the transport module
  // to synthesize the pending verdict and prove the wrap converts it
  // to a WardenPending throw — the contract that week-4 wire support
  // will plug into.
  it('converts pending verdict to WardenPending in enforce mode', async () => {
    vi.resetModules();
    vi.doMock('../src/transport.js', () => ({
      inspectToolUse: async () => ({
        kind: 'pending',
        correlationId: 'corr_e2e_123',
      }),
      joinUrl: (a: string, b: string) => `${a}/${b}`,
    }));
    const { wardenWrap: wrapMocked, WardenPending: PendingMocked } = await import(
      '../src/index.js'
    );
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_p', name: 'wire_transfer', input: { amt: 1000 } },
    ]);
    const wrapped = wrapMocked(
      { messages: { create: async () => message } },
      { endpoint: 'http://w', fetch: vi.fn() },
    );
    try {
      await wrapped.messages.create({});
      expect.fail('expected WardenPending');
    } catch (e) {
      expect(e).toBeInstanceOf(PendingMocked);
      const p = e as InstanceType<typeof PendingMocked>;
      expect(p.toolName).toBe('wire_transfer');
      expect(p.correlationId).toBe('corr_e2e_123');
    }
    vi.doUnmock('../src/transport.js');
    vi.resetModules();
  });
});
