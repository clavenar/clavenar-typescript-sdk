import { ClavenarConfigError, ClavenarTransportError } from './errors.js';
import { randomUUID } from 'node:crypto';
import type { ClavenarRetryOptions } from './types.js';
import {
  DECISION_CONTRACT,
  DECISION_CONTRACT_HEADER,
  IDEMPOTENCY_ID_HEADER,
} from './transport.js';

export const EXECUTION_CONTRACT = 'clavenar.execution/v1';
export const DURABLE_EXECUTION_CONTRACT = 'clavenar.sdk-durable-intent-outbox/v1';

export interface PreparedToolRequest {
  idempotencyId: string;
  name: string;
  arguments: unknown;
}

export interface ToolExecutionRequest {
  authorizationId: string;
  idempotencyId: string;
  executorId: string;
  executionPayload: unknown;
}

export interface ExecutionEffect {
  result: unknown;
  effectId: string;
}

export interface WorkloadSignature {
  algorithm: string;
  credential_fingerprint: string;
  value: string;
}

export interface SignedAuthorization {
  authorization: {
    contract: string;
    stage: string;
    authorization_id: string;
    idempotency_id: string;
    correlation_id: string;
    agent_id: string;
    agent_spiffe: string;
    tenant: string;
    credential_fingerprint: string;
    method: string;
    tool_name: string;
    execution_payload: unknown;
    payload_sha256: string;
    decision_principal: unknown;
    modification_diff?: unknown;
    policy_bundle: unknown;
    brain_version: string;
    brain_evidence_sha256: string;
  };
  identity_signature: unknown;
}

export interface ExecutionIntent {
  contract: typeof DURABLE_EXECUTION_CONTRACT;
  stage: 'execution.intent';
  authorization_id: string;
  idempotency_id: string;
  tenant: string;
  workload_id: string;
  workload_spiffe: string;
  payload_sha256: string;
  executor_id: string;
  authorization: SignedAuthorization;
}

export interface ExecutionReceipt {
  contract: typeof EXECUTION_CONTRACT;
  stage: 'execution.completed';
  authorization_id: string;
  idempotency_id: string;
  correlation_id: string;
  agent_id: string;
  agent_spiffe: string;
  tenant: string;
  credential_fingerprint: string;
  method: string;
  payload_sha256: string;
  authorization: SignedAuthorization;
  result_sha256: string;
  effect_id: string;
  workload_signature: WorkloadSignature;
}

export interface ExecutionCompletion {
  contract: typeof DURABLE_EXECUTION_CONTRACT;
  stage: 'execution.completed';
  authorization_id: string;
  idempotency_id: string;
  executor_id: string;
  actual_result: unknown;
  actual_result_sha256: string;
  effect_id: string;
  receipt: ExecutionReceipt;
}

export interface DurableExecutionStore {
  commitIntent(intent: ExecutionIntent): Promise<void>;
  commitCompletionAndEnqueueReceipt(completion: ExecutionCompletion): Promise<void>;
}

export interface GovernedExecutionOptions {
  endpoint: string;
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  retry?: ClavenarRetryOptions;
  executorId: string;
  executor(request: ToolExecutionRequest): Promise<ExecutionEffect>;
  durableStore: DurableExecutionStore;
  signReceipt(receipt: Omit<ExecutionReceipt, 'workload_signature'>): Promise<WorkloadSignature>;
}

