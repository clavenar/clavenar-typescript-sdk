/**
 * LangChain.js + warden — gate each DynamicTool's `func` with a
 * warden inspect call.
 *
 * LangChain is stubbed (we don't install the real runtime in this
 * example); the load-bearing pattern is the `wardenTool` factory
 * that produces LangChain-shaped tool definitions whose `func`
 * routes through warden before doing work.
 */
import { WardenDenied, WardenPending, inspectToolUse } from '../../src/index.js';

const endpoint = process.env['WARDEN_ENDPOINT'] ?? 'http://localhost:8088';
const token = process.env['WARDEN_TOKEN'] ?? 'demo-token';

/** LangChain DynamicTool shape (subset). */
type LangChainTool = {
  name: string;
  description: string;
  func: (input: string) => Promise<string>;
};

/**
 * Produce a LangChain-shaped tool whose `func` is gated by warden.
 * The inner handler runs only on green / approved-pending; deny or
 * denied-pending throws an error LangChain surfaces as the tool
 * output (LangChain catches and returns the message to the model).
 */
function wardenTool(
  name: string,
  description: string,
  inner: (input: string) => Promise<string>
): LangChainTool {
  return {
    name,
    description,
    func: async (input: string) => {
      try {
        await inspectToolUse(
          { id: cryptoRandomId(), name, input: tryParse(input) },
          { endpoint, token, mode: 'enforce' }
        );
      } catch (e) {
        if (e instanceof WardenPending) {
          try {
            await e.resolve();
          } catch (decided) {
            if (decided instanceof WardenDenied) {
              return `[warden] denied by operator: ${decided.reasons.join('; ')}`;
            }
            throw decided;
          }
        } else if (e instanceof WardenDenied) {
          return `[warden] denied: ${e.reasons.join('; ')}`;
        } else {
          return `[warden] transport error: ${(e as Error).message}`;
        }
      }
      return inner(input);
    },
  };
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// --- Example tool registration -----------------------------------

const tools: LangChainTool[] = [
  wardenTool('fetch_user', 'Fetch a user by id.', async (input) => {
    const args = tryParse(input) as { userId: string };
    return JSON.stringify({ userId: args.userId, name: `user-${args.userId}` });
  }),
  wardenTool('wire_transfer', 'Send a wire transfer.', async () =>
    JSON.stringify({ ok: true })
  ),
];

// Stand-in for `agent.invoke({ input: "..." })` — runs the tools
// directly so the wiring is obvious.
for (const tool of tools) {
  const sample = tool.name === 'fetch_user'
    ? '{"userId":"alice"}'
    : '{"to":"acct-9","amount":250}';
  console.log(`\n→ tool ${tool.name}: ${sample}`);
  console.log('  ', await tool.func(sample));
}
