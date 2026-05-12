/**
 * Native Anthropic + warden — minimal end-to-end recipe.
 *
 * Wrap once at boot; every messages.create() with tool_use blocks
 * flows through warden automatically. Same wardenWrap export as
 * the OpenAI recipe — the wrapper sniffs the client shape and picks
 * the right normalizer.
 */
import { wardenWrap, WardenDenied, WardenPending } from '../../src/index.js';
import type { AnthropicLike } from '../../src/index.js';

const endpoint = process.env['WARDEN_ENDPOINT'] ?? 'http://localhost:8088';
const token = process.env['WARDEN_TOKEN'] ?? 'demo-token';

// Real call: `import Anthropic from '@anthropic-ai/sdk';
//             const anthropic = new Anthropic();`
const anthropic: AnthropicLike = {
  messages: {
    async create() {
      return {
        id: 'msg-stub',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu-1',
            name: 'wire_transfer',
            input: { to: 'acct-9', amount: 250 },
          },
        ],
        stop_reason: 'tool_use',
        model: 'claude-haiku-4-5',
      };
    },
  },
};

const wrapped = wardenWrap(anthropic, { endpoint, token, mode: 'enforce' });

try {
  const msg = await wrapped.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    tools: [
      {
        name: 'wire_transfer',
        description: 'Send a wire transfer to an account.',
        input_schema: {
          type: 'object',
          properties: { to: { type: 'string' }, amount: { type: 'number' } },
          required: ['to', 'amount'],
        },
      },
    ],
    messages: [{ role: 'user', content: 'Send $250 to acct-9.' }],
  });
  console.log('green — content blocks:', msg.content.map((b) => b.type).join(', '));
} catch (e) {
  if (e instanceof WardenDenied) {
    console.log(`deny: ${e.reasons.join('; ')}`);
  } else if (e instanceof WardenPending) {
    console.log(`pending (${e.correlationId}) — awaiting operator`);
    try {
      await e.resolve();
      console.log('resolved: allow');
    } catch (decided) {
      if (decided instanceof WardenDenied) {
        console.log(`resolved: deny — ${decided.reasons.join('; ')}`);
      } else {
        throw decided;
      }
    }
  } else {
    throw e;
  }
}
