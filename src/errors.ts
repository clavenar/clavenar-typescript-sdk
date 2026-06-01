/**
 * Thrown when clavenar returns a 403 security_violation for a tool call.
 * Carries the structured reason payload from clavenar-lite so callers
 * can branch on `intent_category` or surface `reasons` to a human.
 */
export class ClavenarDenied extends Error {
  override readonly name = 'ClavenarDenied';
  readonly reasons: string[];
  readonly reviewReasons: string[];
  readonly intentCategory: string;
  readonly toolName: string;
  /**
   * Clavenar's correlation id for this inspection, when clavenar-lite
   * sets `X-Clavenar-Correlation-Id`. Use this to look the call up in
   * the audit ledger. Undefined when the deployment doesn't emit the
   * header (older builds, partner-deployed gateways).
   */
  readonly correlationId: string | undefined;

  constructor(args: {
    toolName: string;
    reasons: string[];
    reviewReasons: string[];
    intentCategory: string;
    correlationId?: string;
  }) {
    super(`clavenar denied tool "${args.toolName}": ${args.reasons.join(' | ')}`);
    this.toolName = args.toolName;
    this.reasons = args.reasons;
    this.reviewReasons = args.reviewReasons;
    this.intentCategory = args.intentCategory;
    this.correlationId = args.correlationId;
  }
}

import type { ClavenarPendingView, ClavenarResolveOptions } from './types.js';

/**
 * Thrown when clavenar parks a tool call for human review (the 202
 * yellow-tier path).
 *
 * Catch it, decide how the agent should behave during the wait, then
 * `await pending.resolve()` to block until an operator decides. The
 * promise resolves cleanly on `allow` and rejects with
 * {@link ClavenarDenied} on `deny`, so a tool-execution loop wrapping
 * the call in `try`/`catch` keeps the same control flow as the
 * synchronous path — pending is just "deny that hasn't decided yet."
 *
 * A `pending.resolve()` that times out throws
 * {@link ClavenarTransportError} rather than synthesising a deny. The
 * default ceiling is 10 minutes — set `timeoutMs` on the option bag
 * to extend it for slow Slack-approval flows.
 */
export class ClavenarPending extends Error {
  override readonly name = 'ClavenarPending';
  readonly toolName: string;
  readonly correlationId: string;
  readonly reviewReasons: string[];
  /**
   * Single-shot polling callback bound to the SDK's transport. Held
   * in a private field so the constructor stays free of a circular
   * import from transport — the wrap/stream caller pre-binds the
   * endpoint, token, and fetch impl into this closure at throw time.
   */
  private readonly _pollOnce: () => Promise<ClavenarPendingView>;

  constructor(args: {
    toolName: string;
    correlationId: string;
    reviewReasons: string[];
    pollOnce: () => Promise<ClavenarPendingView>;
  }) {
    super(
      `clavenar parked tool "${args.toolName}" for review (correlation_id=${args.correlationId})`,
    );
    this.toolName = args.toolName;
    this.correlationId = args.correlationId;
    this.reviewReasons = args.reviewReasons;
    this._pollOnce = args.pollOnce;
  }

  /**
   * Block until an operator decides. Polls
   * `GET /pending/{correlationId}` every `pollIntervalMs` (default
   * 2_000) and resolves when `decision` flips. Returns void on
   * approve; throws {@link ClavenarDenied} on deny.
   *
   * Transient transport errors (5xx, network blips) are swallowed
   * between polls — the loop just continues. Terminal failures (404,
   * 401, body-shape mismatch) re-throw immediately as
   * {@link ClavenarTransportError}. The deadline is enforced as a hard
   * wall-clock ceiling.
   */
  async resolve(opts?: ClavenarResolveOptions): Promise<void> {
    const pollIntervalMs = opts?.pollIntervalMs ?? 2_000;
    const timeoutMs = opts?.timeoutMs ?? 600_000;
    if (pollIntervalMs <= 0) {
      throw new ClavenarTransportError(
        `ClavenarPending.resolve: pollIntervalMs must be positive, got ${pollIntervalMs}`,
      );
    }
    if (timeoutMs <= 0) {
      throw new ClavenarTransportError(
        `ClavenarPending.resolve: timeoutMs must be positive, got ${timeoutMs}`,
      );
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let view: ClavenarPendingView | undefined;
      try {
        view = await this._pollOnce();
      } catch (e) {
        if (e instanceof ClavenarTransportError) {
          // 401 / 404 are terminal: auth misconfig, or the pending
          // vanished. Surface immediately. Everything else (5xx,
          // network blip) gets swallowed and we'll retry next tick.
          if (e.status === 401 || e.status === 404) throw e;
        } else {
          throw e;
        }
      }
      if (view && view.decision === 'allow') return;
      if (view && view.decision === 'deny') {
        throw new ClavenarDenied({
          toolName: this.toolName,
          reasons: view.decider_note != null && view.decider_note.length > 0
            ? [view.decider_note]
            : ['operator denied'],
          reviewReasons: this.reviewReasons,
          intentCategory: 'PendingDenied',
          correlationId: this.correlationId,
        });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollIntervalMs, remaining));
    }
    throw new ClavenarTransportError(
      `clavenar pending ${this.correlationId} not decided within ${timeoutMs}ms`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thrown for malformed config — bad endpoint URL, missing client, etc. */
export class ClavenarConfigError extends Error {
  override readonly name = 'ClavenarConfigError';
}

/** Thrown when clavenar itself is unreachable or returns an unexpected shape. */
export class ClavenarTransportError extends Error {
  override readonly name = 'ClavenarTransportError';
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}
