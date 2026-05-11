import { describe, expect, it, vi } from 'vitest';
import { WardenDenied, WardenPending, WardenTransportError } from '../src/errors.js';
import type { WardenPendingView } from '../src/types.js';

function view(
  decision: 'allow' | 'deny' | null,
  deciderNote: string | null = null,
): WardenPendingView {
  return {
    correlation_id: 'corr_x',
    agent_id: 'agent-1',
    tool_type: 'wire_transfer',
    method: 'call_tool',
    review_reasons: ['Review: Wire transfers require human approval before execution.'],
    requested_at: '2026-05-12T10:00:00Z',
    decided_at: decision ? '2026-05-12T10:01:00Z' : null,
    decision,
    decider_note: deciderNote,
  };
}

function pending(pollOnce: () => Promise<WardenPendingView>): WardenPending {
  return new WardenPending({
    toolName: 'wire_transfer',
    correlationId: 'corr_x',
    reviewReasons: ['Review: Wire transfers require human approval before execution.'],
    pollOnce,
  });
}

describe('WardenPending.resolve', () => {
  it('returns void on allow without polling more than needed', async () => {
    const pollOnce = vi.fn().mockResolvedValueOnce(view('allow', 'ok by sec'));
    const p = pending(pollOnce);
    await expect(p.resolve({ pollIntervalMs: 1, timeoutMs: 100 })).resolves.toBeUndefined();
    expect(pollOnce).toHaveBeenCalledTimes(1);
  });

  it('polls until decision flips, then resolves', async () => {
    const pollOnce = vi
      .fn()
      .mockResolvedValueOnce(view(null))
      .mockResolvedValueOnce(view(null))
      .mockResolvedValueOnce(view('allow'));
    const p = pending(pollOnce);
    await expect(p.resolve({ pollIntervalMs: 1, timeoutMs: 1000 })).resolves.toBeUndefined();
    expect(pollOnce).toHaveBeenCalledTimes(3);
  });

  it('throws WardenDenied on a deny decision with the decider note as the reason', async () => {
    const pollOnce = vi.fn().mockResolvedValueOnce(view('deny', 'too risky'));
    const p = pending(pollOnce);
    try {
      await p.resolve({ pollIntervalMs: 1, timeoutMs: 100 });
      expect.fail('expected WardenDenied');
    } catch (e) {
      expect(e).toBeInstanceOf(WardenDenied);
      const d = e as WardenDenied;
      expect(d.toolName).toBe('wire_transfer');
      expect(d.intentCategory).toBe('PendingDenied');
      expect(d.reasons).toEqual(['too risky']);
      expect(d.reviewReasons).toEqual([
        'Review: Wire transfers require human approval before execution.',
      ]);
      expect(d.correlationId).toBe('corr_x');
    }
  });

  it('falls back to a generic reason when decider_note is absent', async () => {
    const pollOnce = vi.fn().mockResolvedValueOnce(view('deny', null));
    const p = pending(pollOnce);
    try {
      await p.resolve({ pollIntervalMs: 1, timeoutMs: 100 });
      expect.fail('expected WardenDenied');
    } catch (e) {
      expect((e as WardenDenied).reasons).toEqual(['operator denied']);
    }
  });

  it('throws WardenTransportError after timeout when decision never lands', async () => {
    const pollOnce = vi.fn().mockResolvedValue(view(null));
    const p = pending(pollOnce);
    await expect(p.resolve({ pollIntervalMs: 5, timeoutMs: 30 })).rejects.toMatchObject({
      name: 'WardenTransportError',
    });
    // Should have polled at least once but timed out before flipping.
    expect(pollOnce).toHaveBeenCalled();
  });

  it('swallows transient 5xx between polls and continues', async () => {
    const transient = new WardenTransportError('upstream blip', 503);
    const pollOnce = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(view('allow'));
    const p = pending(pollOnce);
    await expect(p.resolve({ pollIntervalMs: 1, timeoutMs: 500 })).resolves.toBeUndefined();
    expect(pollOnce).toHaveBeenCalledTimes(2);
  });

  it('surfaces a 404 from polling immediately (pending vanished)', async () => {
    const fatal = new WardenTransportError('no such pending', 404);
    const pollOnce = vi.fn().mockRejectedValueOnce(fatal);
    const p = pending(pollOnce);
    await expect(p.resolve({ pollIntervalMs: 1, timeoutMs: 500 })).rejects.toMatchObject({
      name: 'WardenTransportError',
      status: 404,
    });
  });

  it('surfaces a 401 from polling immediately (auth misconfig)', async () => {
    const fatal = new WardenTransportError('bad token', 401);
    const pollOnce = vi.fn().mockRejectedValueOnce(fatal);
    const p = pending(pollOnce);
    await expect(p.resolve({ pollIntervalMs: 1, timeoutMs: 500 })).rejects.toMatchObject({
      name: 'WardenTransportError',
      status: 401,
    });
  });

  it('rejects zero/negative pollIntervalMs eagerly', async () => {
    const p = pending(vi.fn());
    await expect(p.resolve({ pollIntervalMs: 0, timeoutMs: 100 })).rejects.toMatchObject({
      name: 'WardenTransportError',
    });
  });

  it('rejects zero/negative timeoutMs eagerly', async () => {
    const p = pending(vi.fn());
    await expect(p.resolve({ pollIntervalMs: 10, timeoutMs: 0 })).rejects.toMatchObject({
      name: 'WardenTransportError',
    });
  });
});
