import { describe, expect, it, vi } from 'vitest';
import { inspectToolUse, joinUrl, pollPendingOnce } from '../src/transport.js';
import { ClavenarTransportError } from '../src/errors.js';
import type { AnthropicToolUseBlock } from '../src/anthropic.js';
import type { ClavenarDenyResponse } from '../src/types.js';

const toolUse: AnthropicToolUseBlock = {
  type: 'tool_use',
  id: 'toolu_demo',
  name: 'delete_user',
  input: { user_id: 42 },
};

function fakeResponse(status: number, body?: unknown): Response {
  const init: ResponseInit = { status };
  if (body === undefined) return new Response(null, init);
  if (typeof body === 'string') return new Response(body, init);
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('inspectToolUse', () => {
  it('returns allow on 200', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(200, { id: 'msg' }));
    const verdict = await inspectToolUse(toolUse, { endpoint: 'http://w', fetch });
    expect(verdict).toEqual({ kind: 'allow' });
  });

  it('returns deny + parsed payload on 403', async () => {
    const denyBody: ClavenarDenyResponse = {
      error: 'security_violation',
      reasons: ['policy: delete_user blocked'],
      review_reasons: [],
      intent_category: 'PolicyDeny',
    };
    const fetch = vi.fn().mockResolvedValue(fakeResponse(403, denyBody));
    const verdict = await inspectToolUse(toolUse, { endpoint: 'http://w', fetch });
    expect(verdict).toEqual({ kind: 'deny', payload: denyBody });
  });

  it('throws ClavenarTransportError on 401', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(401, 'missing or invalid bearer token'));
    await expect(inspectToolUse(toolUse, { endpoint: 'http://w', fetch })).rejects.toMatchObject({
      name: 'ClavenarTransportError',
      status: 401,
    });
  });

  it('throws ClavenarTransportError on 502', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(502, 'upstream unreachable'));
    await expect(inspectToolUse(toolUse, { endpoint: 'http://w', fetch })).rejects.toBeInstanceOf(
      ClavenarTransportError,
    );
  });

  it('throws ClavenarTransportError on malformed 403 body', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(403, { wrong: 'shape' }));
    await expect(inspectToolUse(toolUse, { endpoint: 'http://w', fetch })).rejects.toMatchObject({
      name: 'ClavenarTransportError',
      status: 403,
    });
  });

  it('sends bearer header when token set', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(200));
    await inspectToolUse(toolUse, { endpoint: 'http://w', token: 's3cret', fetch });
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer s3cret');
  });

  it('omits bearer header when token unset', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(200));
    await inspectToolUse(toolUse, { endpoint: 'http://w', fetch });
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('sends correctly-shaped JSON-RPC body', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(200));
    await inspectToolUse(toolUse, { endpoint: 'http://w', fetch });
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'delete_user', arguments: { user_id: 42 } },
      id: 'toolu_demo',
    });
  });

  it('targets {endpoint}/mcp', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(200));
    await inspectToolUse(toolUse, { endpoint: 'http://w:8088', fetch });
    expect(fetch.mock.calls[0]?.[0]).toBe('http://w:8088/mcp');
  });

  it('handles trailing slash on endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(200));
    await inspectToolUse(toolUse, { endpoint: 'http://w:8088/', fetch });
    expect(fetch.mock.calls[0]?.[0]).toBe('http://w:8088/mcp');
  });

  it('throws on AbortError (timeout)', async () => {
    const fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    });
    await expect(
      inspectToolUse(toolUse, { endpoint: 'http://w', timeoutMs: 5, fetch }),
    ).rejects.toMatchObject({
      name: 'ClavenarTransportError',
      message: expect.stringContaining('timed out after 5ms'),
    });
  });
});

