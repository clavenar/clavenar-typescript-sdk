/**
 * Real round-trip against a running warden-lite. Skipped unless
 * `WARDEN_E2E_ENDPOINT` is set so this stays out of the default
 * vitest run (CI can spin warden-lite up and toggle the env).
 *
 *   warden-lite start --port 8088 --policies ./policies \
 *     --ledger :memory: --upstream http://127.0.0.1:9 \
 *     --token smoke-test-token
 *   WARDEN_E2E_ENDPOINT=http://localhost:8088 \
 *     WARDEN_E2E_TOKEN=smoke-test-token \
 *     pnpm test
 */
import { describe, expect, it } from 'vitest';
import { inspectToolUse, wardenWrap, WardenDenied } from '../src/index.js';
import type { AnthropicMessage, AnthropicToolUseBlock } from '../src/anthropic.js';
import type { WardenVerdict } from '../src/types.js';

const endpoint = process.env['WARDEN_E2E_ENDPOINT'];
const token = process.env['WARDEN_E2E_TOKEN'];
const enabled = typeof endpoint === 'string' && endpoint.length > 0;

const maybeDescribe = enabled ? describe : describe.skip;

maybeDescribe('e2e against warden-lite', () => {
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

  it('wardenWrap enforce (default): denied tool_use → throws WardenDenied', async () => {
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
    const verdicts: WardenVerdict[] = [];
    const wrapped = wardenWrap(
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
      expect.fail('expected WardenDenied');
    } catch (e) {
      expect(e).toBeInstanceOf(WardenDenied);
      const denied = e as WardenDenied;
      expect(denied.toolName).toBe('sql_execute');
      expect(denied.intentCategory).toBe('DangerousTool');
    }
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.kind).toBe('deny');
  });

  it('wardenWrap observe: denied tool_use → passes through, onVerdict fires', async () => {
    const message: AnthropicMessage = {
      id: 'msg_e2e_2',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_e2e_obs', name: 'sql_execute', input: { q: 'SELECT 1' } },
      ],
      stop_reason: 'tool_use',
    };
    const verdicts: WardenVerdict[] = [];
    const wrapped = wardenWrap(
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

  it('rejects wrong bearer token with WardenTransportError', async () => {
    const block: AnthropicToolUseBlock = {
      type: 'tool_use',
      id: 'toolu_e2e_badauth',
      name: 'whatever',
      input: {},
    };
    await expect(inspectToolUse(block, { ...opts, token: 'wrong-token' })).rejects.toMatchObject({
      name: 'WardenTransportError',
      status: 401,
    });
  });
});
