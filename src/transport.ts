import { WardenTransportError } from './errors.js';
import type { AnthropicToolUseBlock } from './anthropic.js';
import type {
  WardenDenyResponse,
  WardenInspectRequest,
  WardenOptions,
  WardenVerdict,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Submit one tool_use block to warden-lite for inspection.
 *
 * Wire contract: `POST {endpoint}/mcp` with a JSON-RPC 2.0 envelope.
 * Server: `warden-lite/src/proxy.rs::handle_mcp`.
 *
 * Returns the verdict; the caller decides whether to throw. We do
 * not collapse 4xx/5xx into a verdict — those throw {@link
 * WardenTransportError} so a misconfigured ingress can't be silently
 * mistaken for an allow.
 */
export async function inspectToolUse(
  toolUse: AnthropicToolUseBlock,
  opts: WardenOptions,
): Promise<WardenVerdict> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new WardenTransportError('no fetch implementation available (Node 18+ or pass opts.fetch)');
  }

  const body: WardenInspectRequest = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolUse.name, arguments: toolUse.input },
    id: toolUse.id,
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

  if (response.status === 200) {
    return { kind: 'allow' };
  }

  if (response.status === 403) {
    const payload = await parseDenyBody(response);
    return { kind: 'deny', payload };
  }

  // No 202/pending in warden-lite today — the Yellow tier is full-edition only.
  // Roadmap week 4 introduces a non-blocking shape and this branch grows.
  const text = await safeReadText(response);
  throw new WardenTransportError(
    `warden inspect: unexpected status ${response.status}${text ? `: ${text}` : ''}`,
    response.status,
  );
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
