import { describe, expect, it, vi } from 'vitest';
import {
  clavenarWrap,
  ClavenarConfigError,
  ClavenarDenied,
  ClavenarRateLimited,
  ClavenarTransportError,
} from '../src/index.js';
import type { AnthropicMessage } from '../src/anthropic.js';
import type { ClavenarVerdict, ClavenarVerdictContext } from '../src/types.js';

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

describe('clavenarWrap (config validation)', () => {
  const fakeClient = { messages: { create: async () => makeMessage([]) } };

  it('rejects empty endpoint', () => {
    expect(() => clavenarWrap(fakeClient, { endpoint: '' })).toThrow(ClavenarConfigError);
  });
  it('rejects malformed endpoint', () => {
    expect(() => clavenarWrap(fakeClient, { endpoint: 'not-a-url' })).toThrow(ClavenarConfigError);
  });
  it('rejects clients without messages.create', () => {
    expect(() => clavenarWrap({} as never, { endpoint: 'http://localhost:8088' })).toThrow(
      ClavenarConfigError,
    );
  });
  it('rejects negative timeout', () => {
    expect(() =>
      clavenarWrap(fakeClient, { endpoint: 'http://localhost:8088', timeoutMs: -1 }),
    ).toThrow(ClavenarConfigError);
  });
  it('rejects unknown mode', () => {
    expect(() =>
      // @ts-expect-error — testing runtime guard against typo'd literals
      clavenarWrap(fakeClient, { endpoint: 'http://localhost:8088', mode: 'enforcing' }),
    ).toThrow(ClavenarConfigError);
  });
});

describe('clavenarWrap (stream helper guard)', () => {
  it('blocks messages.stream() by default with a config error', () => {
    const client = {
      messages: { create: vi.fn(), stream: vi.fn() },
    };
    const wrapped = clavenarWrap(client, { endpoint: 'http://w' });
    expect(() => (wrapped.messages as { stream: () => unknown }).stream()).toThrow(
      ClavenarConfigError,
    );
    expect(client.messages.stream).not.toHaveBeenCalled();
  });

  it('allowUninspectedStream passes the helper through untouched', () => {
    const stream = vi.fn().mockReturnValue('raw-stream');
    const client = { messages: { create: vi.fn(), stream } };
    const wrapped = clavenarWrap(client, {
      endpoint: 'http://w',
      allowUninspectedStream: true,
    });
    expect((wrapped.messages as { stream: () => unknown }).stream()).toBe('raw-stream');
  });
});

