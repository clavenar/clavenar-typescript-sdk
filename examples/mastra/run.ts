/**
 * Mastra + warden recipe — gate every tool execute with warden
 * before running it.
 *
 * The Mastra agent itself is stubbed; the load-bearing pattern is
 * the `withWardenGate(name, execute)` helper that wraps any
 * Mastra-shaped tool `execute` function with a warden inspect call.
 * Drop the helper into your real Mastra `tools` registration and
 * you're done.
 */
import { WardenDenied, WardenPending, inspectToolUse } from '../../src/index.js';

const endpoint = process.env['WARDEN_ENDPOINT'] ?? 'http://localhost:8088';
const token = process.env['WARDEN_TOKEN'] ?? 'demo-token';

/** Mastra tool registration shape (subset). */
type MastraTool<TArgs, TResult> = {
  description: string;
  parameters: unknown;
  execute: (args: TArgs) => Promise<TResult>;
};

/**
 * Wrap a tool's `execute` with warden inspection. Returns a new
 * execute function with the same signature — Mastra sees a regular
 * tool, but every call routes through the proxy first.
 *
 * Pending requests block on `e.resolve()`; deny requests throw out
 * of the tool execution and bubble back up through the Mastra
 * agent's error path.
 */
function withWardenGate<TArgs, TResult>(
  toolName: string,
  inner: (args: TArgs) => Promise<TResult>
): (args: TArgs) => Promise<TResult> {
  return async (args: TArgs) => {
    try {
      await inspectToolUse(
        { id: cryptoRandomId(), name: toolName, input: args },
        { endpoint, token, mode: 'enforce' }
      );
    } catch (e) {
      if (e instanceof WardenPending) {
        try {
          await e.resolve();
          // Approved — fall through to inner.
        } catch (decided) {
          if (decided instanceof WardenDenied) {
            throw new Error(
              `Mastra tool ${toolName} denied by operator: ${decided.reasons.join('; ')}`
            );
          }
          throw decided;
        }
      } else if (e instanceof WardenDenied) {
        throw new Error(`Mastra tool ${toolName} denied: ${e.reasons.join('; ')}`);
      } else {
        throw e;
      }
    }
    return inner(args);
  };
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// --- Example tool registration -----------------------------------

const tools: Record<string, MastraTool<unknown, unknown>> = {
  fetch_user: {
    description: 'Fetch a user record by id.',
    parameters: { type: 'object', properties: { userId: { type: 'string' } } },
    execute: withWardenGate('fetch_user', async (args) => {
      const { userId } = args as { userId: string };
      return { userId, name: `user-${userId}` };
    }),
  },
  wire_transfer: {
    description: 'Send a wire transfer.',
    parameters: {
      type: 'object',
      properties: { to: { type: 'string' }, amount: { type: 'number' } },
    },
    execute: withWardenGate('wire_transfer', async () => ({ ok: true })),
  },
};

// Stand-in for `await mastraAgent.run(...)` calling these tools.
try {
  console.log('→ fetch_user');
  console.log('  ', await tools['fetch_user']!.execute({ userId: 'alice' }));

  console.log('→ wire_transfer');
  console.log('  ', await tools['wire_transfer']!.execute({ to: 'acct-9', amount: 250 }));
} catch (e) {
  console.log('tool execution failed:', (e as Error).message);
}