describe('inspectToolUse (retry on transient errors)', () => {
  it('retries a 502 once and returns the eventual 200', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(502, 'bad gateway'))
      .mockResolvedValueOnce(fakeResponse(200, { ok: true }));
    const verdict = await inspectToolUse(toolUse, {
      endpoint: 'http://w',
      fetch,
      retry: { maxAttempts: 3, baseDelayMs: 1 },
    });
    expect(verdict.kind).toBe('allow');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries network-layer fetch rejections', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(fakeResponse(200));
    const verdict = await inspectToolUse(toolUse, {
      endpoint: 'http://w',
      fetch,
      retry: { maxAttempts: 3, baseDelayMs: 1 },
    });
    expect(verdict.kind).toBe('allow');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('exhausts after maxAttempts on persistent 503 and throws the last error', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(503, 'unavailable'));
    await expect(
      inspectToolUse(toolUse, {
        endpoint: 'http://w',
        fetch,
        retry: { maxAttempts: 3, baseDelayMs: 1 },
      }),
    ).rejects.toMatchObject({ name: 'ClavenarTransportError', status: 503 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry 401 — config errors are not transient', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(401, 'bad bearer'));
    await expect(
      inspectToolUse(toolUse, {
        endpoint: 'http://w',
        fetch,
        retry: { maxAttempts: 5, baseDelayMs: 1 },
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry 403 — that is a verdict, not a failure', async () => {
    const denyBody = {
      error: 'security_violation',
      reasons: ['policy: x'],
      review_reasons: [],
      intent_category: 'PolicyDeny',
    };
    const fetch = vi.fn().mockResolvedValue(fakeResponse(403, denyBody));
    const verdict = await inspectToolUse(toolUse, {
      endpoint: 'http://w',
      fetch,
      retry: { maxAttempts: 5, baseDelayMs: 1 },
    });
    expect(verdict.kind).toBe('deny');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('respects retry.maxAttempts=1 (disable retries)', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(502));
    await expect(
      inspectToolUse(toolUse, {
        endpoint: 'http://w',
        fetch,
        retry: { maxAttempts: 1, baseDelayMs: 1 },
      }),
    ).rejects.toBeInstanceOf(ClavenarTransportError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('inspectToolUse (correlation id)', () => {
  function fakeResponseWithHeaders(
    status: number,
    body: unknown,
    headers: Record<string, string>,
  ): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  it('surfaces X-Clavenar-Correlation-Id on an allow verdict', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        fakeResponseWithHeaders(200, { ok: true }, { 'X-Clavenar-Correlation-Id': 'corr_a' }),
      );
    const verdict = await inspectToolUse(toolUse, { endpoint: 'http://w', fetch });
    expect(verdict).toEqual({ kind: 'allow', correlationId: 'corr_a' });
  });

  it('surfaces X-Clavenar-Correlation-Id on a deny verdict', async () => {
    const fetch = vi.fn().mockResolvedValue(
      fakeResponseWithHeaders(
        403,
        {
          error: 'security_violation',
          reasons: ['policy: drop_table blocked'],
          review_reasons: [],
          intent_category: 'PolicyDeny',
        },
        { 'X-Clavenar-Correlation-Id': 'corr_b' },
      ),
    );
    const verdict = await inspectToolUse(toolUse, { endpoint: 'http://w', fetch });
    expect(verdict.kind).toBe('deny');
    if (verdict.kind === 'deny') {
      expect(verdict.correlationId).toBe('corr_b');
    }
  });

  it('omits correlationId when header absent', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(200, {}));
    const verdict = await inspectToolUse(toolUse, { endpoint: 'http://w', fetch });
    expect(verdict).toEqual({ kind: 'allow' });
  });
});

describe('inspectToolUse (202 pending)', () => {
  function pendingResponse(headers: Record<string, string> = {}): Response {
    return new Response(
      JSON.stringify({
        status: 'pending',
        correlation_id: 'corr_pending_42',
        review_reasons: ['Review: Wire transfers require human approval before execution.'],
      }),
      { status: 202, headers: { 'Content-Type': 'application/json', ...headers } },
    );
  }

  it('returns pending verdict with reviewReasons + correlationId from header', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(pendingResponse({ 'X-Clavenar-Correlation-Id': 'corr_pending_42' }));
    const verdict = await inspectToolUse(toolUse, { endpoint: 'http://w', fetch });
    expect(verdict).toEqual({
      kind: 'pending',
      correlationId: 'corr_pending_42',
      reviewReasons: ['Review: Wire transfers require human approval before execution.'],
    });
  });

  it('falls back to body correlation_id when header is absent', async () => {
    const fetch = vi.fn().mockResolvedValue(pendingResponse());
    const verdict = await inspectToolUse(toolUse, { endpoint: 'http://w', fetch });
    expect(verdict.kind).toBe('pending');
    if (verdict.kind === 'pending') {
      expect(verdict.correlationId).toBe('corr_pending_42');
    }
  });

  it('throws when 202 body is the wrong shape', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ wrong: 'shape' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(inspectToolUse(toolUse, { endpoint: 'http://w', fetch })).rejects.toMatchObject({
      name: 'ClavenarTransportError',
      status: 202,
    });
  });

  it('throws when 202 is unparseable', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('not json', { status: 202 }));
    await expect(inspectToolUse(toolUse, { endpoint: 'http://w', fetch })).rejects.toMatchObject({
      name: 'ClavenarTransportError',
      status: 202,
    });
  });
});