describe('clavenarWrap (interception)', () => {
  it('passes through messages without tool_use unchanged', async () => {
    const message = makeMessage([{ type: 'text', text: 'hi' }]);
    const fetch = vi.fn();
    const client = { messages: { create: vi.fn().mockResolvedValue(message) } };

    const wrapped = clavenarWrap(client, { endpoint: 'http://w', fetch });
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

    const verdicts: Array<[ClavenarVerdict, ClavenarVerdictContext]> = [];
    const wrapped = clavenarWrap(
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
    const wrapped = clavenarWrap(
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
    const wrapped = clavenarWrap(client, { endpoint: 'http://w', fetch: vi.fn() });
    // @ts-expect-error — extras is not on AnthropicLike but rides through.
    expect(wrapped.extras.baseURL).toBe('https://api.anthropic.com');
  });

  it('propagates upstream messages.create errors', async () => {
    const upstream = new Error('rate limited');
    const wrapped = clavenarWrap(
      { messages: { create: async () => { throw upstream; } } },
      { endpoint: 'http://w', fetch: vi.fn() },
    );
    await expect(wrapped.messages.create({})).rejects.toBe(upstream);
  });

  it('handles a message with missing content array', async () => {
    const message = { ...makeMessage([]) } as AnthropicMessage;
    delete (message as unknown as { content?: unknown }).content;
    const fetch = vi.fn();
    const wrapped = clavenarWrap(
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
    const wrapped = clavenarWrap(
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

describe('clavenarWrap (429 rate-limit verdicts)', () => {
  function rateLimitResponse(extra: Record<string, unknown> = {}): Response {
    return new Response(
      JSON.stringify({
        verdict: 'rate_limited',
        layer: 'proxy',
        error: 'rate_limited',
        reasons: ['agent request velocity exceeded'],
        retry_after_secs: 30,
        ...extra,
      }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    );
  }
  const message = makeMessage([
    { type: 'tool_use', id: 'toolu_x', name: 'fetch_user', input: {} },
  ]);

  it('enforce: throws ClavenarRateLimited carrying retry_after_secs', async () => {
    const fetch = vi.fn().mockResolvedValue(rateLimitResponse());
    const wrapped = clavenarWrap(
      { messages: { create: async () => message } },
      { endpoint: 'http://w', fetch },
    );
    try {
      await wrapped.messages.create({});
      expect.fail('expected clavenarWrap to throw ClavenarRateLimited');
    } catch (e) {
      expect(e).toBeInstanceOf(ClavenarRateLimited);
      const limited = e as ClavenarRateLimited;
      expect(limited.toolName).toBe('fetch_user');
      expect(limited.code).toBe('rate_limited');
      expect(limited.retryAfterSecs).toBe(30);
      expect(limited.layer).toBe('proxy');
    }
  });

  it('enforce: quota_exceeded surfaces as code without retryAfterSecs', async () => {
    const fetch = vi.fn().mockResolvedValue(
      rateLimitResponse({ verdict: 'quota_exceeded', error: 'quota_exceeded', retry_after_secs: undefined }),
    );
    const wrapped = clavenarWrap(
      { messages: { create: async () => message } },
      { endpoint: 'http://w', fetch },
    );
    await expect(wrapped.messages.create({})).rejects.toMatchObject({
      name: 'ClavenarRateLimited',
      code: 'quota_exceeded',
      retryAfterSecs: undefined,
    });
  });

  it('observe: no throw, verdict surfaces via onVerdict', async () => {
    const fetch = vi.fn().mockResolvedValue(rateLimitResponse());
    const verdicts: ClavenarVerdict[] = [];
    const wrapped = clavenarWrap(
      { messages: { create: async () => message } },
      {
        endpoint: 'http://w',
        fetch,
        mode: 'observe',
        onVerdict: (v) => {
          verdicts.push(v);
        },
      },
    );
    const result = await wrapped.messages.create({});
    expect(result).toBe(message);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.kind).toBe('rate_limited');
  });
});

describe('clavenarWrap (enforce-mode semantics — default)', () => {
  it('throws ClavenarDenied with parsed payload on first deny', async () => {
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_x', name: 'drop_table', input: { table: 'users' } },
    ]);
    const fetch = vi.fn().mockResolvedValue(denyResponse('drop_table'));
    const wrapped = clavenarWrap(
      { messages: { create: async () => message } },
      { endpoint: 'http://w', fetch },
    );
    try {
      await wrapped.messages.create({});
      expect.fail('expected clavenarWrap to throw ClavenarDenied');
    } catch (e) {
      expect(e).toBeInstanceOf(ClavenarDenied);
      const denied = e as ClavenarDenied;
      expect(denied.toolName).toBe('drop_table');
      expect(denied.reasons).toEqual(['policy: drop_table blocked']);
      expect(denied.intentCategory).toBe('PolicyDeny');
      expect(denied.reviewReasons).toEqual([]);
    }
  });

  it('inspects all tool_use blocks in parallel; first deny in order throws', async () => {
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_a', name: 'drop_table', input: {} },
      { type: 'tool_use', id: 'toolu_b', name: 'fetch_user', input: {} },
    ]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(denyResponse('drop_table'))
      .mockResolvedValueOnce(allowResponse());
    const wrapped = clavenarWrap(
      { messages: { create: async () => message } },
      { endpoint: 'http://w', fetch },
    );
    try {
      await wrapped.messages.create({});
      expect.fail('expected ClavenarDenied');
    } catch (e) {
      expect(e).toBeInstanceOf(ClavenarDenied);
      // First deny in submission order — drop_table, not the
      // second block — is the one that throws.
      expect((e as ClavenarDenied).toolName).toBe('drop_table');
    }
    // Both inspections fire concurrently — partner pays one clavenar
    // round-trip of latency, not two.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fires onVerdict for the denied block BEFORE throwing', async () => {
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_x', name: 'drop_table', input: {} },
    ]);
    const fetch = vi.fn().mockResolvedValue(denyResponse('drop_table'));
    const verdicts: ClavenarVerdict[] = [];
    const wrapped = clavenarWrap(
      { messages: { create: async () => message } },
      {
        endpoint: 'http://w',
        fetch,
        onVerdict: (v) => {
          verdicts.push(v);
        },
      },
    );
    await expect(wrapped.messages.create({})).rejects.toBeInstanceOf(ClavenarDenied);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.kind).toBe('deny');
  });

  it('allow-only messages return normally in enforce mode', async () => {
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_a', name: 'fetch_user', input: {} },
    ]);
    const fetch = vi.fn().mockResolvedValue(allowResponse());
    const wrapped = clavenarWrap(
      { messages: { create: async () => message } },
      { endpoint: 'http://w', fetch },
    );
    await expect(wrapped.messages.create({})).resolves.toBe(message);
  });

});

