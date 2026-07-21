import { ClavenarTransportError, inspectToolUse } from '../src/index.js';

const endpoint = process.env['CLAVENAR_E2E_ENDPOINT'];
const token = process.env['CLAVENAR_E2E_TOKEN'];
if (!endpoint || !token) throw new Error('live Lite boundary endpoint and token are required');

try {
  await inspectToolUse(
    { id: 'live-boundary', name: 'sql_execute', input: { query: 'select 1' } },
    { endpoint, token, retry: { maxAttempts: 1, baseDelayMs: 1 } },
  );
  throw new Error('Lite unexpectedly accepted the side-effect-free decision contract');
} catch (error) {
  if (!(error instanceof ClavenarTransportError) || error.status !== 400) throw error;
  if (!error.message.includes('side_effect_free_decision_unsupported')) throw error;
}