describe('pollPendingOnce', () => {
  function pendingView(decision: 'allow' | 'deny' | null, deciderNote: string | null = null): Response {
    return new Response(
      JSON.stringify({
        correlation_id: 'corr_p',
        agent_id: 'agent-1',
        tool_type: 'wire_transfer',
        method: 'call_tool',
        review_reasons: ['Review: Wire transfers require human approval before execution.'],
        requested_at: '2026-05-12T10:00:00Z',
        decided_at: decision ? '2026-05-12T10:01:00Z' : null,
        decision,
        decider_note: deciderNote,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  it('returns the parsed view on 200', async () => {
    const fetch = vi.fn().mockResolvedValue(pendingView(null));
    const view = await pollPendingOnce('corr_p', { endpoint: 'http://w', fetch });
    expect(view.decision).toBeNull();
    expect(view.tool_type).toBe('wire_transfer');
  });

  it('parses an allow decision with a decider_note', async () => {
    const fetch = vi.fn().mockResolvedValue(pendingView('allow', 'ok by sec'));
    const view = await pollPendingOnce('corr_p', { endpoint: 'http://w', fetch });
    expect(view.decision).toBe('allow');
    expect(view.decider_note).toBe('ok by sec');
  });

  it('targets GET /pending/{correlation_id}', async () => {
    const fetch = vi.fn().mockResolvedValue(pendingView(null));
    await pollPendingOnce('corr_p', { endpoint: 'http://w:8088', fetch });
    expect(fetch.mock.calls[0]?.[0]).toBe('http://w:8088/pending/corr_p');
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('GET');
  });

  it('forwards the bearer token when configured', async () => {
    const fetch = vi.fn().mockResolvedValue(pendingView(null));
    await pollPendingOnce('corr_p', { endpoint: 'http://w', token: 's3cret', fetch });
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer s3cret');
  });

  it('throws on a 404 with the status surfaced', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('no such pending', { status: 404 }));
    await expect(pollPendingOnce('corr_p', { endpoint: 'http://w', fetch })).rejects.toMatchObject({
      name: 'ClavenarTransportError',
      status: 404,
    });
  });

  it('throws on a 401 with the status surfaced', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('bad token', { status: 401 }));
    await expect(pollPendingOnce('corr_p', { endpoint: 'http://w', fetch })).rejects.toMatchObject({
      name: 'ClavenarTransportError',
      status: 401,
    });
  });

  it('url-encodes the correlation id', async () => {
    const fetch = vi.fn().mockResolvedValue(pendingView(null));
    await pollPendingOnce('a/b c', { endpoint: 'http://w', fetch });
    expect(fetch.mock.calls[0]?.[0]).toBe('http://w/pending/a%2Fb%20c');
  });
});

describe('joinUrl', () => {
  it('joins clean base + path', () => {
    expect(joinUrl('http://x', '/mcp')).toBe('http://x/mcp');
  });
  it('preserves base path segment', () => {
    expect(joinUrl('https://gw.example.com/clavenar', '/mcp')).toBe(
      'https://gw.example.com/clavenar/mcp',
    );
  });
  it('drops trailing slash on base', () => {
    expect(joinUrl('http://x/', '/mcp')).toBe('http://x/mcp');
  });
  it('handles missing leading slash on path', () => {
    expect(joinUrl('http://x', 'mcp')).toBe('http://x/mcp');
  });
});