describe('clavenarWrap (parallel inspection)', () => {
  it('kicks off every tool_use inspection before any resolves', async () => {
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_a', name: 'fetch_user', input: { id: 1 } },
      { type: 'tool_use', id: 'toolu_b', name: 'fetch_org', input: { id: 2 } },
      { type: 'tool_use', id: 'toolu_c', name: 'fetch_log', input: { id: 3 } },
    ]);
    // Deferred resolvers so we can prove all three fetches were
    // kicked off before any returned — i.e. they're concurrent, not
    // serial. If wrap were still serial, fetch would only be called
    // once until we resolve the first deferred.
    const deferreds: Array<{ resolve: (r: Response) => void; promise: Promise<Response> }> = [];
    for (let i = 0; i < 3; i++) {
      let resolve!: (r: Response) => void;
      const promise = new Promise<Response>((r) => {
        resolve = r;
      });
      deferreds.push({ resolve, promise });
    }
    const fetch = vi
      .fn()
      .mockReturnValueOnce(deferreds[0]!.promise)
      .mockReturnValueOnce(deferreds[1]!.promise)
      .mockReturnValueOnce(deferreds[2]!.promise);
    const wrapped = clavenarWrap(
      { messages: { create: async () => message } },
      { endpoint: 'http://w', fetch },
    );
    const callPromise = wrapped.messages.create({});
    // Let the wrap's Promise.all kick off all inspections.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(3);
    // Now release in any order; the call should resolve.
    deferreds[2]!.resolve(allowResponse());
    deferreds[0]!.resolve(allowResponse());
    deferreds[1]!.resolve(allowResponse());
    await callPromise;
  });

  it('surfaces correlationId from response header onto ClavenarDenied', async () => {
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_x', name: 'drop_table', input: {} },
    ]);
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'security_violation',
          reasons: ['policy: drop_table blocked'],
          review_reasons: [],
          intent_category: 'PolicyDeny',
        }),
        {
          status: 403,
          headers: {
            'Content-Type': 'application/json',
            'X-Clavenar-Correlation-Id': 'corr_xyz_123',
          },
        },
      ),
    );
    const wrapped = clavenarWrap(
      { messages: { create: async () => message } },
      { endpoint: 'http://w', fetch },
    );
    try {
      await wrapped.messages.create({});
      expect.fail('expected ClavenarDenied');
    } catch (e) {
      expect(e).toBeInstanceOf(ClavenarDenied);
      expect((e as ClavenarDenied).correlationId).toBe('corr_xyz_123');
    }
  });
});

