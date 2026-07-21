import { inspectToolUse } from '../src/index.js';

const endpoint = process.env['CLAVENAR_E2E_ENDPOINT'];
const token = process.env['CLAVENAR_E2E_TOKEN'];
if (!endpoint || !token) throw new Error('live Lite boundary endpoint and token are required');

const options = { endpoint, token, retry: { maxAttempts: 1, baseDelayMs: 1 } };
const deny = await inspectToolUse(
  { id: 'live-boundary-deny', name: 'sql_execute', input: { query: 'select 1' } },
  options,
);
if (deny.kind !== 'deny') throw new Error(`Lite decision deny drifted: ${deny.kind}`);

// The configured upstream is the deliberately unreachable port 9. An allow
// proves the selected decision path returned authorization without executing.
const allow = await inspectToolUse(
  { id: 'live-boundary-allow', name: 'ping', input: { value: 1 } },
  options,
);
if (allow.kind !== 'allow') throw new Error(`Lite decision allow drifted: ${allow.kind}`);
