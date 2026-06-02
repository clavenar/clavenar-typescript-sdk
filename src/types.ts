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
   * Retry policy applied per inspection. Defaults to 3 attempts
   * with 100ms base delay. Set `maxAttempts: 1` to disable retries.
   */
  retry?: ClavenarRetryOptions;
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
  | { kind: 'pending'; correlationId: string; reviewReasons: string[] };

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
 * Retry policy for transient inspection failures. Network errors and
 * 5xx responses retry up to `maxAttempts` times with exponential
 * backoff (`baseDelayMs * 2^attempt`, jittered). 4xx (other than
 * 403, which is a verdict) and 200 never retry.
 */
export interface ClavenarRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
}
