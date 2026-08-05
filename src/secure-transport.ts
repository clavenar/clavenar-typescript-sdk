import { readFileSync } from 'node:fs';
import {
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
} from 'undici';
import { ClavenarConfigError } from './errors.js';

export type TokenProvider = () =>
  | string
  | undefined
  | Promise<string | undefined>;

export type ProxyPolicy =
  | { mode: 'direct' }
  | { mode: 'environment' }
  | { mode: 'explicit'; url: string };

export interface SecureTransportConfig {
  caBundlePath: string;
  clientCertificatePath: string;
  privateKeyPath: string;
  tokenProvider?: TokenProvider;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  proxy?: ProxyPolicy;
}

/**
 * One reusable mTLS transport snapshot for every SDK request.
 *
 * `reload()` constructs the complete replacement dispatcher before publishing
 * it. Existing requests retain the old dispatcher; later calls use the new
 * CA, certificate, key, deadlines, and proxy policy together.
 */
export class SecureTransportProfile {
  readonly requestTimeoutMs: number;
  private readonly config: SecureTransportConfig;
  private dispatcher: Dispatcher;
  private lifecycle: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(config: SecureTransportConfig) {
    this.config = { ...config };
    this.requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
    this.validate();
    this.dispatcher = this.buildDispatcher();
  }

  async token(): Promise<string | undefined> {
    if (this.closed) throw new ClavenarConfigError('secure transport profile is closed');
    const token = await this.config.tokenProvider?.();
    if (token === undefined) return undefined;
    const trimmed = token.trim();
    if (!trimmed) throw new ClavenarConfigError('secure transport token provider returned an empty token');
    if (trimmed.includes('\r') || trimmed.includes('\n')) {
      throw new ClavenarConfigError('secure transport token provider returned a multi-line token');
    }
    return trimmed;
  }

  reload(): Promise<void> {
    const operation = this.lifecycle.then(async () => {
      if (this.closed) throw new ClavenarConfigError('secure transport profile is closed');
      const replacement = this.buildDispatcher();
      const previous = this.dispatcher;
      this.dispatcher = replacement;
      await previous.close();
    });
    this.lifecycle = operation.catch(() => undefined);
    return operation;
  }

  /** Close the active dispatcher after all prior reloads have completed. */
  close(): Promise<void> {
    const operation = this.lifecycle.then(async () => {
      if (this.closed) return;
      this.closed = true;
      await this.dispatcher.close();
    });
    this.lifecycle = operation.catch(() => undefined);
    return operation;
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    if (this.closed) throw new ClavenarConfigError('secure transport profile is closed');
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: this.dispatcher,
    }) as unknown as Promise<Response>;
  };

  private validate(): void {
    const connect = this.config.connectTimeoutMs ?? 5_000;
    if (
      !Number.isFinite(connect)
      || !Number.isFinite(this.requestTimeoutMs)
      || connect <= 0
      || this.requestTimeoutMs <= 0
      || connect > 300_000
      || this.requestTimeoutMs > 300_000
    ) {
      throw new ClavenarConfigError(
        'secure transport timeouts must be positive and no greater than 300000ms',
      );
    }
    for (const [label, value] of [
      ['CA bundle', this.config.caBundlePath],
      ['client certificate', this.config.clientCertificatePath],
      ['private key', this.config.privateKeyPath],
    ]) {
      if (!value) throw new ClavenarConfigError(`secure transport ${label} path is required`);
    }
  }

  private buildDispatcher(): Dispatcher {
    const tls = {
      ca: readRequired(this.config.caBundlePath, 'CA bundle'),
      cert: readRequired(this.config.clientCertificatePath, 'client certificate'),
      key: readRequired(this.config.privateKeyPath, 'private key'),
      timeout: this.config.connectTimeoutMs ?? 5_000,
    };
    const proxy = this.config.proxy ?? { mode: 'direct' };
    if (proxy.mode === 'environment') {
      return new EnvHttpProxyAgent({ connect: tls });
    }
    if (proxy.mode === 'explicit') {
      let url: URL;
      try {
        url = new URL(proxy.url);
      } catch {
        throw new ClavenarConfigError('secure transport explicit proxy URL is invalid');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ClavenarConfigError('secure transport explicit proxy must use HTTP or HTTPS');
      }
      if (url.username || url.password || url.search || url.hash) {
        throw new ClavenarConfigError(
          'secure transport explicit proxy must not contain user info, a query, or a fragment',
        );
      }
      return new ProxyAgent({ uri: url.toString(), requestTls: tls });
    }
    return new Agent({ connect: tls });
  }
}

function readRequired(path: string, label: string): Buffer {
  let value: Buffer;
  try {
    value = readFileSync(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ClavenarConfigError(`cannot read secure transport ${label} ${path}: ${reason}`);
  }
  if (value.length === 0) {
    throw new ClavenarConfigError(`secure transport ${label} ${path} is empty`);
  }
  return value;
}
