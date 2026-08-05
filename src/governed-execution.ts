import { createHash, randomUUID } from 'node:crypto';

import {
  ClavenarConfigError,
  ClavenarRecoveryRequired,
  ClavenarTransportError,
} from './errors.js';
import type { ClavenarRetryOptions } from './types.js';
import {
  DECISION_CONTRACT,
  DECISION_CONTRACT_HEADER,
  IDEMPOTENCY_ID_HEADER,
} from './transport.js';

export const EXECUTION_CONTRACT = 'clavenar.execution/v1';
export const DURABLE_EXECUTION_CONTRACT = 'clavenar.sdk-durable-intent-outbox/v1';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_FINALIZATION_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY: ClavenarRetryOptions = { maxAttempts: 3, baseDelayMs: 100 };
const MAX_RETRY_ATTEMPTS = 10;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_RESPONSE_BYTES = 1 << 20;
const MAX_ERROR_PREVIEW_BYTES = 4 << 10;

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

export interface ExecutionState {
  intent?: ExecutionIntent;
  completion?: ExecutionCompletion;
}

/**
 * The store must atomically reject a duplicate `commitIntent` and atomically
 * retain completion with its receipt outbox row.
 */
export interface DurableExecutionStore {
  loadExecution(idempotencyId: string): Promise<ExecutionState>;
  commitIntent(intent: ExecutionIntent): Promise<void>;
  commitCompletionAndEnqueueReceipt(completion: ExecutionCompletion): Promise<void>;
}

export interface GovernedExecutionOptions {
  endpoint: string;
  token?: string;
  timeoutMs?: number;
  allowInsecureLoopback?: boolean;
  finalizationTimeoutMs?: number;
  fetch?: typeof fetch;
  retry?: ClavenarRetryOptions;
  executorId: string;
  /** The executor must use the supplied idempotency id at the provider boundary. */
  executor(request: ToolExecutionRequest): Promise<ExecutionEffect>;
  /** Reconcile a persisted intent without repeating an ambiguous provider effect. */
  recoverEffect?(intent: ExecutionIntent): Promise<ExecutionEffect | undefined>;
  durableStore: DurableExecutionStore;
  /** Cryptographically verify Identity's signature over this exact authorization. */
  verifyAuthorization(authorization: SignedAuthorization): Promise<void> | void;
  signReceipt(receipt: Omit<ExecutionReceipt, 'workload_signature'>): Promise<WorkloadSignature>;
}

export interface GovernedExecutionOutcome {
  result: unknown;
  effectId: string;
  idempotencyId: string;
  receipt: ExecutionReceipt;
}

/** Allocate a serializable request identity before any network access. */
export function prepareToolRequest(name: string, args: unknown): PreparedToolRequest {
  if (!name.trim()) throw new ClavenarConfigError('tool name must not be empty');
  canonicalJson(args);
  return { idempotencyId: randomUUID(), name, arguments: args };
}

/** Side-effect-free authorize, durably record, execute, and retain a receipt. */
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

  const loaded = await opts.durableStore.loadExecution(prepared.idempotencyId);
  if (!isJsonObject(loaded)) {
    throw new ClavenarConfigError('durable store returned an invalid execution state');
  }
  const state = cloneJson(loaded) as ExecutionState;
  if (state.completion) return recoveredCompletion(prepared, body, state, opts);
  if (state.intent) {
    await validateStoredIntent(state.intent, prepared, body, opts);
    if (!opts.recoverEffect) throw new ClavenarRecoveryRequired(prepared.idempotencyId);
    const recovered = await opts.recoverEffect(cloneJson(state.intent));
    if (!recovered) throw new ClavenarRecoveryRequired(prepared.idempotencyId);
    return completeExecution(state.intent.authorization, recovered, opts);
  }

  const authorization = await requestAuthorization(body, prepared.idempotencyId, opts);
  validateAuthorization(authorization, prepared, body);
  try {
    await opts.verifyAuthorization(cloneJson(authorization));
  } catch (error) {
    throw new ClavenarConfigError(
      `authorization signature verification failed: ${errorMessage(error)}`,
    );
  }
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
    authorization: cloneJson(authorization),
  };
  await opts.durableStore.commitIntent(cloneJson(intent));
  const effect = await opts.executor({
    authorizationId: auth.authorization_id,
    idempotencyId: auth.idempotency_id,
    executorId: opts.executorId,
    executionPayload: cloneJson(auth.execution_payload),
  });
  return completeExecution(authorization, effect, opts);
}

export async function executeTool(
  name: string,
  args: unknown,
  opts: GovernedExecutionOptions,
): Promise<GovernedExecutionOutcome> {
  return executePreparedTool(prepareToolRequest(name, args), opts);
}

