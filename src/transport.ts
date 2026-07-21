import { ClavenarTransportError } from './errors.js';
import { randomUUID } from 'node:crypto';
import type {
  NormalizedToolCall,
  ClavenarDenyResponse,
  ClavenarAtomicBatchRequest,
  ClavenarInspectRequest,
  ClavenarOptions,
  ClavenarPendingResponse,
  ClavenarPendingView,
  ClavenarRetryOptions,
  ClavenarVerdict,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY: ClavenarRetryOptions = { maxAttempts: 3, baseDelayMs: 100 };
const CORRELATION_HEADER = 'x-clavenar-correlation-id';
export const DECISION_CONTRACT = 'clavenar.decision/v1';
export const DECISION_CONTRACT_HEADER = 'x-clavenar-decision-contract';
export const IDEMPOTENCY_ID_HEADER = 'x-clavenar-idempotency-id';

/**
 * Submit one normalized tool call to clavenar-lite for inspection.
 *
 * Wire contract: `POST {endpoint}/mcp` with a JSON-RPC 2.0 envelope.
 * Server: `clavenar-lite/src/proxy.rs::handle_mcp`.
 *
 * Provider-agnostic — pass an Anthropic `tool_use` block (already
 * satisfies the shape) or an OpenAI tool call passed through
 * `normalizeChatToolCall`.
 *
 * Retry semantics: network failures and 5xx responses retry up to
 * `opts.retry.maxAttempts` (default 3) with jittered exponential
 * backoff. 200, 403, and 429 are verdicts and never retry (429
 * carries `retry_after_secs` for the caller to honor). Other 4xx
 * never retry — those are config errors that won't fix themselves.
 * After the final attempt fails, the last
 * {@link ClavenarTransportError} is thrown.
 *
 * Correlation: when clavenar-lite sets `X-Clavenar-Correlation-Id` on
 * the response, we surface it on the verdict so callers can look
 * the inspection up in the audit ledger.
 */
export async function inspectToolUse(
  toolCall: NormalizedToolCall,
  opts: ClavenarOptions,
): Promise<ClavenarVerdict> {
  const idempotencyId = newIdempotencyId();
  const body: ClavenarInspectRequest = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolCall.name, arguments: toolCall.input },
    id: idempotencyId,
  };
  return inspectDecision(body, idempotencyId, opts);
}

/** Submit a complete ordered sibling set as one atomic decision. */
export async function inspectToolUses(
  toolCalls: readonly NormalizedToolCall[],
  opts: ClavenarOptions,
): Promise<ClavenarVerdict> {
  if (toolCalls.length < 1 || toolCalls.length > 128) {
    throw new ClavenarTransportError('atomic decision batch must contain 1..128 calls');
  }
  const ids = new Set<string>();
  for (const call of toolCalls) {
    if (!call.id || !call.name || ids.has(call.id)) {
      throw new ClavenarTransportError('atomic decision batch requires unique non-empty call ids and names');
    }
    ids.add(call.id);
  }
  const idempotencyId = newIdempotencyId();
  const body: ClavenarAtomicBatchRequest = {
    jsonrpc: '2.0',
    id: idempotencyId,
    method: 'clavenar/tools.batch',
    params: {
      name: 'clavenar.atomic-batch',
      arguments: {
        contract: 'clavenar.atomic-tool-call-batch/v1',
        calls: toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.input })),
      },
    },
  };
  return inspectDecision(body, idempotencyId, opts);
}

async function inspectDecision(
  body: ClavenarInspectRequest | ClavenarAtomicBatchRequest,
  idempotencyId: string,
  opts: ClavenarOptions,
): Promise<ClavenarVerdict> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new ClavenarTransportError('no fetch implementation available (Node 18+ or pass opts.fetch)');
  }
  const retry = opts.retry ?? DEFAULT_RETRY;
  if (retry.maxAttempts < 1) {
    throw new ClavenarTransportError(`retry.maxAttempts must be >= 1, got ${retry.maxAttempts}`);
  }

  let lastErr: ClavenarTransportError | undefined;
  for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
    try {
      return await singleAttempt(body, idempotencyId, opts, fetchImpl);
    } catch (e) {
      if (!(e instanceof ClavenarTransportError)) throw e;
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
  throw lastErr ?? new ClavenarTransportError('clavenar inspect: no attempts ran');
}

