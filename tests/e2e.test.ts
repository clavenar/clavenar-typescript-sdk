/**
 * Real round-trip against a running clavenar-lite. Skipped unless
 * `CLAVENAR_E2E_ENDPOINT` is set so this stays out of the default
 * vitest run (CI can spin clavenar-lite up and toggle the env).
 *
 *   clavenar-lite start --port 8088 --policies ./policies \
 *     --ledger :memory: --upstream http://127.0.0.1:9 \
 *     --token smoke-test-token
 *   CLAVENAR_E2E_ENDPOINT=http://localhost:8088 \
 *     CLAVENAR_E2E_TOKEN=smoke-test-token \
 *     pnpm test
 */
import { describe, expect, it } from 'vitest';
import {
  inspectToolUse,
  clavenarWrap,
  ClavenarDenied,
  ClavenarPending,
} from '../src/index.js';
import type { AnthropicMessage, AnthropicToolUseBlock } from '../src/anthropic.js';
import type { ClavenarVerdict } from '../src/types.js';

const endpoint = process.env['CLAVENAR_E2E_ENDPOINT'];
const token = process.env['CLAVENAR_E2E_TOKEN'];
const decideToken = process.env['CLAVENAR_E2E_DECIDE_TOKEN'];
const enabled = typeof endpoint === 'string' && endpoint.length > 0;

const maybeDescribe = enabled ? describe : describe.skip;

maybeDescribe('e2e against clavenar-lite', () => {
  const opts = { endpoint: endpoint!, token };

  it('inspectToolUse: sql_execute → deny', async () => {
    const block: AnthropicToolUseBlock = {
      type: 'tool_use',
      id: 'toolu_e2e_sql',
      name: 'sql_execute',
      input: { q: 'DROP TABLE users' },
    };
    const verdict = await inspectToolUse(block, opts);
    expect(verdict.kind).toBe('deny');
    if (verdict.kind === 'deny') {
      expect(verdict.payload.error).toBe('security_violation');
      expect(verdict.payload.intent_category).toBe('DangerousTool');
      expect(verdict.payload.reasons.length).toBeGreaterThan(0);
    }
  });

  it('inspectToolUse: shell_exec → deny', async () => {
    const block: AnthropicToolUseBlock = {
      type: 'tool_use',
      id: 'toolu_e2e_shell',
      name: 'shell_exec',
      input: { cmd: 'rm -rf /' },
    };
    const verdict = await inspectToolUse(block, opts);
    expect(verdict.kind).toBe('deny');
  });

  it('clavenarWrap enforce (default): denied tool_use → throws ClavenarDenied', async () => {
    const message: AnthropicMessage = {
      id: 'msg_e2e_1',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will run the query.' },
        { type: 'tool_use', id: 'toolu_e2e_wrap', name: 'sql_execute', input: { q: 'SELECT 1' } },
      ],
      stop_reason: 'tool_use',
    };
    const verdicts: ClavenarVerdict[] = [];
    const wrapped = clavenarWrap(
      { messages: { create: async () => message } },
      {
        ...opts,
        onVerdict: (v) => {
          verdicts.push(v);
        },
      },
    );
    try {
      await wrapped.messages.create({});
      expect.fail('expected ClavenarDenied');
    } catch (e) {
      expect(e).toBeInstanceOf(ClavenarDenied);
      const denied = e as ClavenarDenied;
      expect(denied.toolName).toBe('sql_execute');
      expect(denied.intentCategory).toBe('DangerousTool');
    }
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.kind).toBe('deny');
  });

  it('clavenarWrap observe: denied tool_use → passes through, onVerdict fires', async () => {
    const message: AnthropicMessage = {
      id: 'msg_e2e_2',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_e2e_obs', name: 'sql_execute', input: { q: 'SELECT 1' } },
      ],
      stop_reason: 'tool_use',
    };
    const verdicts: ClavenarVerdict[] = [];
    const wrapped = clavenarWrap(
      { messages: { create: async () => message } },
      {
        ...opts,
        mode: 'observe',
        onVerdict: (v) => {
          verdicts.push(v);
        },
      },
    );
    const result = await wrapped.messages.create({});
    expect(result.id).toBe('msg_e2e_2');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.kind).toBe('deny');
  });

  it('rejects wrong bearer token with ClavenarTransportError', async () => {
    const block: AnthropicToolUseBlock = {
      type: 'tool_use',
      id: 'toolu_e2e_badauth',
      name: 'whatever',
      input: {},
    };
    await expect(inspectToolUse(block, { ...opts, token: 'wrong-token' })).rejects.toMatchObject({
      name: 'ClavenarTransportError',
      status: 401,
    });
  });

  // Operator-side helper. Hits clavenar-lite's /decide directly rather
  // than shelling out to the CLI so the test doesn't depend on the
  // binary being on PATH. The wire contract is what matters here.
  async function operatorDecide(
    correlationId: string,
    decision: 'allow' | 'deny',
    note: string,
  ): Promise<void> {
    const resp = await fetch(
      `${endpoint}/pending/${encodeURIComponent(correlationId)}/decide`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(decideToken ? { Authorization: `Bearer ${decideToken}` } : {}),
        },
        body: JSON.stringify({ decision, note }),
      },
    );
    if (!resp.ok) {
      throw new Error(`decide returned ${resp.status}: ${await resp.text()}`);
    }
  }

  function makeWireTransferMessage(id: string): AnthropicMessage {
    return {
      id,
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_e2e_wt',
          name: 'wire_transfer',
          input: { to: 'acct-1', amount: 100 },
        },
      ],
      stop_reason: 'tool_use',
    };
  }

  it('yellow tier: wire_transfer parks; operator approves; resolve returns void', async () => {
    const stub = {
      messages: { create: async () => makeWireTransferMessage('msg_e2e_pend_allow') },
    };
    const wrapped = clavenarWrap(stub, opts);

    let pending: ClavenarPending | undefined;
    try {
      await wrapped.messages.create({});
    } catch (e) {
      if (e instanceof ClavenarPending) pending = e;
      else throw e;
    }
    expect(pending).toBeDefined();
    expect(pending!.correlationId.length).toBeGreaterThan(0);
    expect(pending!.reviewReasons.length).toBeGreaterThan(0);

    setTimeout(() => {
      operatorDecide(pending!.correlationId, 'allow', 'e2e approve').catch(() => {
        // resolve()'s timeout will surface if this fails.
      });
    }, 100);
    await pending!.resolve({ pollIntervalMs: 50, timeoutMs: 5_000 });
    // No throw == allow. The point of this test is the round-trip:
    // a real clavenar-lite parked the call, /decide updated the row, and
    // the SDK's poll loop saw the flip.
  });

  it('yellow tier: wire_transfer parks; operator denies; resolve throws ClavenarDenied', async () => {
    const stub = {
      messages: { create: async () => makeWireTransferMessage('msg_e2e_pend_deny') },
    };
    const wrapped = clavenarWrap(stub, opts);

    let pending: ClavenarPending | undefined;
    try {
      await wrapped.messages.create({});
    } catch (e) {
      if (e instanceof ClavenarPending) pending = e;
      else throw e;
    }
    expect(pending).toBeDefined();

    setTimeout(() => {
      operatorDecide(pending!.correlationId, 'deny', 'e2e deny note').catch(() => {});
    }, 100);
    await expect(
      pending!.resolve({ pollIntervalMs: 50, timeoutMs: 5_000 }),
    ).rejects.toBeInstanceOf(ClavenarDenied);
  });
});
