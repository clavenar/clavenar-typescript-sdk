import { copyFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SecureTransportProfile } from '../src/secure-transport.js';
import { inspectToolUse } from '../src/transport.js';

const endpoint = process.env.CLAVENAR_SECURE_TRANSPORT_ENDPOINT;

describe.runIf(Boolean(endpoint))('secure transport live mTLS rotation', () => {
  it('uses the initial and rotated client identity with fresh tokens', async () => {
    const cert = required('CLAVENAR_SECURE_TRANSPORT_CLIENT_CERT');
    const key = required('CLAVENAR_SECURE_TRANSPORT_CLIENT_KEY');
    let tokenGeneration = 0;
    const profile = new SecureTransportProfile({
      caBundlePath: required('CLAVENAR_SECURE_TRANSPORT_CA'),
      clientCertificatePath: cert,
      privateKeyPath: key,
      tokenProvider: () => `matrix-token-${++tokenGeneration}`,
      proxy: { mode: 'direct' },
    });
    const call = { id: 'matrix', name: 'matrix_probe', input: {} };
    await expect(inspectToolUse(call, { endpoint: endpoint!, transportProfile: profile })).resolves
      .toMatchObject({ kind: 'allow' });

    copyFileSync(required('CLAVENAR_SECURE_TRANSPORT_NEXT_CERT'), cert);
    copyFileSync(required('CLAVENAR_SECURE_TRANSPORT_NEXT_KEY'), key);
    profile.reload();
    await expect(inspectToolUse(call, { endpoint: endpoint!, transportProfile: profile })).resolves
      .toMatchObject({ kind: 'allow' });
    expect(tokenGeneration).toBe(2);
  });
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
