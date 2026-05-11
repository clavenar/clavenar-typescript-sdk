/**
 * Configuration for {@link wardenWrap}.
 *
 * `endpoint` is the warden-lite ingress URL. `token` is the optional
 * shared bearer set via `WARDEN_LITE_TOKEN`. `mode` mirrors the
 * future `WARDEN_MODE` env on the server: in `observe` the SDK
 * inspects + logs but never blocks. Server-side observe ships in
 * roadmap week 3; the client-side override is here so partners can
 * force-observe per-call during rollout without server changes.
 */
export interface WardenOptions {
  endpoint: string;
  token?: string;
  mode?: 'enforce' | 'observe';
  /** Per-request timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /** Override the global fetch (testing). */
  fetch?: typeof fetch;
  /**
   * Called once per inspected tool_use with the verdict warden
   * returned. Fires before any deny→throw translation, so callers
   * can record observe-mode telemetry without changing the throw
   * semantics. Errors thrown here are propagated to the caller.
   */
  onVerdict?: (verdict: WardenVerdict, ctx: WardenVerdictContext) => void | Promise<void>;
}

/** Context passed to {@link WardenOptions.onVerdict}. */
export interface WardenVerdictContext {
  toolName: string;
  toolUseId: string;
  toolInput: unknown;
}

/**
 * Wire shape of warden-lite's `POST /mcp` request body. Mirrors
 * `McpRequest` in `warden-lite/src/proxy.rs`. We send `tools/call` as
 * the method and pack tool name + arguments into `params`.
 */
export interface WardenInspectRequest {
  jsonrpc: '2.0';
  method: string;
  params: {
    name: string;
    arguments: unknown;
  };
  id: string;
}

/**
 * Wire shape of warden-lite's 403 `security_violation` response. Any
 * non-403 response is opaque (200 means "the upstream forwarded
 * fine"); only the deny payload has a defined shape.
 */
export interface WardenDenyResponse {
  error: 'security_violation';
  reasons: string[];
  review_reasons: string[];
  intent_category: string;
}

/**
 * Result of inspecting one tool call. Internal — callers receive a
 * thrown error on deny instead of a tagged union.
 */
export type WardenVerdict =
  | { kind: 'allow' }
  | { kind: 'deny'; payload: WardenDenyResponse }
  | { kind: 'pending'; correlationId: string };
