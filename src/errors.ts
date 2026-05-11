/**
 * Thrown when warden returns a 403 security_violation for a tool call.
 * Carries the structured reason payload from warden-lite so callers
 * can branch on `intent_category` or surface `reasons` to a human.
 */
export class WardenDenied extends Error {
  override readonly name = 'WardenDenied';
  readonly reasons: string[];
  readonly reviewReasons: string[];
  readonly intentCategory: string;
  readonly toolName: string;

  constructor(args: {
    toolName: string;
    reasons: string[];
    reviewReasons: string[];
    intentCategory: string;
  }) {
    super(`warden denied tool "${args.toolName}": ${args.reasons.join(' | ')}`);
    this.toolName = args.toolName;
    this.reasons = args.reasons;
    this.reviewReasons = args.reviewReasons;
    this.intentCategory = args.intentCategory;
  }
}

/**
 * Thrown when warden parks a tool call for human review.
 *
 * Lite does not surface Yellow-tier pendings (full edition only), but
 * the SDK still models the case so a future full-edition target can
 * use the same wrap pattern. Week 4 of the roadmap turns this into a
 * non-throwing async path with a callback URL.
 */
export class WardenPending extends Error {
  override readonly name = 'WardenPending';
  readonly toolName: string;
  readonly correlationId: string;

  constructor(args: { toolName: string; correlationId: string }) {
    super(`warden parked tool "${args.toolName}" for review (correlation_id=${args.correlationId})`);
    this.toolName = args.toolName;
    this.correlationId = args.correlationId;
  }
}

/** Thrown for malformed config — bad endpoint URL, missing client, etc. */
export class WardenConfigError extends Error {
  override readonly name = 'WardenConfigError';
}

/** Thrown when warden itself is unreachable or returns an unexpected shape. */
export class WardenTransportError extends Error {
  override readonly name = 'WardenTransportError';
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}