async function completeExecution(
  authorization: SignedAuthorization,
  effect: ExecutionEffect,
  opts: GovernedExecutionOptions,
): Promise<GovernedExecutionOutcome> {
  if (!effect || !effect.effectId?.trim()) {
    throw new ClavenarConfigError('executor returned an invalid effect');
  }
  const result = cloneJson(effect.result);
  const resultSha256 = sha256(result);
  const auth = authorization.authorization;
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
    authorization: cloneJson(authorization),
    result_sha256: resultSha256,
    effect_id: effect.effectId,
  };
  const timeoutMs = opts.finalizationTimeoutMs ?? DEFAULT_FINALIZATION_TIMEOUT_MS;
  const signature = await withTimeout(
    opts.signReceipt(cloneJson(unsignedReceipt)),
    timeoutMs,
    'receipt signing',
  );
  if (
    !signature?.algorithm?.trim() ||
    !signature.credential_fingerprint?.trim() ||
    !signature.value?.trim()
  ) {
    throw new ClavenarConfigError('receipt signer returned an invalid signature');
  }
  if (signature.credential_fingerprint !== auth.credential_fingerprint) {
    throw new ClavenarConfigError('receipt signer credential does not match the authorization');
  }
  const receipt: ExecutionReceipt = {
    ...unsignedReceipt,
    workload_signature: cloneJson(signature),
  };
  const completion: ExecutionCompletion = {
    contract: DURABLE_EXECUTION_CONTRACT,
    stage: 'execution.completed',
    authorization_id: auth.authorization_id,
    idempotency_id: auth.idempotency_id,
    executor_id: opts.executorId,
    actual_result: cloneJson(result),
    actual_result_sha256: resultSha256,
    effect_id: effect.effectId,
    receipt,
  };
  await withTimeout(
    opts.durableStore.commitCompletionAndEnqueueReceipt(cloneJson(completion)),
    timeoutMs,
    'durable completion',
  );
  return {
    result,
    effectId: effect.effectId,
    idempotencyId: auth.idempotency_id,
    receipt,
  };
}

async function validateStoredIntent(
  intent: ExecutionIntent,
  prepared: PreparedToolRequest,
  body: unknown,
  opts: GovernedExecutionOptions,
): Promise<void> {
  if (
    intent.contract !== DURABLE_EXECUTION_CONTRACT ||
    intent.stage !== 'execution.intent' ||
    intent.idempotency_id !== prepared.idempotencyId ||
    intent.executor_id !== opts.executorId
  ) {
    throw new ClavenarConfigError('stored execution intent does not match the prepared request');
  }
  validateAuthorization(intent.authorization, prepared, body);
  const auth = intent.authorization.authorization;
  if (
    intent.authorization_id !== auth.authorization_id ||
    intent.tenant !== auth.tenant ||
    intent.workload_id !== auth.agent_id ||
    intent.workload_spiffe !== auth.agent_spiffe ||
    intent.payload_sha256 !== auth.payload_sha256
  ) {
    throw new ClavenarConfigError('stored execution intent changed an authorization binding');
  }
  try {
    await opts.verifyAuthorization(cloneJson(intent.authorization));
  } catch (error) {
    throw new ClavenarConfigError(
      `stored authorization signature verification failed: ${errorMessage(error)}`,
    );
  }
}

async function recoveredCompletion(
  prepared: PreparedToolRequest,
  body: unknown,
  state: ExecutionState,
  opts: GovernedExecutionOptions,
): Promise<GovernedExecutionOutcome> {
  if (!state.intent || !state.completion) {
    throw new ClavenarConfigError('durable completion is missing its execution intent');
  }
  await validateStoredIntent(state.intent, prepared, body, opts);
  const completion = state.completion;
  const auth = state.intent.authorization.authorization;
  if (
    completion.contract !== DURABLE_EXECUTION_CONTRACT ||
    completion.stage !== 'execution.completed' ||
    completion.authorization_id !== auth.authorization_id ||
    completion.idempotency_id !== prepared.idempotencyId ||
    completion.executor_id !== opts.executorId ||
    !completion.effect_id?.trim()
  ) {
    throw new ClavenarConfigError('stored execution completion is invalid');
  }
  const resultSha256 = sha256(completion.actual_result);
  const receipt = completion.receipt;
  if (
    completion.actual_result_sha256 !== resultSha256 ||
    receipt.result_sha256 !== resultSha256 ||
    receipt.authorization_id !== auth.authorization_id ||
    receipt.idempotency_id !== prepared.idempotencyId ||
    receipt.effect_id !== completion.effect_id ||
    receipt.contract !== EXECUTION_CONTRACT ||
    receipt.stage !== 'execution.completed' ||
    receipt.correlation_id !== auth.correlation_id ||
    receipt.agent_id !== auth.agent_id ||
    receipt.agent_spiffe !== auth.agent_spiffe ||
    receipt.tenant !== auth.tenant ||
    receipt.credential_fingerprint !== auth.credential_fingerprint ||
    receipt.method !== auth.method ||
    receipt.payload_sha256 !== auth.payload_sha256 ||
    canonicalJson(receipt.authorization) !== canonicalJson(state.intent.authorization) ||
    receipt.workload_signature?.credential_fingerprint !== auth.credential_fingerprint ||
    !receipt.workload_signature?.algorithm?.trim() ||
    !receipt.workload_signature?.value?.trim()
  ) {
    throw new ClavenarConfigError('stored execution completion failed integrity validation');
  }
  return {
    result: cloneJson(completion.actual_result),
    effectId: completion.effect_id,
    idempotencyId: completion.idempotency_id,
    receipt: cloneJson(receipt),
  };
}