export interface GovernedExecutionOutcome {
  result: unknown;
  effectId: string;
  idempotencyId: string;
  receipt: ExecutionReceipt;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY: ClavenarRetryOptions = { maxAttempts: 3, baseDelayMs: 100 };

/** Allocate a serializable request identity before any network access. */
export function prepareToolRequest(name: string, args: unknown): PreparedToolRequest {
  if (!name.trim()) throw new ClavenarConfigError('tool name must not be empty');
  return { idempotencyId: randomUUID(), name, arguments: args };
}

/** Side-effect-free authorize, durably record, execute once, and retain receipt. */
export async function executePreparedTool(
  prepared: PreparedToolRequest,
  opts: GovernedExecutionOptions,
): Promise<GovernedExecutionOutcome> {
  validatePrepared(prepared);
  validateOptions(opts);
  const body = {
    jsonrpc: '2.0' as const,
    id: prepared.idempotencyId,
    method: 'tools/call',
    params: { name: prepared.name, arguments: prepared.arguments },
  };
  const authorization = await requestAuthorization(body, prepared.idempotencyId, opts);
  validateAuthorization(authorization, prepared, body);
  const auth = authorization.authorization;
  const intent: ExecutionIntent = {
    contract: DURABLE_EXECUTION_CONTRACT,
    stage: 'execution.intent',
    authorization_id: auth.authorization_id,
    idempotency_id: auth.idempotency_id,
    tenant: auth.tenant,
    workload_id: auth.agent_id,
    workload_spiffe: auth.agent_spiffe,
    payload_sha256: auth.payload_sha256,
    executor_id: opts.executorId,
    authorization,
  };
  await opts.durableStore.commitIntent(intent);
  const effect = await opts.executor({
    authorizationId: auth.authorization_id,
    idempotencyId: auth.idempotency_id,
    executorId: opts.executorId,
    executionPayload: auth.execution_payload,
  });
  if (!effect.effectId.trim()) throw new ClavenarConfigError('executor returned an empty effect id');
  const resultSha256 = await sha256(effect.result);
  const unsignedReceipt: Omit<ExecutionReceipt, 'workload_signature'> = {
    contract: EXECUTION_CONTRACT,
    stage: 'execution.completed',
    authorization_id: auth.authorization_id,
    idempotency_id: auth.idempotency_id,
    correlation_id: auth.correlation_id,
    agent_id: auth.agent_id,
    agent_spiffe: auth.agent_spiffe,
    tenant: auth.tenant,
    credential_fingerprint: auth.credential_fingerprint,
    method: auth.method,
    payload_sha256: auth.payload_sha256,
    authorization,
    result_sha256: resultSha256,
    effect_id: effect.effectId,
  };
  const receipt: ExecutionReceipt = {
    ...unsignedReceipt,
    workload_signature: await opts.signReceipt(unsignedReceipt),
  };
  const completion: ExecutionCompletion = {
    contract: DURABLE_EXECUTION_CONTRACT,
    stage: 'execution.completed',
    authorization_id: auth.authorization_id,
    idempotency_id: auth.idempotency_id,
    executor_id: opts.executorId,
    actual_result: effect.result,
    actual_result_sha256: resultSha256,
    effect_id: effect.effectId,
    receipt,
  };
  await opts.durableStore.commitCompletionAndEnqueueReceipt(completion);
  return {
    result: effect.result,
    effectId: effect.effectId,
    idempotencyId: auth.idempotency_id,
    receipt,
  };
}

export async function executeTool(
  name: string,
  args: unknown,
  opts: GovernedExecutionOptions,
): Promise<GovernedExecutionOutcome> {
  return executePreparedTool(prepareToolRequest(name, args), opts);
}

async function requestAuthorization(
  body: unknown,
  idempotencyId: string,
  opts: GovernedExecutionOptions,
): Promise<SignedAuthorization> {
  const retry = opts.retry ?? DEFAULT_RETRY;
  if (retry.maxAttempts < 1) throw new ClavenarConfigError('retry.maxAttempts must be >= 1');
  let lastError: ClavenarTransportError | undefined;
  for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
    try {
      return await requestAuthorizationOnce(body, idempotencyId, opts);
    } catch (error) {
      if (!(error instanceof ClavenarTransportError)) throw error;
      lastError = error;
      if (error.status !== undefined && (error.status < 500 || error.status >= 600)) throw error;
      if (attempt + 1 === retry.maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, retry.baseDelayMs * 2 ** attempt));
    }
  }
  throw lastError ?? new ClavenarTransportError('governed authorization made no attempt');
}

async function requestAuthorizationOnce(
  body: unknown,
  idempotencyId: string,
  opts: GovernedExecutionOptions,
): Promise<SignedAuthorization> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new ClavenarConfigError('fetch is required');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [DECISION_CONTRACT_HEADER]: DECISION_CONTRACT,
    [IDEMPOTENCY_ID_HEADER]: idempotencyId,
  };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(joinUrl(opts.endpoint, '/mcp'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ClavenarTransportError(`governed authorization failed: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
  if (response.status !== 200) {
    throw new ClavenarTransportError(
      `governed authorization returned ${response.status}: ${await response.text()}`,
      response.status,
    );
  }
  try {
    return (await response.json()) as SignedAuthorization;
  } catch (error) {
    throw new ClavenarTransportError(
      `governed authorization returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      200,
    );
  }
}

function validatePrepared(prepared: PreparedToolRequest): void {
  if (!prepared.name.trim()) throw new ClavenarConfigError('tool name must not be empty');
  if (!isUuid(prepared.idempotencyId)) throw new ClavenarConfigError('idempotency id must be a UUID');
}

function validateOptions(opts: GovernedExecutionOptions): void {
  if (!opts.endpoint || !opts.executorId.trim()) {
    throw new ClavenarConfigError('endpoint and executorId are required');
  }
  if (!opts.durableStore || !opts.executor || !opts.signReceipt) {
    throw new ClavenarConfigError('durable store, executor, and receipt signer are required');
  }
}

function validateAuthorization(
  signed: SignedAuthorization,
  prepared: PreparedToolRequest,
  body: unknown,
): void {
  const auth = signed?.authorization;
  if (!auth || auth.contract !== EXECUTION_CONTRACT || auth.stage !== 'authorization') {
    throw new ClavenarConfigError('invalid governed execution authorization contract');
  }
  if (auth.idempotency_id !== prepared.idempotencyId) {
    throw new ClavenarConfigError('authorization changed the idempotency identity');
  }
  if (!isUuid(auth.authorization_id) || !isUuid(auth.correlation_id)) {
    throw new ClavenarConfigError('authorization contains an invalid UUID');
  }
  if (auth.modification_diff == null && canonicalJson(auth.execution_payload) !== canonicalJson(body)) {
    throw new ClavenarConfigError('authorization changed an unmodified execution payload');
  }
}

async function sha256(value: unknown): Promise<string> {
  const cryptoImpl = globalThis.crypto;
  if (!cryptoImpl?.subtle) throw new ClavenarConfigError('Web Crypto is required for receipts');
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(sortJson(value));
  if (serialized === undefined) throw new ClavenarConfigError('value is not JSON serializable');
  return serialized;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}
