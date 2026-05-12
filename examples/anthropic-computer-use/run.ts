/**
 * Anthropic Computer Use + Agent Warden — gate every action a
 * computer-using agent takes (mouse click, keystroke, shell command,
 * file edit) before it reaches the workstation.
 *
 * Computer Use ships three tool types — `computer`, `bash`, and
 * `str_replace_editor` (text-editor) — each of which is dramatically
 * higher blast-radius than a typical agent tool. The standard
 * `wardenWrap` recipe still applies because each action lands as a
 * normal Anthropic `tool_use` block; warden inspects every block by
 * default, so wrap-the-client is the entire integration. The job left
 * for the operator is to write policy rules that recognise the tool
 * names and deny what shouldn't run.
 *
 * The starter pack ships a `prod_db_writes` template (good enough as
 * a base for bash command policies). The recipe below shows the
 * shape — extend `policies/agent_workstation.rego` in your deployment
 * with rules keyed off `input.params.name`.
 */
import { wardenWrap, WardenDenied, WardenPending } from '../../src/index.js';
import type { AnthropicLike, AnthropicMessage } from '../../src/index.js';

const endpoint = process.env['WARDEN_ENDPOINT'] ?? 'http://localhost:8088';
const token = process.env['WARDEN_TOKEN'] ?? 'demo-token';

// Real wiring: `import Anthropic from '@anthropic-ai/sdk';
//               const anthropic = new Anthropic();`
//
// The stub below mirrors what Computer Use returns: a `tool_use`
// block whose name matches the tool registered on the request
// (`computer`, `bash`, `str_replace_editor`).
const anthropic: AnthropicLike = {
  messages: {
    async create(): Promise<AnthropicMessage> {
      return {
        id: 'msg-stub',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu-bash-1',
            name: 'bash',
            input: { command: 'rm -rf /var/www/staging' },
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
      { type: 'computer_20250124', name: 'computer', display_width_px: 1024, display_height_px: 768 },
      { type: 'bash_20250124', name: 'bash' },
      { type: 'text_editor_20250124', name: 'str_replace_editor' },
    ],
    messages: [{ role: 'user', content: 'Clean up the staging directory.' }],
  });
  console.log('green — content blocks:', msg.content.map((b) => b.type).join(', '));
} catch (e) {
  if (e instanceof WardenDenied) {
    console.log(`deny (${e.toolName}): ${e.reasons.join('; ')}`);
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
