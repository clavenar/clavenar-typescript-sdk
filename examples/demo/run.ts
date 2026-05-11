/**
 * Week-1 demo: prove the wrap works end-to-end against warden-lite.
 *
 * Mocks the Anthropic client (canned messages with tool_use blocks)
 * so this runs without an Anthropic API key — the artifact under
 * test is warden's behavior, not Anthropic's.
 *
 * Assumes warden-lite is reachable. Use ./start.sh to boot it +
 * run this script, or hand-start with:
 *
 *   warden-lite start --port 8088 --policies examples/demo/policies \
 *     --ledger :memory: --upstream http://127.0.0.1:9 \
 *     --token demo-token
 */
import { WardenDenied, WardenPending, wardenWrap } from '../../src/index.js';
import type { AnthropicMessage } from '../../src/anthropic.js';
import type { WardenVerdict, WardenVerdictContext } from '../../src/types.js';

const endpoint = process.env['WARDEN_ENDPOINT'] ?? 'http://localhost:8088';
const token = process.env['WARDEN_TOKEN'] ?? 'demo-token';
// OBSERVE=1 flips the SDK to observe mode: deny verdicts surface via
// the onVerdict callback but never throw. Useful for showing the
// rollout pattern partners follow before flipping to enforce.
const mode: 'enforce' | 'observe' =
  process.env['OBSERVE'] === '1' || process.env['OBSERVE'] === 'true'
    ? 'observe'
    : 'enforce';

const scenarios: Array<{ label: string; message: AnthropicMessage }> = [
  {
    label: 'fetch user 42',
    message: makeMessage('msg_fetch', [
      { type: 'text', text: 'I will read the user record.' },
      { type: 'tool_use', id: 'toolu_fetch', name: 'fetch_user', input: { id: 42 } },
    ]),
  },
  {
    label: 'delete user 42',
    message: makeMessage('msg_delete', [
      { type: 'text', text: 'I will remove the user.' },
      { type: 'tool_use', id: 'toolu_delete', name: 'delete_user', input: { id: 42 } },
    ]),
  },
  {
    label: 'transfer $100 from acct-A to acct-B',
    message: makeMessage('msg_transfer', [
      { type: 'text', text: 'I will move the funds.' },
      {
        type: 'tool_use',
        id: 'toolu_transfer',
        name: 'transfer_funds',
        input: { from: 'acct-A', to: 'acct-B', amount: 100 },
      },
    ]),
  },
];

await main();

async function main(): Promise<void> {
  banner();
  for (const [i, scenario] of scenarios.entries()) {
    await runScenario(i + 1, scenarios.length, scenario.label, scenario.message);
  }
  console.log('');
  console.log('Demo complete. Ledger entries are visible in warden-lite stdout.');
}

async function runScenario(
  n: number,
  total: number,
  label: string,
  message: AnthropicMessage,
): Promise<void> {
  console.log('');
  console.log(`[${n}/${total}] agent: "${label}"`);
  const toolBlock = message.content.find((b) => b.type === 'tool_use');
  if (toolBlock && toolBlock.type === 'tool_use') {
    console.log(`        tool_use: ${toolBlock.name}(${JSON.stringify(toolBlock.input)})`);
  }

  const wrapped = wardenWrap(
    { messages: { create: async () => message } },
    {
      endpoint,
      token,
      mode,
      onVerdict: (v: WardenVerdict, ctx: WardenVerdictContext) => printVerdict(v, ctx),
    },
  );

  try {
    await wrapped.messages.create({});
    if (mode === 'observe') {
      console.log(
        '        result:   message returned (observe: warden recorded the verdict, partner code keeps running)',
      );
    } else {
      console.log('        result:   message returned, your tool-execution loop runs the tool');
    }
  } catch (e) {
    if (e instanceof WardenPending) {
      // onVerdict already printed the [PEND] header — pick up from
      // the review reason and the await.
      console.log(`                  reason: ${e.reviewReasons[0] ?? '(no review reason)'}`);
      console.log(`                  awaiting operator decision …`);
      // In production, the operator approves from Slack / a dashboard.
      // The demo auto-approves after a short pause so the screencap
      // doesn't require human input. resolve() polls until decision.
      scheduleAutoApprove(e.correlationId, 1_500).catch((err) => {
        console.log(`                  (auto-approve helper failed: ${(err as Error).message})`);
      });
      try {
        await e.resolve({ pollIntervalMs: 250, timeoutMs: 15_000 });
        console.log(`        result:   approved — agent loop proceeds with the tool call`);
      } catch (rerr) {
        if (rerr instanceof WardenDenied) {
          console.log(`        result:   denied by operator — WardenDenied thrown out of resolve()`);
          console.log(`                  reasons: ${rerr.reasons.join(' | ')}`);
        } else {
          console.log(`        result:   resolve failed: ${(rerr as Error).message}`);
          process.exitCode = 1;
        }
      }
    } else if (e instanceof WardenDenied) {
      console.log(`        result:   WardenDenied thrown — your existing throw-handler kicks in`);
      console.log(`                  toolName=${e.toolName}`);
      console.log(`                  intentCategory=${e.intentCategory}`);
      for (const reason of e.reasons) {
        console.log(`                  reason: ${reason}`);
      }
    } else {
      console.log('        result:   unexpected error');
      console.log(`                  ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
}

async function scheduleAutoApprove(correlationId: string, delayMs: number): Promise<void> {
  await new Promise((r) => setTimeout(r, delayMs));
  const url = `${endpoint}/pending/${encodeURIComponent(correlationId)}/decide`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'allow', note: 'auto-approved by demo runner' }),
  });
  if (!resp.ok) {
    throw new Error(`decide endpoint returned ${resp.status}: ${await resp.text()}`);
  }
}

function printVerdict(v: WardenVerdict, ctx: WardenVerdictContext): void {
  if (v.kind === 'allow') {
    console.log(`        warden:   [ALLOW] tool="${ctx.toolName}"`);
  } else if (v.kind === 'deny') {
    console.log(
      `        warden:   [DENY]  tool="${ctx.toolName}" intent="${v.payload.intent_category}"`,
    );
  } else {
    console.log(`        warden:   [PEND]  tool="${ctx.toolName}" corr="${v.correlationId}"`);
  }
}

function banner(): void {
  console.log('Agent Warden SDK — demo');
  console.log(`  endpoint: ${endpoint}`);
  console.log(`  token:    ${token ? '*****' + token.slice(-4) : '(none)'}`);
  console.log(`  mode:     ${mode}`);
  console.log(`  client:   mocked Anthropic (canned tool_use blocks)`);
  console.log('');
  if (mode === 'enforce') {
    console.log('enforce mode: a deny verdict throws WardenDenied to the caller; the');
    console.log("partner's tool-execution loop never sees the denied tool.");
  } else {
    console.log('observe mode: warden records every verdict via onVerdict but never');
    console.log('throws. Use this during rollout, flip to enforce when the verdicts');
    console.log('are trustworthy. Re-run with `OBSERVE= pnpm demo` to see enforce mode.');
  }
}

function makeMessage(id: string, content: AnthropicMessage['content']): AnthropicMessage {
  return {
    id,
    type: 'message',
    role: 'assistant',
    content,
    stop_reason: 'tool_use',
  };
}
