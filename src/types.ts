/**
 * Configuration for {@link clavenarWrap}.
 *
 * `endpoint` is the clavenar-lite ingress URL. `token` is the optional
 * shared bearer set via `CLAVENAR_LITE_TOKEN`. `mode` mirrors the
 * future `CLAVENAR_MODE` env on the server: in `observe` the SDK
 * inspects + logs but never blocks. Server-side observe ships in
 * roadmap week 3; the client-side override is here so partners can
 * force-observe per-call during rollout without server changes.
 */
export interface ClavenarOptions {
  endpoint: string;
  token?: string;
  mode?: 'enforce' | 'observe';
  /** Per-request timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /** Override the global fetch (testing). */
  fetch?: typeof fetch;
  /**
   * DANGEROUS: allow the provider SDK's `.stream()` helper
   * (`messages.stream()` / `chat.completions.stream()`) to pass
   * through UNINSPECTED. Off by default — the helper's rich event
   * interface can't be wrapped faithfully, so tool calls made through
   * it would bypass clavenar entirely. Prefer
   * `create({ stream: true })`, which is fully inspected.
   */
  allowUninspectedStream?: boolean;
  /**
   * Called once per inspected tool_use with the verdict clavenar
   * returned. Fires before any deny→throw translation, so callers
   * can record observe-mode telemetry without changing the throw
   * semantics. Errors thrown here are propagated to the caller.
   */
  onVerdict?: (verdict: ClavenarVerdict, ctx: ClavenarVerdictContext) => void | Promise<void>;
  /**
   * Called when an inspection fails at the transport layer (clavenar
   * unreachable, 5xx after retries exhausted, malformed body, …).
   *
   * In `mode: 'observe'` this fires per failed inspection and the
   * underlying agent call is treated as allowed — the SDK's
   * observe-mode promise ("no throw, response passes through") is
   * preserved even when clavenar itself is down. Use this hook to log
   * / alert / fall back to a default deny on your side.
   *
   * In `mode: 'enforce'` the SDK still throws the transport error
   * (fail-closed is the safer enforce semantic), and this callback
   * is NOT invoked — wrap the create() call in try/catch like any
   * other transport failure.
   *
   * Errors thrown from the callback itself are propagated to the
   * caller. Default: no-op.
   */
  onPolicyError?: (
    error: import('./errors.js').ClavenarTransportError,
    ctx: ClavenarVerdictContext,
  ) => void | Promise<void>;
  /**
   * Retry policy applied only to the explicit side-effect-free decision
   * request. Defaults to 3 attempts with 100ms base delay; every attempt
   * retains the same pre-network idempotency ID. Registered execution is
   * outside this loop and is never retried. Set `maxAttempts: 1` to disable
   * decision retries.
   */
  retry?: ClavenarRetryOptions;
  /**
   * Developer mode: when a tool call is denied, render the gateway's
   * verbose-verdict `detail` breakdown (per-detector scores, degraded
   * lanes, matched reasons, correlation id) to stderr before throwing.
   * Off by default. The breakdown is only present when the gateway runs
   * with `CLAVENAR_PROXY_VERBOSE_VERDICTS=true` (Lite `--verbose-verdicts`);
   * otherwise a hint to enable it is printed. Dev/staging only — detailed
   * denials are an attacker oracle.
   */
  devMode?: boolean;
}

/**
 * One detector's contribution to a verbose-verdict deny. `score` is the
 * numeric signal in `[0, 1]`; `flagged` is the boolean verdict on the
 * boolean lanes (`injection` / `malicious_code` / `compromised_package`)
 * and absent on the numeric lanes (`persona_drift` / `sequence_escalation`),
 * where `score` is the value to read.
 */
export interface ClavenarDetectorScore {
  detector: string;
  score: number;
  flagged?: boolean;
}

/**
 * The verbose-verdict `detail` object: present on a deny/pend body only
 * when the gateway runs with `CLAVENAR_PROXY_VERBOSE_VERDICTS=true`.
 */
export interface ClavenarVerdictDetail {
  detectors: ClavenarDetectorScore[];
  /** Detector lanes that served a fallback verdict (omitted when none). */
  degraded?: string[];
}

/** Context passed to {@link ClavenarOptions.onVerdict}. */
export interface ClavenarVerdictContext {
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
}

/**
 * Provider-agnostic shape of one tool call ready for inspection.
 * Anthropic `tool_use` blocks satisfy this directly. OpenAI
 * `tool_calls` entries reach this shape via `normalizeChatToolCall`
 * (which JSON-parses the string `arguments` field).
 *
 * The `id` round-trips into clavenar-lite's ledger as the JSON-RPC
 * envelope id — `toolu_*` for Anthropic, `call_*` for OpenAI. Both
 * are dense enough to correlate a verdict back to the model's exact
 * call.
 */
