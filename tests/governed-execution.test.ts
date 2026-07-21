import { describe, expect, it, vi } from 'vitest';

import {
  executePreparedTool,
  type ExecutionCompletion,
  type ExecutionIntent,
  type PreparedToolRequest,
} from '../src/index.js';

const prepared: PreparedToolRequest = {
  idempotencyId: 'cfcc8767-4c73-41cc-8ece-b855863924c4',
  name: 'payments.transfer',
  arguments: { amount: 100 },
};

function authorization() {
  return {
    authorization: {
      contract: 'clavenar.execution/v1',
      stage: 'authorization',
      authorization_id: '354c33ed-e5d3-4af7-a1b8-b009d50b0bc5',
      idempotency_id: prepared.idempotencyId,
      correlation_id: 'c1a28e4c-a17d-5b3d-884b-e5b627f762c2',
      agent_id: 'payments-agent',
      agent_spiffe: 'spiffe://clavenar.local/tenant/acme/agent/payments-agent/instance/one',
      tenant: 'acme',
      credential_fingerprint:
        'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      method: 'tools/call',
      tool_name: prepared.name,
      execution_payload: {
        jsonrpc: '2.0',
        id: prepared.idempotencyId,
        method: 'tools/call',
        params: { name: prepared.name, arguments: prepared.arguments },
      },
      payload_sha256:
        'sha256:269123e546c75ec2df26ce4a52baeab92e58afdfabcb111c3e9069a37f78f1c5',
      decision_principal: { subject: 'system:policy-brain' },
      modification_diff: null,
      policy_bundle: { schema_version: 1 },
      brain_version: 'brain-2026-07-20',
      brain_evidence_sha256:
        'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    },
    identity_signature: { algorithm: 'Ed25519', key_id: 'identity:v1', value: 'signed' },
  };
}

describe('governed execution', () => {
  it('uses the decision selector, commits intent before one effect, and retains the actual result', async () => {
    const order: string[] = [];
    let intent: ExecutionIntent | undefined;
    let completion: ExecutionCompletion | undefined;
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(authorization()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const outcome = await executePreparedTool(prepared, {
      endpoint: 'https://gateway.example',
      executorId: 'payments-provider',
      fetch,
      durableStore: {
        commitIntent: async (value) => {
          order.push('intent');
          intent = value;
        },
        commitCompletionAndEnqueueReceipt: async (value) => {
          order.push('completion');
          completion = value;
        },
      },
      executor: async (request) => {
        order.push('effect');
        expect(request.idempotencyId).toBe(prepared.idempotencyId);
        return { result: { ok: true }, effectId: 'provider-operation-123' };
      },
      signReceipt: async () => ({
        algorithm: 'ES256',
        credential_fingerprint:
          'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        value: 'signed-receipt',
      }),
    });

    expect(order).toEqual(['intent', 'effect', 'completion']);
    expect(outcome.result).toEqual({ ok: true });
    expect(outcome.effectId).toBe('provider-operation-123');
    expect(intent?.executor_id).toBe('payments-provider');
    expect(completion?.actual_result_sha256).toBe(
      'sha256:4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93',
    );
    const init = fetch.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-clavenar-decision-contract']).toBe('clavenar.decision/v1');
    expect(headers['x-clavenar-idempotency-id']).toBe(prepared.idempotencyId);
  });

  it('fails closed when durable intent cannot be committed', async () => {
    const executor = vi.fn();
    await expect(
      executePreparedTool(prepared, {
        endpoint: 'https://gateway.example',
        executorId: 'payments-provider',
        fetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify(authorization()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
        durableStore: {
          commitIntent: async () => {
            throw new Error('store unavailable');
          },
          commitCompletionAndEnqueueReceipt: async () => undefined,
        },
        executor,
        signReceipt: async () => {
          throw new Error('unreachable');
        },
      }),
    ).rejects.toThrow('store unavailable');
    expect(executor).not.toHaveBeenCalled();
  });

  it('never retries the registered executor after an effect failure', async () => {
    const executor = vi.fn().mockRejectedValue(new Error('provider response lost'));
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(authorization()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(
      executePreparedTool(prepared, {
        endpoint: 'https://gateway.example',
        executorId: 'payments-provider',
        fetch,
        retry: { maxAttempts: 3, baseDelayMs: 1 },
        durableStore: {
          commitIntent: async () => undefined,
          commitCompletionAndEnqueueReceipt: async () => undefined,
        },
        executor,
        signReceipt: async () => {
          throw new Error('unreachable');
        },
      }),
    ).rejects.toThrow('provider response lost');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