async function requestAuthorization(
  body: unknown,
  idempotencyId: string,
  opts: GovernedExecutionOptions,
): Promise<SignedAuthorization> {
  const retry = opts.retry ?? DEFAULT_RETRY;
  if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1 || retry.maxAttempts > MAX_RETRY_ATTEMPTS) {
    throw new ClavenarConfigError(`retry.maxAttempts must be between 1 and ${MAX_RETRY_ATTEMPTS}`);
  }
  let lastError: ClavenarTransportError | undefined;
  for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
    try {
      return await requestAuthorizationOnce(body, idempotencyId, opts);
    } catch (error) {
      if (!(error instanceof ClavenarTransportError)) throw error;
      lastError = error;
      if (!isRetriable(error) || attempt + 1 === retry.maxAttempts) throw error;
      await sleep(Math.min(retry.baseDelayMs * 2 ** attempt, MAX_RETRY_DELAY_MS));
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
      body: canonicalJson(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new ClavenarTransportError(`governed authorization failed: ${errorMessage(error)}`);
  } finally {
    clearTimeout(timeout);
  }
  const bytes = await readBoundedBody(response);
  if (response.status !== 200) {
    throw new ClavenarTransportError(
      `governed authorization returned ${response.status}: ${boundedErrorText(bytes)}`,
      response.status,
    );
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as SignedAuthorization;
  } catch (error) {
    throw new ClavenarTransportError(
      `governed authorization returned invalid JSON: ${errorMessage(error)}`,
      200,
    );
  }
}

function validatePrepared(prepared: PreparedToolRequest): void {
  if (!prepared.name.trim()) throw new ClavenarConfigError('tool name must not be empty');
  if (!isUuid(prepared.idempotencyId)) throw new ClavenarConfigError('idempotency id must be a UUID');
  canonicalJson(prepared.arguments);
}

function validateOptions(opts: GovernedExecutionOptions): void {
  validateEndpoint(opts.endpoint, Boolean(opts.token), opts.allowInsecureLoopback);
  if (!opts.executorId.trim()) throw new ClavenarConfigError('executorId is required');
  if (!opts.durableStore || !opts.executor || !opts.signReceipt || !opts.verifyAuthorization) {
    throw new ClavenarConfigError(
      'recoverable durable store, executor, receipt signer, and authorization verifier are required',
    );
  }
  for (const [name, value] of [
    ['timeoutMs', opts.timeoutMs ?? DEFAULT_TIMEOUT_MS],
    ['finalizationTimeoutMs', opts.finalizationTimeoutMs ?? DEFAULT_FINALIZATION_TIMEOUT_MS],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0 || value > 300_000) {
      throw new ClavenarConfigError(`${name} must be between 1 and 300000`);
    }
  }
  const retry = opts.retry ?? DEFAULT_RETRY;
  if (!Number.isFinite(retry.baseDelayMs) || retry.baseDelayMs < 0 || retry.baseDelayMs > MAX_RETRY_DELAY_MS) {
    throw new ClavenarConfigError(`retry.baseDelayMs must be between 0 and ${MAX_RETRY_DELAY_MS}`);
  }
}

