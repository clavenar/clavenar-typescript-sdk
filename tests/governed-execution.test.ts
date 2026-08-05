import { describe, expect, it, vi } from 'vitest';

import {
  ClavenarRecoveryRequired,
  executePreparedTool,
  type ExecutionCompletion,
  type ExecutionIntent,
  type ExecutionState,
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
    const state: ExecutionState = {};
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
        loadExecution: async () => state,
        commitIntent: async (value) => {
          order.push('intent');
          intent = value;
          state.intent = value;
        },
        commitCompletionAndEnqueueReceipt: async (value) => {
          order.push('completion');
          completion = value;
          state.completion = value;
        },
      },
      verifyAuthorization: async (signed) => {
        signed.authorization.tool_name = 'mutated-by-verifier';
      },
      executor: async (request) => {
        order.push('effect');
        expect(request.idempotencyId).toBe(prepared.idempotencyId);
        return { result: { ok: true }, effectId: 'provider-operation-123' };
      },
      signReceipt: async (unsigned) => {
        unsigned.authorization_id = 'mutated-by-signer';
        return {
          algorithm: 'ES256',
          credential_fingerprint:
            'sha256:1111111111111111111111111111111111111111111111111111111111111111',
          value: 'signed-receipt',
        };
      },
    });

    expect(order).toEqual(['intent', 'effect', 'completion']);
    expect(outcome.result).toEqual({ ok: true });
    expect(outcome.effectId).toBe('provider-operation-123');
    expect(outcome.receipt.authorization_id).toBe(
      '354c33ed-e5d3-4af7-a1b8-b009d50b0bc5',
    );
    expect(outcome.receipt.authorization.authorization.tool_name).toBe(prepared.name);
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
          loadExecution: async () => ({}),
          commitIntent: async () => {
            throw new Error('store unavailable');
          },
          commitCompletionAndEnqueueReceipt: async () => undefined,
        },
        executor,
        verifyAuthorization: async () => undefined,
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
          loadExecution: async () => ({}),
          commitIntent: async () => undefined,
          commitCompletionAndEnqueueReceipt: async () => undefined,
        },
        executor,
        verifyAuthorization: async () => undefined,
        signReceipt: async () => {
          throw new Error('unreachable');
        },
      }),
    ).rejects.toThrow('provider response lost');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('rejects an authorization whose signature verifier fails before durable intent', async () => {
    const store = {
      loadExecution: vi.fn().mockResolvedValue({}),
      commitIntent: vi.fn(),
      commitCompletionAndEnqueueReceipt: vi.fn(),
    };
    const executor = vi.fn();
    await expect(
      executePreparedTool(prepared, {
        endpoint: 'https://gateway.example',
        executorId: 'payments-provider',
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(authorization()), { status: 200 })),
        durableStore: store,
        executor,
        verifyAuthorization: async () => {
          throw new Error('unknown identity key');
        },
        signReceipt: async () => {
          throw new Error('unreachable');
        },
      }),
    ).rejects.toThrow('authorization signature verification failed');
    expect(store.commitIntent).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  it('fails closed instead of repeating an ambiguous persisted intent', async () => {
    const signed = authorization();
    const auth = signed.authorization;
    const intent: ExecutionIntent = {
      contract: 'clavenar.sdk-durable-intent-outbox/v1',
      stage: 'execution.intent',
      authorization_id: auth.authorization_id,
      idempotency_id: auth.idempotency_id,
      tenant: auth.tenant,
      workload_id: auth.agent_id,
      workload_spiffe: auth.agent_spiffe,
      payload_sha256: auth.payload_sha256,
      executor_id: 'payments-provider',
      authorization: signed,
    };
    const executor = vi.fn();
    await expect(
      executePreparedTool(prepared, {
        endpoint: 'https://gateway.example',
        executorId: 'payments-provider',
        durableStore: {
          loadExecution: async () => ({ intent }),
          commitIntent: async () => undefined,
          commitCompletionAndEnqueueReceipt: async () => undefined,
        },
        executor,
        verifyAuthorization: async () => undefined,
        signReceipt: async () => {
          throw new Error('unreachable');
        },
      }),
    ).rejects.toBeInstanceOf(ClavenarRecoveryRequired);
    expect(executor).not.toHaveBeenCalled();
  });

  it('finalizes a conclusively recovered provider effect without replay', async () => {
    const signed = authorization();
    const auth = signed.authorization;
    const intent: ExecutionIntent = {
      contract: 'clavenar.sdk-durable-intent-outbox/v1',
      stage: 'execution.intent',
      authorization_id: auth.authorization_id,
      idempotency_id: auth.idempotency_id,
      tenant: auth.tenant,
      workload_id: auth.agent_id,
      workload_spiffe: auth.agent_spiffe,
      payload_sha256: auth.payload_sha256,
      executor_id: 'payments-provider',
      authorization: signed,
    };
    const executor = vi.fn();
    const commitCompletion = vi.fn();
    const outcome = await executePreparedTool(prepared, {
      endpoint: 'https://gateway.example',
      executorId: 'payments-provider',
      durableStore: {
        loadExecution: async () => ({ intent }),
        commitIntent: async () => undefined,
        commitCompletionAndEnqueueReceipt: commitCompletion,
      },
      executor,
      recoverEffect: async () => ({ result: { ok: true }, effectId: 'provider-operation-123' }),
      verifyAuthorization: async () => undefined,
      signReceipt: async () => ({
        algorithm: 'ES256',
        credential_fingerprint: auth.credential_fingerprint,
        value: 'signed-receipt',
      }),
    });
    expect(outcome.effectId).toBe('provider-operation-123');
    expect(commitCompletion).toHaveBeenCalledOnce();
    expect(executor).not.toHaveBeenCalled();
  });
});
