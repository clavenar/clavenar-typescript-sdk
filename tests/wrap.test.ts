import { describe, expect, it } from 'vitest';
import { wardenWrap, WardenConfigError } from '../src/index.js';

const fakeClient = {
  messages: { create: async () => ({ id: 'msg_1', type: 'message' as const, role: 'assistant' as const, content: [], stop_reason: null }) },
};

describe('wardenWrap (week 1 stub)', () => {
  it('rejects empty endpoint', () => {
    expect(() => wardenWrap(fakeClient, { endpoint: '' })).toThrow(WardenConfigError);
  });

  it('rejects malformed endpoint', () => {
    expect(() => wardenWrap(fakeClient, { endpoint: 'not-a-url' })).toThrow(WardenConfigError);
  });

  it('rejects clients without messages.create', () => {
    expect(() => wardenWrap({} as never, { endpoint: 'http://localhost:8088' })).toThrow(WardenConfigError);
  });

  it('accepts a valid endpoint + Anthropic-like client', () => {
    const wrapped = wardenWrap(fakeClient, { endpoint: 'http://localhost:8088' });
    expect(wrapped).toBe(fakeClient);
  });

  it('rejects negative timeout', () => {
    expect(() =>
      wardenWrap(fakeClient, { endpoint: 'http://localhost:8088', timeoutMs: -1 })
    ).toThrow(WardenConfigError);
  });
});