describe('clavenarWrap (pending verdict throws ClavenarPending)', () => {
  // Yellow-tier wire support landed in clavenar-lite week-3-Mon; the
  // SDK side here converts the verdict to a ClavenarPending throw and
  // pre-binds the poll callback so `await e.resolve()` works on the
  // catch-side.
  it('converts pending verdict to ClavenarPending in enforce mode', async () => {
    vi.resetModules();
    vi.doMock('../src/transport.js', () => ({
      inspectToolUse: async () => ({
        kind: 'pending',
        correlationId: 'corr_e2e_123',
        reviewReasons: ['Review: Wire transfers require human approval before execution.'],
      }),
      pollPendingOnce: async () => ({
        correlation_id: 'corr_e2e_123',
        agent_id: 'a',
        tool_type: 'wire_transfer',
        method: 'call_tool',
        review_reasons: ['Review: Wire transfers require human approval before execution.'],
        requested_at: '2026-05-12T10:00:00Z',
        decided_at: '2026-05-12T10:01:00Z',
        decision: 'allow' as const,
        decider_note: null,
      }),
      joinUrl: (a: string, b: string) => `${a}/${b}`,
    }));
    const { clavenarWrap: wrapMocked, ClavenarPending: PendingMocked } = await import(
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
      expect.fail('expected ClavenarPending');
    } catch (e) {
      expect(e).toBeInstanceOf(PendingMocked);
      const p = e as InstanceType<typeof PendingMocked>;
      expect(p.toolName).toBe('wire_transfer');
      expect(p.correlationId).toBe('corr_e2e_123');
      expect(p.reviewReasons).toEqual([
        'Review: Wire transfers require human approval before execution.',
      ]);
      // Pre-bound resolve() against the mocked poll returns void on allow.
      await expect(p.resolve({ pollIntervalMs: 1, timeoutMs: 100 })).resolves.toBeUndefined();
    }
    vi.doUnmock('../src/transport.js');
    vi.resetModules();
  });
});

describe('clavenarWrap (observe-mode transport-error resilience)', () => {
  it('observe mode: clavenar down → response passes through, onPolicyError fires', async () => {
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_x', name: 'fetch_user', input: { id: 1 } },
    ]);
    // Reject every fetch — clavenar-lite is unreachable / down.
    const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const create = vi.fn().mockResolvedValue(message);
    const policyErrors: Array<{ tool: string; status?: number }> = [];

    const wrapped = clavenarWrap(
      { messages: { create } },
      {
        endpoint: 'http://w',
        fetch,
        mode: 'observe',
        retry: { maxAttempts: 1, baseDelayMs: 0 },
        onPolicyError: (e, ctx) => {
          policyErrors.push({ tool: ctx.toolName, status: e.status });
        },
      },
    );

    // No throw despite clavenar being unreachable — observe contract.
    const result = await wrapped.messages.create({});
    expect(result).toBe(message);
    expect(policyErrors).toEqual([{ tool: 'fetch_user', status: undefined }]);
  });

  it('observe mode: one transport failure doesn\'t poison other inspections', async () => {
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_a', name: 'fetch_user', input: { id: 1 } },
      { type: 'tool_use', id: 'toolu_b', name: 'delete_user', input: { id: 1 } },
    ]);
    // First inspect succeeds, second fails — observe should fire
    // onVerdict for the first and onPolicyError for the second.
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(allowResponse())
      .mockRejectedValueOnce(new TypeError('connection refused'));
    const create = vi.fn().mockResolvedValue(message);
    const verdicts: string[] = [];
    const policyErrors: string[] = [];

    const wrapped = clavenarWrap(
      { messages: { create } },
      {
        endpoint: 'http://w',
        fetch,
        mode: 'observe',
        retry: { maxAttempts: 1, baseDelayMs: 0 },
        onVerdict: (_v, ctx) => {
          verdicts.push(ctx.toolName);
        },
        onPolicyError: (_e, ctx) => {
          policyErrors.push(ctx.toolName);
        },
      },
    );

    await wrapped.messages.create({});

    expect(verdicts).toEqual(['fetch_user']);
    expect(policyErrors).toEqual(['delete_user']);
  });

  it('enforce mode (default): transport failure still throws ClavenarTransportError', async () => {
    const message = makeMessage([
      { type: 'tool_use', id: 'toolu_x', name: 'fetch_user', input: { id: 1 } },
    ]);
    const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const create = vi.fn().mockResolvedValue(message);
    const policyErrors: number[] = [];

    const wrapped = clavenarWrap(
      { messages: { create } },
      {
        endpoint: 'http://w',
        fetch,
        retry: { maxAttempts: 1, baseDelayMs: 0 },
        onPolicyError: () => {
          policyErrors.push(1);
        },
      },
    );

    await expect(wrapped.messages.create({})).rejects.toBeInstanceOf(ClavenarTransportError);
    // Enforce mode never invokes onPolicyError — the throw is the
    // signal, and the callback exists for observe consumers only.
    expect(policyErrors).toEqual([]);
  });
});
