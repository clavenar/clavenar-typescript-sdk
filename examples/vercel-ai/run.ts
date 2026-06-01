/**
 * Vercel AI SDK + clavenar recipe — runs `generateText`, intercepts
 * the returned `toolCalls` array through clavenar before dispatching
 * to local tool handlers. Demonstrates the minimum-change path.
 *
 * Local tool implementations are stubbed — the only network call
 * out of process is to `clavenar-lite` (and to Anthropic, if you've
 * set ANTHROPIC_API_KEY; otherwise we synthesize a fake toolCalls
 * response so the example runs offline).
 */
import { ClavenarDenied, ClavenarPending, inspectToolUse } from '../../src/index.js';

interface ToolCall {
  toolName: string;
  args: unknown;
  toolCallId: string;
}

const endpoint = process.env['CLAVENAR_ENDPOINT'] ?? 'http://localhost:8088';
const token = process.env['CLAVENAR_TOKEN'] ?? 'demo-token';

/** Stub Vercel-AI-SDK-shaped toolCalls — wire your generateText() result here. */
function fakeToolCalls(): ToolCall[] {
  return [
    { toolCallId: 'tc-1', toolName: 'fetch_user', args: { userId: 'alice' } },
    { toolCallId: 'tc-2', toolName: 'wire_transfer', args: { to: 'acct-9', amount: 250 } },
  ];
}

/** Pretend tool registry — your real one lives one boundary outside this file. */
const tools: Record<string, (args: unknown) => Promise<unknown>> = {
  fetch_user: async (a) => ({ name: (a as { userId: string }).userId, ok: true }),
  wire_transfer: async () => ({ confirmation_id: 'wt-xyz' }),
};

async function dispatchWithClavenar(toolCalls: ToolCall[]) {
  for (const call of toolCalls) {
    console.log(`\n→ tool: ${call.toolName}`);
    try {
      // Inspect the tool call directly. inspectToolUse is the
      // lower-level surface used by clavenarWrap internally; we use
      // it here because Vercel's output isn't an Anthropic message
      // object — it's a flat toolCalls array.
      await inspectToolUse(
        { id: call.toolCallId, name: call.toolName, input: call.args },
        { endpoint, token, mode: 'enforce' }
      );
      // Verdict was green — execute the local tool implementation.
      const result = await tools[call.toolName]?.(call.args);
      console.log(`  ✓ allow → result:`, result);
    } catch (e) {
      if (e instanceof ClavenarDenied) {
        console.log(`  ✗ deny: ${e.reasons.join('; ')}`);
      } else if (e instanceof ClavenarPending) {
        console.log(`  ⏸ pending — correlation_id=${e.correlationId}`);
        console.log(`     await pending.resolve() in your real run loop;`);
        console.log(`     operator decides via clavenarctl pending decide.`);
      } else {
        console.log(`  ! transport error:`, e);
      }
    }
  }
}

await dispatchWithClavenar(fakeToolCalls());
