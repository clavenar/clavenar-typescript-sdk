import { WardenTransportError } from './errors.js';
import type {
  NormalizedToolCall,
  WardenDenyResponse,
  WardenInspectRequest,
  WardenOptions,
  WardenRetryOptions,
  WardenVerdict,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY: WardenRetryOptions = { maxAttempts: 3, baseDelayMs: 100 };
const CORRELATION_HEADER = 'x-warden-correlation-id';

/**
 * Submit one normalized tool call to warden-lite for inspection.
 *
 * Wire contract: `POST {endpoint}/mcp` with a JSON-RPC 2.0 envelope.
 * Server: `warden-lite/src/proxy.rs::handle_mcp`.
 *
 * Provider-agnostic — pass an Anthropic `tool_use` block (already
 * satisfies the shape) or an OpenAI tool call passed through
 * `normalizeChatToolCall`.
 *
 * Retry semantics: network failures and 5xx responses retry up to
 * `opts.retry.maxAttempts` (default 3) with jittered exponential
 * backoff. 200 and 403 are verdicts and never retry. Other 4xx never
 * retry — those are config errors that won't fix themselves. After
 * the final attempt fails, the last {@link WardenTransportError} is
 * thrown.
 *
 * Correlation: when warden-lite sets `X-Warden-Correlation-Id` on
 * the response, we surface it on the verdict so callers can look
 * the inspection up in the audit ledger.
 */
export async function inspectToolUse(
  toolCall: NormalizedToolCall,
  opts: WardenOptions,
): Promise<WardenVerdict> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new WardenTransportError('no fetch implementation available (Node 18+ or pass opts.fetch)');
  }
  const retry = opts.retry ?? DEFAULT_RETRY;
  if (retry.maxAttempts < 1) {
    throw new WardenTransportError(`retry.maxAttempts must be >= 1, got ${retry.maxAttempts}`);
  }

  let lastErr: WardenTransportError | undefined;
  for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
    try {
      return await singleAttempt(toolCall, opts, fetchImpl);
    } catch (e) {
      if (!(e instanceof WardenTransportError)) throw e;
      lastErr = e;
      if (!isRetriable(e) || attempt === retry.maxAttempts - 1) {
        throw e;
      }
      await sleep(backoffMs(retry.baseDelayMs, attempt));
    }
  }
  // Unreachable — the loop above either returns or throws on the
  // final attempt — but ts can't see that, so satisfy the type
  // checker.
  throw lastErr ?? new WardenTransportError('warden inspect: no attempts ran');
}

async function singleAttempt(
  toolCall: NormalizedToolCall,
  opts: WardenOptions,
  fetchImpl: typeof fetch,
): Promise<WardenVerdict> {
  const body: WardenInspectRequest = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolCall.name, arguments: toolCall.input },
    id: toolCall.id,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(joinUrl(opts.endpoint, '/mcp'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (e instanceof Error && e.name === 'AbortError') {
      throw new WardenTransportError(`warden inspect timed out after ${timeoutMs}ms`);
    }
    throw new WardenTransportError(`warden inspect failed: ${reason}`);
  } finally {
    clearTimeout(timeoutId);
  }

  const correlationId = response.headers.get(CORRELATION_HEADER) ?? undefined;

  if (response.status === 200) {
    return correlationId === undefined ? { kind: 'allow' } : { kind: 'allow', correlationId };
  }

  if (response.status === 403) {
    const payload = await parseDenyBody(response);
    return correlationId === undefined
      ? { kind: 'deny', payload }
      : { kind: 'deny', payload, correlationId };
  }

  const text = await safeReadText(response);
  throw new WardenTransportError(
    `warden inspect: unexpected status ${response.status}${text ? `: ${text}` : ''}`,
    response.status,
  );
}

function isRetriable(e: WardenTransportError): boolean {
  // No status → fetch itself rejected (DNS, ECONNREFUSED, abort).
  // Retryable. 5xx → server error, retry. Everything else (401, 404,
  // 400) is a config error — retrying won't help.
  if (e.status === undefined) return true;
  return e.status >= 500 && e.status < 600;
}

function backoffMs(baseMs: number, attempt: number): number {
  // Exponential with full jitter: random in [base*2^attempt/2, base*2^attempt].
  // Prevents the synchronized-retry thundering-herd partners hit at
  // scale, while keeping the bound tight enough to be useful in a
  // single-tenant SDK.
  const ceiling = baseMs * Math.pow(2, attempt);
  return ceiling * (0.5 + Math.random() * 0.5);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseDenyBody(response: Response): Promise<WardenDenyResponse> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new WardenTransportError(`warden 403 with unparseable body: ${reason}`, 403);
  }
  if (!isDenyResponse(parsed)) {
    throw new WardenTransportError(
      `warden 403 with unexpected body shape: ${JSON.stringify(parsed)}`,
      403,
    );
  }
  return parsed;
}

function isDenyResponse(v: unknown): v is WardenDenyResponse {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r['error'] === 'security_violation' &&
    Array.isArray(r['reasons']) &&
    Array.isArray(r['review_reasons']) &&
    typeof r['intent_category'] === 'string'
  );
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * Join a base URL with a path. Drops a trailing slash on base and a
 * leading slash on path so `joinUrl('http://x/', '/mcp')` and
 * `joinUrl('http://x', 'mcp')` both yield `http://x/mcp`. We do not
 * use `new URL(path, base)` — its resolution rules drop the base path
 * for absolute-looking paths, which surprises partners who configure
 * an endpoint like `https://gw.example.com/warden`.
 */
export function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path.slice(1) : path;
  return `${b}/${p}`;
}