function validateAuthorization(
  signed: SignedAuthorization,
  prepared: PreparedToolRequest,
  body: unknown,
): void {
  const auth = signed?.authorization;
  if (!isJsonObject(signed?.identity_signature) || Object.keys(signed.identity_signature).length === 0) {
    throw new ClavenarConfigError('authorization is missing a valid identity signature');
  }
  if (!auth || auth.contract !== EXECUTION_CONTRACT || auth.stage !== 'authorization') {
    throw new ClavenarConfigError('invalid governed execution authorization contract');
  }
  if (auth.idempotency_id !== prepared.idempotencyId) {
    throw new ClavenarConfigError('authorization changed the idempotency identity');
  }
  if (!isUuid(auth.authorization_id) || !isUuid(auth.correlation_id)) {
    throw new ClavenarConfigError('authorization contains an invalid UUID');
  }
  if (
    !auth.agent_id?.trim() ||
    !auth.agent_spiffe?.trim() ||
    !auth.tenant?.trim() ||
    !auth.credential_fingerprint?.trim() ||
    !auth.brain_version?.trim() ||
    !isSha256(auth.payload_sha256) ||
    !isSha256(auth.brain_evidence_sha256)
  ) {
    throw new ClavenarConfigError('authorization is missing an execution binding');
  }
  if (!isJsonObject(auth.decision_principal) || !isJsonObject(auth.policy_bundle)) {
    throw new ClavenarConfigError('authorization contains invalid decision evidence');
  }
  if (auth.method !== 'tools/call' || auth.tool_name !== prepared.name) {
    throw new ClavenarConfigError('authorization changed the tool binding');
  }
  const payload = auth.execution_payload as Record<string, unknown>;
  if (
    !isJsonObject(payload) ||
    !hasExactKeys(payload, ['jsonrpc', 'id', 'method', 'params']) ||
    payload.jsonrpc !== '2.0' ||
    payload.method !== 'tools/call' ||
    payload.id !== prepared.idempotencyId ||
    !isJsonObject(payload.params) ||
    !hasExactKeys(payload.params, ['name', 'arguments']) ||
    payload.params.name !== prepared.name ||
    !Object.hasOwn(payload.params, 'arguments')
  ) {
    throw new ClavenarConfigError(
      'authorization execution payload changed a protected request binding',
    );
  }
  if (auth.payload_sha256 !== sha256(auth.execution_payload)) {
    throw new ClavenarConfigError('authorization payload digest does not match execution payload');
  }
  if (auth.modification_diff == null && canonicalJson(auth.execution_payload) !== canonicalJson(body)) {
    throw new ClavenarConfigError('authorization changed an unmodified execution payload');
  }
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

/** Canonical JSON for the shared SDK contract: sorted UTF-16 keys and finite safe numbers. */
function canonicalJson(value: unknown): string {
  validateJsonValue(value, new Set());
  const serialized = JSON.stringify(sortJson(value));
  if (serialized === undefined) throw new ClavenarConfigError('value is not JSON serializable');
  return serialized;
}

function validateJsonValue(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new ClavenarConfigError('JSON numbers must be finite and integers must be safely representable');
    }
    return;
  }
  if (typeof value !== 'object') throw new ClavenarConfigError('value is not JSON serializable');
  if (ancestors.has(value)) throw new ClavenarConfigError('value contains a JSON cycle');
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) validateJsonValue(entry, ancestors);
  } else {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      if (entry === undefined) throw new ClavenarConfigError('JSON objects must not contain undefined');
      validateJsonValue(entry, ancestors);
    }
  }
  ancestors.delete(value);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function validateEndpoint(
  endpoint: string,
  sendsCredentials: boolean,
  allowInsecureLoopback = false,
): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ClavenarConfigError('endpoint must be a valid absolute URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ClavenarConfigError('endpoint must use http or https');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ClavenarConfigError('endpoint must not contain user info, a query, or a fragment');
  }
  if (sendsCredentials && parsed.protocol !== 'https:') {
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
    if (!allowInsecureLoopback || !loopback) {
      throw new ClavenarConfigError(
        'credentials require https; plaintext is available only for explicitly enabled loopback development',
      );
    }
  }
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new ClavenarTransportError(
      `response body exceeds ${MAX_RESPONSE_BYTES} bytes`,
      response.status,
    );
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
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ClavenarTransportError(
          `response body exceeds ${MAX_RESPONSE_BYTES} bytes`,
          response.status,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

function boundedErrorText(bytes: Uint8Array): string {
  const preview = bytes.subarray(0, MAX_ERROR_PREVIEW_BYTES);
  const text = new TextDecoder('utf-8').decode(preview).replace(/[\p{C}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return bytes.byteLength > preview.byteLength ? `${text}...` : text;
}

function isRetriable(error: ClavenarTransportError): boolean {
  return error.status === undefined || (error.status >= 500 && error.status < 600);
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new ClavenarTransportError(`${operation} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
