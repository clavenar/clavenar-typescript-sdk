/**
 * Native OpenAI + clavenar — minimal end-to-end recipe.
 *
 * Wrap the OpenAI client once at boot; every chat.completions.create
 * that returns tool_calls flows through clavenar automatically.
 *
 * Run with OPENAI_API_KEY set against a real account, or stub the
 * client (commented-out path below) for an offline demo.
 */
import { clavenarWrap, ClavenarDenied, ClavenarPending } from '../../src/index.js';
import type { OpenAIChatLike } from '../../src/index.js';

const endpoint = process.env['CLAVENAR_ENDPOINT'] ?? 'http://localhost:8088';
const token = process.env['CLAVENAR_TOKEN'] ?? 'demo-token';

// Real call: `import OpenAI from 'openai'; const openai = new OpenAI();`
// Stub: keeps the file dependency-free + runnable as a snippet.
// Typed against `OpenAIChatLike` so clavenarWrap's overload picks the
// OpenAI path; structural typing handles the rest.
const openai: OpenAIChatLike = {
  chat: {
    completions: {
      async create() {
        return {
          id: 'chatcmpl-stub',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: {
                      name: 'wire_transfer',
                      arguments: JSON.stringify({ to: 'acct-9', amount: 250 }),
                    },
                  },
                ],
              },
            },
          ],
        };
      },
    },
  },
};

const wrapped = clavenarWrap(openai, { endpoint, token, mode: 'enforce' });

try {
  const result = await wrapped.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Send $250 to acct-9.' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'wire_transfer',
          description: 'Send a wire transfer.',
          parameters: {
            type: 'object',
            properties: { to: { type: 'string' }, amount: { type: 'number' } },
            required: ['to', 'amount'],
          },
        },
      },
    ],
  });
  console.log('green — model emitted', result.choices[0].message.tool_calls?.length, 'tool call(s)');
} catch (e) {
  if (e instanceof ClavenarDenied) {
    console.log(`deny: ${e.reasons.join('; ')}`);
  } else if (e instanceof ClavenarPending) {
    console.log(`pending (correlation_id=${e.correlationId}) — awaiting operator`);
    try {
      await e.resolve();
      console.log('resolved: allow');
    } catch (decided) {
      if (decided instanceof ClavenarDenied) {
        console.log(`resolved: deny — ${decided.reasons.join('; ')}`);
      } else {
        throw decided;
      }
    }
  } else {
    throw e;
  }
}