export interface NormalizedToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * Wire shape of clavenar-lite's `POST /mcp` request body. Mirrors
 * `McpRequest` in `clavenar-lite/src/proxy.rs`. We send `tools/call` as
 * the method and pack tool name + arguments into `params`.
 */
export interface ClavenarInspectRequest {
  jsonrpc: '2.0';
  method: string;
  params: {
    name: string;
    arguments: unknown;
  };
  id: string;
}

/** One ordered, side-effect-free decision request for a complete model turn. */
export interface ClavenarAtomicBatchRequest {
  jsonrpc: '2.0';
  method: 'clavenar/tools.batch';
  params: {
    name: 'clavenar.atomic-batch';
    arguments: {
      contract: 'clavenar.atomic-tool-call-batch/v1';
      calls: Array<{ id: string; name: string; arguments: unknown }>;
    };
  };
  id: string;
}

/**
 * Wire shape of the shared 403 error envelope emitted by both
 * clavenar-lite and full-edition clavenar-proxy. `error` is a machine
 * code (`security_violation`, `egress_blocked`, `review_denied`,
 * `pipeline_unavailable`, …); `layer` names the stage that said no
 * (`brain`, `policy`, `hil`, `egress`, …). `review_reasons` and
 * `intent_category` are normalised to present values by the transport
 * even when the server omits them.
 */
export interface ClavenarDenyResponse {
  error: string;
  reasons: string[];
  review_reasons: string[];
  intent_category: string;
  /** Coarse outcome (`denied`, `review_denied`, …), when reported. */
  verdict?: string;
  /** Stage that produced the deny, when reported. */
  layer?: string;
  /** Proxy-stamped join key for the audit row, when in the body. */
  correlation_id?: string;
  /**
   * Per-detector verdict breakdown — present only under the gateway's
   * verbose-verdict opt-in (`CLAVENAR_PROXY_VERBOSE_VERDICTS=true`).
   */
  detail?: ClavenarVerdictDetail;
}

/**
 * Result of inspecting one tool call. Internal — callers receive a
 * thrown error on deny instead of a tagged union.
 *
 * `correlationId` (when present) is the value clavenar-lite sets on
 * the `X-Clavenar-Correlation-Id` response header — opaque to the SDK,
 * load-bearing for ledger lookups partner-side.
 */
export type ClavenarVerdict =
  | { kind: 'allow'; correlationId?: string }
  | { kind: 'deny'; payload: ClavenarDenyResponse; correlationId?: string }
  | { kind: 'pending'; correlationId: string; reviewReasons: string[] }
  | { kind: 'rate_limited'; payload: ClavenarRateLimitResponse; correlationId?: string };

/**
 * Wire shape of the 429 error envelope (spec §"Agent-facing error
 * envelope"): `rate_limited` is the request-velocity gate,
 * `quota_exceeded` the per-tenant spend gate. `retry_after_secs` is
 * only set on `rate_limited`.
 */
export interface ClavenarRateLimitResponse {
  verdict: 'rate_limited' | 'quota_exceeded';
  error: string;
  reasons: string[];
  retry_after_secs?: number;
  layer?: string;
  correlation_id?: string;
}

/**
 * Wire shape of clavenar-lite's 202 Accepted body (yellow tier — the
 * request was parked for human review). Matches the `PendingResponse`
 * struct in `clavenar-lite/src/proxy.rs`.
 */
export interface ClavenarPendingResponse {
  status: 'pending';
  correlation_id: string;
  review_reasons: string[];
}

/**
 * Wire shape of clavenar-lite's `GET /pending/{id}` and decide
 * responses. Mirrors `PendingView` in `clavenar-lite/src/proxy.rs`.
 * `decision` is `null` until an operator decides; the SDK's polling
 * loop watches this field.
 */
export interface ClavenarPendingView {
  correlation_id: string;
  agent_id: string;
  tool_type: string;
  method: string;
  review_reasons: string[];
  requested_at: string;
  decided_at: string | null;
  decision: 'allow' | 'deny' | null;
  decider_note: string | null;
}

/**
 * Options for {@link ClavenarPending.resolve}. Both knobs are bounded:
 * partners override them per-call if their human-approval cycle is
 * either much faster (in-product approval button) or much slower
 * (Slack notification to oncall).
 */
export interface ClavenarResolveOptions {
  /** Milliseconds between polls. Default 2000. */
  pollIntervalMs?: number;
  /** Hard ceiling on the total wait. Default 600_000 (10 minutes). */
  timeoutMs?: number;
}

/**
 * Retry policy for transient side-effect-free decision failures. Network errors and
 * 5xx responses retry up to `maxAttempts` times with exponential
 * backoff (`baseDelayMs * 2^attempt`, jittered) with one stable request
 * identity. Effect-capable execution never uses this policy. 4xx (other than
 * 403, which is a verdict) and 200 never retry.
 */
export interface ClavenarRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
}
