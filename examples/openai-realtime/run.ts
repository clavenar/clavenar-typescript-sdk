/**
 * OpenAI Realtime + Clavenar — gate tool calls a voice / streaming
 * agent emits over the Realtime websocket.
 *
 * The Realtime API doesn't fit the wrap-the-client recipe — there's no
 * `client.method()` to intercept. Instead, every server event arrives
 * over a WebSocket; tool calls are signalled by a sequence of
 * `response.function_call_arguments.delta` events that accumulate a
 * JSON string and exactly one `response.function_call_arguments.done`
 * event carrying the complete arguments. Clavenar inspects the `done`
 * event — the model has committed by then and the argument payload
 * is whole.
 *
 * This recipe shows the pump pattern with `ClavenarDenied` /
 * `ClavenarPending` translation into the Realtime `function_call_output`
 * response shape the API expects.
 */
import {
  inspectRealtimeFunctionCall,
  isRealtimeFunctionCallDone,
} from '../../src/index.js';
import type {
  OpenAIRealtimeServerEvent,
  OpenAIRealtimeFunctionCallDone,
  ClavenarOptions,
} from '../../src/index.js';

const endpoint = process.env['CLAVENAR_ENDPOINT'] ?? 'http://localhost:8088';
const token = process.env['CLAVENAR_TOKEN'] ?? 'demo-token';
const opts: ClavenarOptions = { endpoint, token, mode: 'enforce' };

// Tiny WebSocket-like interface so the recipe stays dependency-free.
// In real wiring, use `import WebSocket from 'ws'` and the
// real `new WebSocket('wss://api.openai.com/v1/realtime?model=...')`.
interface RealtimeLike {
  send(payload: string): void;
}

// Stub events: response.output_item.added announces the call, deltas
// accumulate the args, done is the terminal event clavenar inspects.
const events: OpenAIRealtimeServerEvent[] = [
  { type: 'session.created', session: { id: 'sess_demo' } },
  {
    type: 'response.output_item.added',
    response_id: 'resp_1',
    item: { type: 'function_call', call_id: 'call_w1', name: 'wire_transfer' },
  },
  {
    type: 'response.function_call_arguments.delta',
    response_id: 'resp_1',
    call_id: 'call_w1',
    delta: '{"to":"ac',
  },
  {
    type: 'response.function_call_arguments.delta',
    response_id: 'resp_1',
    call_id: 'call_w1',
    delta: 'ct-9","amount":250}',
  },
  {
    type: 'response.function_call_arguments.done',
    response_id: 'resp_1',
    item_id: 'item_1',
    output_index: 0,
    call_id: 'call_w1',
    name: 'wire_transfer',
    arguments: '{"to":"acct-9","amount":250}',
  } satisfies OpenAIRealtimeFunctionCallDone,
];

const ws: RealtimeLike = {
  send(payload: string) {
    console.log('→ ws.send:', payload);
  },
};

// Drain the event stream like the real Realtime websocket pump would.
for (const evt of events) {
  if (!isRealtimeFunctionCallDone(evt)) continue;

  const verdict = await inspectRealtimeFunctionCall(evt, opts);

  if (verdict.kind === 'allow') {
    console.log(`allow: ${evt.name}(${evt.arguments}) — dispatch handler`);
    // Real handler runs here; its return value goes back to the model:
    //   ws.send(JSON.stringify({
    //     type: 'conversation.item.create',
    //     item: { type: 'function_call_output', call_id: evt.call_id, output: '...' },
    //   }));
    continue;
  }

  if (verdict.kind === 'deny') {
    ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: evt.call_id,
          output: `[clavenar] denied: ${verdict.payload.reasons.join('; ')}`,
        },
      }),
    );
    continue;
  }

  // Pending: the operator hasn't decided yet. Two practical shapes —
  //   1. Block the pump: `await pollUntilDecided(verdict.correlationId)`.
  //   2. Send a placeholder back so the model isn't stranded, and
  //      reconcile when the decision lands.
  console.log(`pending: ${verdict.correlationId} — awaiting operator decide`);
  ws.send(
    JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: evt.call_id,
        output: '[clavenar] awaiting human approval',
      },
    }),
  );
}
