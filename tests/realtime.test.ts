import { describe, expect, it, vi } from 'vitest';
import {
  inspectRealtimeFunctionCall,
  isRealtimeFunctionCallDone,
  normalizeRealtimeFunctionCall,
} from '../src/realtime.js';
import type {
  OpenAIRealtimeFunctionCallDone,
  OpenAIRealtimeServerEvent,
} from '../src/realtime.js';
import type { WardenDenyResponse } from '../src/types.js';

function fakeResponse(status: number, body?: unknown): Response {
  const init: ResponseInit = { status };
  if (body === undefined) return new Response(null, init);
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  });
}

const done: OpenAIRealtimeFunctionCallDone = {
  type: 'response.function_call_arguments.done',
  response_id: 'resp_1',
  item_id: 'item_1',
  output_index: 0,
  call_id: 'call_abc',
  name: 'wire_transfer',
  arguments: JSON.stringify({ to: 'acct-9', amount: 250 }),
};

describe('isRealtimeFunctionCallDone', () => {
  it('matches the terminal arg event', () => {
    expect(isRealtimeFunctionCallDone(done)).toBe(true);
  });

  it('rejects unrelated event types', () => {
    const e: OpenAIRealtimeServerEvent = { type: 'response.audio.delta', delta: 'aGVsbG8=' };
    expect(isRealtimeFunctionCallDone(e)).toBe(false);
  });

  it('rejects the in-flight delta event', () => {
    const e: OpenAIRealtimeServerEvent = {
      type: 'response.function_call_arguments.delta',
      call_id: 'call_abc',
      delta: '{"to":"ac',
    };
    expect(isRealtimeFunctionCallDone(e)).toBe(false);
  });

  it('rejects malformed done events missing required fields', () => {
    const e: OpenAIRealtimeServerEvent = {
      type: 'response.function_call_arguments.done',
      // missing call_id, name, arguments
    };
    expect(isRealtimeFunctionCallDone(e)).toBe(false);
  });
});

describe('normalizeRealtimeFunctionCall', () => {
  it('parses JSON-encoded arguments into NormalizedToolCall', () => {
    const n = normalizeRealtimeFunctionCall(done);
    expect(n).toEqual({
      id: 'call_abc',
      name: 'wire_transfer',
      input: { to: 'acct-9', amount: 250 },
    });
  });

  it('falls back to the raw string when arguments are malformed JSON', () => {
    const broken: OpenAIRealtimeFunctionCallDone = { ...done, arguments: 'not-json' };
    const n = normalizeRealtimeFunctionCall(broken);
    expect(n).toEqual({
      id: 'call_abc',
      name: 'wire_transfer',
      input: 'not-json',
    });
  });
});

describe('inspectRealtimeFunctionCall', () => {
  it('returns allow on 200', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(200, {}));
    const verdict = await inspectRealtimeFunctionCall(done, { endpoint: 'http://w', fetch });
    expect(verdict).toEqual({ kind: 'allow' });
  });

  it('forwards deny payload on 403', async () => {
    const denyBody: WardenDenyResponse = {
      error: 'security_violation',
      reasons: ['policy: wire_transfer requires approval'],
      review_reasons: [],
      intent_category: 'PolicyDeny',
    };
    const fetch = vi.fn().mockResolvedValue(fakeResponse(403, denyBody));
    const verdict = await inspectRealtimeFunctionCall(done, { endpoint: 'http://w', fetch });
    expect(verdict).toEqual({ kind: 'deny', payload: denyBody });
  });

  it('sends the call_id as the JSON-RPC envelope id', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeResponse(200, {}));
    await inspectRealtimeFunctionCall(done, { endpoint: 'http://w', fetch });
    const sent = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(sent.id).toBe('call_abc');
    expect(sent.params.name).toBe('wire_transfer');
    expect(sent.params.arguments).toEqual({ to: 'acct-9', amount: 250 });
  });
});
