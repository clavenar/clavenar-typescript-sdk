import { ClavenarConfigError, ClavenarTransportError } from './errors.js';
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
const MAX_RETRY_ATTEMPTS = 10;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_RESPONSE_BODY_BYTES = 1 << 20;
const MAX_ERROR_TEXT_BYTES = 4 << 10;
const MAX_TOOL_ARGUMENT_BYTES = 1 << 20;
const MAX_TOOL_BATCH_BYTES = 4 << 20;
const MAX_TOOL_IDENTIFIER_BYTES = 1024;
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
  validateTransportOptions(opts);
  validateToolCall(toolCall);
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
  validateTransportOptions(opts);
  if (toolCalls.length < 1 || toolCalls.length > 128) {
    throw new ClavenarTransportError('atomic decision batch must contain 1..128 calls');
  }
  const ids = new Set<string>();
  let totalArgumentBytes = 0;
  for (const call of toolCalls) {
    validateToolCall(call);
    if (!call.id || !call.name || ids.has(call.id)) {
      throw new ClavenarTransportError('atomic decision batch requires unique non-empty call ids and names');
    }
    ids.add(call.id);
    totalArgumentBytes += jsonBytes(call.input);
    if (totalArgumentBytes > MAX_TOOL_BATCH_BYTES) {
      throw new ClavenarConfigError('atomic decision arguments exceed the batch safety limit');
    }
  }
  // A one-call turn has no siblings to coordinate. Keep its wire shape on the
  // universally supported concrete decision path; true sibling sets retain
  // the single atomic envelope below.
  if (toolCalls.length === 1) {
    return inspectToolUse(toolCalls[0]!, opts);
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
  validateTransportOptions(opts);
  if (opts.transportProfile && opts.fetch) {
    throw new ClavenarTransportError('transportProfile cannot be combined with a custom fetch');
  }
  const fetchImpl = opts.transportProfile?.fetch ?? opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new ClavenarTransportError('no fetch implementation available (Node 18+ or pass opts.fetch)');
  }
  const retry = opts.retry ?? DEFAULT_RETRY;
  let serializedBody: string;
  try {
    serializedBody = JSON.stringify(body);
  } catch (error) {
    throw new ClavenarConfigError(
      `decision request must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Buffer.byteLength(serializedBody, 'utf8') > MAX_TOOL_BATCH_BYTES + 64 * 1024) {
    throw new ClavenarConfigError('decision request exceeds the safety limit');
  }

  let lastErr: ClavenarTransportError | undefined;
  for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
    try {
      return await singleAttempt(serializedBody, idempotencyId, opts, fetchImpl);
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
  body: string,
  idempotencyId: string,
  opts: ClavenarOptions,
  fetchImpl: typeof fetch,
): Promise<ClavenarVerdict> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [DECISION_CONTRACT_HEADER]: DECISION_CONTRACT,
    [IDEMPOTENCY_ID_HEADER]: idempotencyId,
  };
  const token = await resolveToken(opts);
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? opts.transportProfile?.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(joinUrl(opts.endpoint, '/mcp'), {
      method: 'POST',
      headers,
      body,
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

  const selectedContract = response.headers.get(DECISION_CONTRACT_HEADER);
  if (selectedContract !== null && selectedContract !== DECISION_CONTRACT) {
    throw new ClavenarTransportError(
      'clavenar inspect: response selected an unexpected decision contract',
      response.status,
    );
  }

  const correlationId = response.headers.get(CORRELATION_HEADER) ?? undefined;

  if (response.status === 200) {
    const parsed = await parseOptionalJsonBody(response, 'clavenar 200');
    if (parsed !== undefined) {
      const envelope = parsed as Record<string, unknown>;
      if (
        typeof parsed !== 'object'
        || parsed === null
        || Array.isArray(parsed)
        || Object.keys(envelope).length !== 1
        || envelope['verdict'] !== 'allow'
      ) {
        throw new ClavenarTransportError('clavenar 200 with unexpected allow body', 200);
      }
    }
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
    if (
      correlationId !== undefined
      && payload.correlation_id.length > 0
      && correlationId !== payload.correlation_id
    ) {
      throw new ClavenarTransportError('clavenar 202 correlation id header/body mismatch', 202);
    }
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
  opts: Pick<ClavenarOptions, 'endpoint' | 'token' | 'timeoutMs' | 'fetch' | 'transportProfile'>,
): Promise<ClavenarPendingView> {
  validateTransportOptions(opts);
  if (!correlationId || Buffer.byteLength(correlationId, 'utf8') > MAX_TOOL_IDENTIFIER_BYTES) {
    throw new ClavenarConfigError('pending correlation id is required and must be bounded');
  }
  if (opts.transportProfile && opts.fetch) {
    throw new ClavenarTransportError('transportProfile cannot be combined with a custom fetch');
  }
  const fetchImpl = opts.transportProfile?.fetch ?? opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new ClavenarTransportError('no fetch implementation available (Node 18+ or pass opts.fetch)');
  }
  const headers: Record<string, string> = {};
  const token = await resolveToken(opts);
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? opts.transportProfile?.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    const view = await parsePendingViewBody(response);
    if (view.correlation_id !== correlationId) {
      throw new ClavenarTransportError(
        'clavenar poll returned a different correlation id',
        response.status,
      );
    }
    return view;
  }
  const text = await safeReadText(response);
  throw new ClavenarTransportError(
    `clavenar poll: unexpected status ${response.status}${text ? `: ${text}` : ''}`,
    response.status,
  );
}

async function resolveToken(
  opts: Pick<ClavenarOptions, 'token' | 'transportProfile'>,
): Promise<string | undefined> {
  if (opts.token && opts.transportProfile) {
    throw new ClavenarTransportError('token cannot be combined with transportProfile token acquisition');
  }
  return opts.transportProfile ? opts.transportProfile.token() : opts.token;
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
  const ceiling = Math.min(baseMs * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
  return ceiling * (0.5 + Math.random() * 0.5);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parsePendingBody(response: Response): Promise<ClavenarPendingResponse> {
  const parsed = await parseJsonBody(response, 'clavenar 202', 202);
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
  const parsed = await parseJsonBody(response, 'clavenar poll', response.status);
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
  const parsed = await parseJsonBody(response, 'clavenar 403', 403);
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
  const parsed = await parseJsonBody(response, 'clavenar 429', 429);
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
  if (
    typeof r['retry_after_secs'] === 'number'
    && Number.isSafeInteger(r['retry_after_secs'])
    && r['retry_after_secs'] >= 0
  ) {
    out.retry_after_secs = r['retry_after_secs'];
  }
  if (typeof r['layer'] === 'string') out.layer = r['layer'];
  if (typeof r['correlation_id'] === 'string') out.correlation_id = r['correlation_id'];
  return out;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const bytes = await readBoundedBody(response, MAX_ERROR_TEXT_BYTES);
    const preview = bytes.subarray(0, MAX_ERROR_TEXT_BYTES);
    const text = new TextDecoder('utf-8')
      .decode(preview)
      .replace(/[\p{C}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return bytes.byteLength > preview.byteLength ? `${text}...` : text;
  } catch (error) {
    if (error instanceof ClavenarTransportError) throw error;
    return '';
  }
}

async function parseOptionalJsonBody(response: Response, label: string): Promise<unknown | undefined> {
  const bytes = await readBoundedBody(response);
  if (bytes.byteLength === 0 || new TextDecoder().decode(bytes).trim() === '') return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new ClavenarTransportError(
      `${label} with unparseable body: ${error instanceof Error ? error.message : String(error)}`,
      response.status,
    );
  }
}

async function parseJsonBody(response: Response, label: string, status: number): Promise<unknown> {
  const parsed = await parseOptionalJsonBody(response, label);
  if (parsed === undefined) {
    throw new ClavenarTransportError(`${label} with empty body`, status);
  }
  return parsed;
}

async function readBoundedBody(
  response: Response,
  limit = MAX_RESPONSE_BODY_BYTES,
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > limit) {
      throw new ClavenarTransportError(
        `response body exceeds ${limit} bytes`,
        response.status,
      );
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new ClavenarTransportError(
          `response body exceeds ${limit} bytes`,
          response.status,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validateToolCall(call: NormalizedToolCall): void {
  if (!call.id?.trim()) throw new ClavenarConfigError('tool call id is required');
  if (!call.name?.trim()) throw new ClavenarConfigError('tool call name is required');
  if (
    Buffer.byteLength(call.id ?? '', 'utf8') > MAX_TOOL_IDENTIFIER_BYTES
    || Buffer.byteLength(call.name, 'utf8') > MAX_TOOL_IDENTIFIER_BYTES
  ) {
    throw new ClavenarConfigError('tool call id or name exceeds the safety limit');
  }
  if (jsonBytes(call.input) > MAX_TOOL_ARGUMENT_BYTES) {
    throw new ClavenarConfigError('tool call arguments exceed the safety limit');
  }
}

function jsonBytes(value: unknown): number {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new ClavenarConfigError(
      `tool call arguments must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (encoded === undefined) throw new ClavenarConfigError('tool call arguments must be valid JSON');
  return Buffer.byteLength(encoded, 'utf8');
}

/** Validate every direct and wrapped transport entry point consistently. */
export function validateTransportOptions(
  opts: Pick<
    ClavenarOptions,
    | 'endpoint'
    | 'token'
    | 'transportProfile'
    | 'fetch'
    | 'timeoutMs'
    | 'retry'
    | 'mode'
    | 'allowInsecureLoopback'
  >,
): void {
  if (!opts || typeof opts.endpoint !== 'string' || !opts.endpoint) {
    throw new ClavenarConfigError('endpoint is required');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(opts.endpoint);
  } catch {
    throw new ClavenarConfigError('endpoint must be a valid absolute URL');
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new ClavenarConfigError('endpoint must use http or https');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ClavenarConfigError('endpoint must not contain user info, a query, or a fragment');
  }
  if (opts.transportProfile && opts.fetch) {
    throw new ClavenarConfigError('transportProfile cannot be combined with a custom fetch');
  }
  if (opts.token && opts.transportProfile) {
    throw new ClavenarConfigError('token cannot be combined with transportProfile token acquisition');
  }
  if (
    opts.token !== undefined
    && (!opts.token.trim() || opts.token.includes('\r') || opts.token.includes('\n'))
  ) {
    throw new ClavenarConfigError('token must be non-empty and single-line');
  }
  if ((opts.token || opts.transportProfile) && endpoint.protocol !== 'https:') {
    const loopback = endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]';
    if (!opts.allowInsecureLoopback || !loopback) {
      throw new ClavenarConfigError(
        'credentials require https; plaintext is available only for explicitly enabled loopback development',
      );
    }
  }
  const timeoutMs = opts.timeoutMs ?? opts.transportProfile?.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new ClavenarConfigError(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  const retry = opts.retry ?? DEFAULT_RETRY;
  if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1 || retry.maxAttempts > MAX_RETRY_ATTEMPTS) {
    throw new ClavenarConfigError(`retry.maxAttempts must be between 1 and ${MAX_RETRY_ATTEMPTS}`);
  }
  if (!Number.isFinite(retry.baseDelayMs) || retry.baseDelayMs < 0 || retry.baseDelayMs > MAX_RETRY_DELAY_MS) {
    throw new ClavenarConfigError(`retry.baseDelayMs must be between 0 and ${MAX_RETRY_DELAY_MS}`);
  }
  if (opts.mode !== undefined && opts.mode !== 'enforce' && opts.mode !== 'observe') {
    throw new ClavenarConfigError("mode must be 'enforce' or 'observe'");
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
