import { describe, expect, it, vi } from 'vitest';
import { inspectToolUse, joinUrl } from '../src/transport.js';
import { WardenTransportError } from '../src/errors.js';
import type { AnthropicToolUseBlock } from '../src/anthropic.js';
import type { WardenDenyResponse } from '../src/types.js';

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
    const denyBody: WardenDenyResponse = {
      error: 'security_violation',
      reasons: ['policy: delete_user blocked'],
      review_reasons: [],
      intent_category: 'PolicyDeny',
    };
    const fetch = vi.fn().mockResolvedValue(fakeResponse(403, denyBody));
    const verdict = await inspectToolUse(toolUse, { endpoint: 'http://w', fetch });
    expect(verdict).toEqual({ kind: 'deny', payload: denyBody });
  });

  it('throws WardenTransportError on 401', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(401, 'missing or invalid bearer token'));
    await expect(inspectToolUse(toolUse, { endpoint: 'http://w', fetch })).rejects.toMatchObject({
      name: 'WardenTransportError',
      status: 401,
    });
  });

  it('throws WardenTransportError on 502', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(502, 'upstream unreachable'));
    await expect(inspectToolUse(toolUse, { endpoint: 'http://w', fetch })).rejects.toBeInstanceOf(
      WardenTransportError,
    );
  });

  it('throws WardenTransportError on malformed 403 body', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(403, { wrong: 'shape' }));
    await expect(inspectToolUse(toolUse, { endpoint: 'http://w', fetch })).rejects.toMatchObject({
      name: 'WardenTransportError',
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
      name: 'WardenTransportError',
      message: expect.stringContaining('timed out after 5ms'),
    });
  });
});

describe('joinUrl', () => {
  it('joins clean base + path', () => {
    expect(joinUrl('http://x', '/mcp')).toBe('http://x/mcp');
  });
  it('preserves base path segment', () => {
    expect(joinUrl('https://gw.example.com/warden', '/mcp')).toBe(
      'https://gw.example.com/warden/mcp',
    );
  });
  it('drops trailing slash on base', () => {
    expect(joinUrl('http://x/', '/mcp')).toBe('http://x/mcp');
  });
  it('handles missing leading slash on path', () => {
    expect(joinUrl('http://x', 'mcp')).toBe('http://x/mcp');
  });
});
