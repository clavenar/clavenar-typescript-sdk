/**
 * LangChain.js + clavenar — gate each DynamicTool's `func` with a
 * clavenar inspect call.
 *
 * LangChain is stubbed (we don't install the real runtime in this
 * example); the load-bearing pattern is the `clavenarTool` factory
 * that produces LangChain-shaped tool definitions whose `func`
 * routes through clavenar before doing work.
 */
import { ClavenarDenied, ClavenarPending, inspectToolUse } from '../../src/index.js';

const endpoint = process.env['CLAVENAR_ENDPOINT'] ?? 'http://localhost:8088';
const token = process.env['CLAVENAR_TOKEN'] ?? 'demo-token';

/** LangChain DynamicTool shape (subset). */
type LangChainTool = {
  name: string;
  description: string;
  func: (input: string) => Promise<string>;
};

/**
 * Produce a LangChain-shaped tool whose `func` is gated by clavenar.
 * The inner handler runs only on green / approved-pending; deny or
 * denied-pending throws an error LangChain surfaces as the tool
 * output (LangChain catches and returns the message to the model).
 */
function clavenarTool(
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
        if (e instanceof ClavenarPending) {
          try {
            await e.resolve();
          } catch (decided) {
            if (decided instanceof ClavenarDenied) {
              return `[clavenar] denied by operator: ${decided.reasons.join('; ')}`;
            }
            throw decided;
          }
        } else if (e instanceof ClavenarDenied) {
          return `[clavenar] denied: ${e.reasons.join('; ')}`;
        } else {
          return `[clavenar] transport error: ${(e as Error).message}`;
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
  clavenarTool('fetch_user', 'Fetch a user by id.', async (input) => {
    const args = tryParse(input) as { userId: string };
    return JSON.stringify({ userId: args.userId, name: `user-${args.userId}` });
  }),
  clavenarTool('wire_transfer', 'Send a wire transfer.', async () =>
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