async function singleAttempt(
  body: ClavenarInspectRequest | ClavenarAtomicBatchRequest,
  idempotencyId: string,
  opts: ClavenarOptions,
  fetchImpl: typeof fetch,
): Promise<ClavenarVerdict> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [DECISION_CONTRACT_HEADER]: DECISION_CONTRACT,
    [IDEMPOTENCY_ID_HEADER]: idempotencyId,
  };
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
      throw new ClavenarTransportError(`clavenar inspect timed out after ${timeoutMs}ms`);
    }
    throw new ClavenarTransportError(`clavenar inspect failed: ${reason}`);
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

  if (response.status === 202) {
    const payload = await parsePendingBody(response);
    // The header is the load-bearing source of the correlation id —
    // it's set on *every* response. The body field is duplicated for
    // convenience but the header is authoritative.
    const corr = correlationId ?? payload.correlation_id;
    if (corr === undefined || corr.length === 0) {
      throw new ClavenarTransportError(
        'clavenar 202 missing correlation id (header and body both empty)',
        202,
      );
    }
    return { kind: 'pending', correlationId: corr, reviewReasons: payload.review_reasons };
  }

  if (response.status === 429) {
    const payload = await parseRateLimitBody(response);
    const corr = correlationId ?? payload.correlation_id;
    return corr === undefined
      ? { kind: 'rate_limited', payload }
      : { kind: 'rate_limited', payload, correlationId: corr };
  }

  const text = await safeReadText(response);
  throw new ClavenarTransportError(
    `clavenar inspect: unexpected status ${response.status}${text ? `: ${text}` : ''}`,
    response.status,
  );
}

function newIdempotencyId(): string {
  return randomUUID();
}

/**
 * Single `GET /pending/{correlation_id}` poll. Returns the parsed
 * {@link ClavenarPendingView}; the caller's polling loop branches on
 * `decision`. 404 (pending vanished — operator deleted it, ledger
 * corruption, etc.) and 401 (auth misconfig) are terminal and surface
 * as {@link ClavenarTransportError}; 5xx and network failures are too —
 * the resolve loop catches and retries those between polls.
 */
