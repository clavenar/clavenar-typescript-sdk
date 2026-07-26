import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecureTransportProfile } from '../src/secure-transport.js';

function sources(): { ca: string; cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 'clavenar-secure-transport-'));
  const ca = join(dir, 'ca.pem');
  const cert = join(dir, 'client.pem');
  const key = join(dir, 'client.key');
  writeFileSync(ca, 'not-empty');
  writeFileSync(cert, 'not-empty');
  writeFileSync(key, 'not-empty');
  return { ca, cert, key };
}

describe('SecureTransportProfile', () => {
  it('acquires a fresh trimmed token for every request', async () => {
    const files = sources();
    let generation = 0;
    const profile = new SecureTransportProfile({
      caBundlePath: files.ca,
      clientCertificatePath: files.cert,
      privateKeyPath: files.key,
      tokenProvider: () => ` token-${++generation} `,
    });
    await expect(profile.token()).resolves.toBe('token-1');
    await expect(profile.token()).resolves.toBe('token-2');
  });

  it('rejects zero deadlines before reading credential files', () => {
    expect(
      () =>
        new SecureTransportProfile({
          caBundlePath: 'missing',
          clientCertificatePath: 'missing',
          privateKeyPath: 'missing',
          connectTimeoutMs: 0,
        }),
    ).toThrow(/timeouts must be positive/);
  });

  it('rejects empty tokens', async () => {
    const files = sources();
    const profile = new SecureTransportProfile({
      caBundlePath: files.ca,
      clientCertificatePath: files.cert,
      privateKeyPath: files.key,
      tokenProvider: () => ' ',
    });
    await expect(profile.token()).rejects.toThrow(/empty token/);
  });
});