export async function pollPendingOnce(
  correlationId: string,
  opts: Pick<ClavenarOptions, 'endpoint' | 'token' | 'timeoutMs' | 'fetch'>,
): Promise<ClavenarPendingView> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new ClavenarTransportError('no fetch implementation available (Node 18+ or pass opts.fetch)');
  }
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(joinUrl(opts.endpoint, `/pending/${encodeURIComponent(correlationId)}`), {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (e instanceof Error && e.name === 'AbortError') {
      throw new ClavenarTransportError(`clavenar poll timed out after ${timeoutMs}ms`);
    }
    throw new ClavenarTransportError(`clavenar poll failed: ${reason}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 200) {
    return parsePendingViewBody(response);
  }
  const text = await safeReadText(response);
  throw new ClavenarTransportError(
    `clavenar poll: unexpected status ${response.status}${text ? `: ${text}` : ''}`,
    response.status,
  );
}

function isRetriable(e: ClavenarTransportError): boolean {
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

async function parsePendingBody(response: Response): Promise<ClavenarPendingResponse> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new ClavenarTransportError(`clavenar 202 with unparseable body: ${reason}`, 202);
  }
  if (!isPendingResponse(parsed)) {
    throw new ClavenarTransportError(
      `clavenar 202 with unexpected body shape: ${JSON.stringify(parsed)}`,
      202,
    );
  }
  return parsed;
}

function isPendingResponse(v: unknown): v is ClavenarPendingResponse {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r['status'] === 'pending' &&
    typeof r['correlation_id'] === 'string' &&
    Array.isArray(r['review_reasons'])
  );
}

async function parsePendingViewBody(response: Response): Promise<ClavenarPendingView> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new ClavenarTransportError(`clavenar poll with unparseable body: ${reason}`, response.status);
  }
  if (!isPendingView(parsed)) {
    throw new ClavenarTransportError(
      `clavenar poll with unexpected body shape: ${JSON.stringify(parsed)}`,
      response.status,
    );
  }
  return parsed;
}

function isPendingView(v: unknown): v is ClavenarPendingView {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const decision = r['decision'];
  return (
    typeof r['correlation_id'] === 'string' &&
    typeof r['agent_id'] === 'string' &&
    typeof r['tool_type'] === 'string' &&
    typeof r['method'] === 'string' &&
    Array.isArray(r['review_reasons']) &&
    typeof r['requested_at'] === 'string' &&
    (r['decided_at'] === null || typeof r['decided_at'] === 'string') &&
    (decision === null || decision === 'allow' || decision === 'deny') &&
    (r['decider_note'] === null || typeof r['decider_note'] === 'string')
  );
}

async function parseDenyBody(response: Response): Promise<ClavenarDenyResponse> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new ClavenarTransportError(`clavenar 403 with unparseable body: ${reason}`, 403);
  }
  if (!isDenyResponse(parsed)) {
    throw new ClavenarTransportError(
      `clavenar 403 with unexpected body shape: ${JSON.stringify(parsed)}`,
      403,
    );
  }
  // Normalise the envelope: the server omits empty `review_reasons` and
  // absent `intent_category`, and uses several `error` codes / layers.
  // Fill the always-present fields so downstream code stays simple.
  const r = parsed as Record<string, unknown>;
  const deny: ClavenarDenyResponse = {
    error: r['error'] as string,
    reasons: Array.isArray(r['reasons']) ? (r['reasons'] as string[]) : [],
    review_reasons: Array.isArray(r['review_reasons']) ? (r['review_reasons'] as string[]) : [],
    intent_category: typeof r['intent_category'] === 'string' ? (r['intent_category'] as string) : '',
  };
  if (typeof r['verdict'] === 'string') deny.verdict = r['verdict'];
  if (typeof r['layer'] === 'string') deny.layer = r['layer'];
  if (typeof r['correlation_id'] === 'string') deny.correlation_id = r['correlation_id'];
  const detail = parseVerdictDetail(r['detail']);
  if (detail) deny.detail = detail;
  return deny;
}

/**
 * Parse the optional verbose-verdict `detail` object. Lenient — a
 * malformed or absent block just yields `undefined` (the gateway omits
 * it unless `CLAVENAR_PROXY_VERBOSE_VERDICTS=true`).
 */
function parseVerdictDetail(raw: unknown): import('./types.js').ClavenarVerdictDetail | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj['detectors'])) return undefined;
  const detectors = (obj['detectors'] as unknown[])
    .filter((d): d is Record<string, unknown> => d != null && typeof d === 'object')
    .filter((d) => typeof d['detector'] === 'string' && typeof d['score'] === 'number')
    .map((d) => {
      const out: import('./types.js').ClavenarDetectorScore = {
        detector: d['detector'] as string,
        score: d['score'] as number,
      };
      if (typeof d['flagged'] === 'boolean') out.flagged = d['flagged'];
      return out;
    });
  const detail: import('./types.js').ClavenarVerdictDetail = { detectors };
  if (Array.isArray(obj['degraded'])) {
    detail.degraded = (obj['degraded'] as unknown[]).filter((s): s is string => typeof s === 'string');
  }
  return detail;
}

// A deny envelope is anything with a string `error` code; the rest of
// the fields are optional/normalised in `parseDenyBody`.
function isDenyResponse(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r['error'] === 'string';
}

/**
 * Parse the 429 envelope. Lenient like the deny parser: only the
 * string `error` code is required; the verdict falls back to
 * `rate_limited` when the body omits it (both codes ride HTTP 429).
 */
async function parseRateLimitBody(
  response: Response,
): Promise<import('./types.js').ClavenarRateLimitResponse> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new ClavenarTransportError(`clavenar 429 with unparseable body: ${reason}`, 429);
  }
  if (!isDenyResponse(parsed)) {
    throw new ClavenarTransportError(
      `clavenar 429 with unexpected body shape: ${JSON.stringify(parsed)}`,
      429,
    );
  }
  const r = parsed as Record<string, unknown>;
  const out: import('./types.js').ClavenarRateLimitResponse = {
    verdict: r['verdict'] === 'quota_exceeded' ? 'quota_exceeded' : 'rate_limited',
    error: r['error'] as string,
    reasons: Array.isArray(r['reasons'])
      ? (r['reasons'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
  };
  if (typeof r['retry_after_secs'] === 'number') out.retry_after_secs = r['retry_after_secs'];
  if (typeof r['layer'] === 'string') out.layer = r['layer'];
  if (typeof r['correlation_id'] === 'string') out.correlation_id = r['correlation_id'];
  return out;
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
 * an endpoint like `https://gw.example.com/clavenar`.
 */
export function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path.slice(1) : path;
  return `${b}/${p}`;
}
