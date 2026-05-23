# Demo — three-tier wrap pattern

![Three-tier wrap pattern in action](./demo.gif)

End-to-end demonstration of the `@vanteguardlabs/warden-ai-sdk` wrap
pattern. Runs a mocked Anthropic client through `wardenWrap` and shows
all three outcomes:

- `fetch_user` is allowed by policy → message passes through. (green)
- `delete_user` is denied by policy → `WardenDenied` is thrown. (red)
- `transfer_funds` parks for human review → `WardenPending` is thrown;
  the demo auto-approves after 1.5s; `await pending.resolve()`
  completes; the agent loop proceeds. (yellow)

## What's in the box

| File | What it does |
|---|---|
| `run.ts` | The demo script. Two scenarios, prints verdict + result. |
| `policies/demo.rego` | Custom warden-lite policy. Hard-denies `delete_user`. |
| `upstream-stub.mjs` | Throwaway Node HTTP server. Returns 200 on every POST so allowed requests get a clean forward instead of a 502. |
| `start.sh` | Boots `upstream-stub` + `warden-lite` + runs `run.ts`. Tears everything down on exit. |

## Run it

Prereq: warden-lite binary somewhere `start.sh` can find it. The
script looks at `$WARDEN_LITE_BIN`, then sibling
`../warden-lite/target/{release,debug}/warden-lite`, then `$PATH`. If
you're building from this workspace:

```sh
cd ../warden-lite && cargo build && cd -
```

Then from the SDK root:

```sh
pnpm install
pnpm demo
```

Expected output (enforce mode, the default):

```
[1/3] agent: "fetch user 42"
        tool_use: fetch_user({"id":42})
        warden:   [ALLOW] tool="fetch_user"
        result:   message returned, your tool-execution loop runs the tool

[2/3] agent: "delete user 42"
        tool_use: delete_user({"id":42})
        warden:   [DENY]  tool="delete_user" intent="Routine"
        result:   WardenDenied thrown — your existing throw-handler kicks in
                  toolName=delete_user
                  intentCategory=Routine
                  reason: Violation: delete_user is a destructive operation …

[3/3] agent: "transfer $100 from acct-A to acct-B"
        tool_use: transfer_funds({"from":"acct-A","to":"acct-B","amount":100})
        warden:   [PEND]  tool="transfer_funds" corr="8f1d…"
                  reason: Review: transfer_funds requires human approval before execution.
                  awaiting operator decision …
        operator: $ warden-lite pending decide 8f1d… --allow --note 'demo auto-approve'
                  ok: pending 8f1d… decided allow
        result:   approved — agent loop proceeds with the tool call
```

The yellow scenario auto-approves via the demo runner, which shells out
to the canonical operator command — `warden-lite pending decide` —
rather than POSTing to `/pending/{id}/decide` directly. Both work; the
CLI is what a partner would type. In production the trigger is a Slack
approval (configure `--slack-webhook-url` on `warden-lite start` for
one-way alerts) or a dashboard click; the SDK side is unchanged:
`catch (e instanceof WardenPending) { await e.resolve(); }`.

### Observe mode

Set `OBSERVE=1` to show the rollout flow — every verdict surfaces
via the `onVerdict` callback, no throw:

```sh
OBSERVE=1 pnpm demo
```

Same two scenarios, but `delete_user` no longer throws — the
denied call lands as a `[DENY]` verdict in the callback and the
demo continues. Partners deploy in this mode first, count
would-have-denies, then flip to enforce when the verdicts settle.

## Recording the screencap

`demo.gif` at the top of this README was produced with:

```sh
WARDEN_DEMO_PAUSE_MS=2200 \
  asciinema rec --overwrite --idle-time-limit 3 \
    --cols 60 --rows 28 \
    --command 'pnpm demo' demo.cast
agg --font-family 'DejaVu Sans Mono' --font-size 36 demo.cast demo.gif
```

The `--cols 60` cap is deliberately tight — almost every warden output
line wraps mid-word, the deny-reason wraps three times, the operator
command wraps once. That's the explicit visual cost we accept for
giant on-screen letters: the website now stacks the gif full-width
above the copy (`.lite-grid` is single-column), so each source char
renders ~22px wide after the modest CSS downscale to the 1232px
container. Going lower (cols 50) starts upscaling the source above
the container width and the gif blurs.

`WARDEN_DEMO_PAUSE_MS` inserts a per-scenario reading pause so viewers
can absorb each verdict before the next prints. Defaults to 0 — normal
`pnpm demo` runs at native speed.

## Why both layers fire on `delete_user`

The `intent="Routine"` line in the deny verdict is intentional: the
heuristic Brain didn't flag `delete_user` as dangerous (it has no
keyword match), but the **policy** denied it. Two independent layers,
both running, either one able to veto. That's the point.

## How the yellow tier wires up

`policies/demo.rego` declares a `review` rule for `transfer_funds`.
That rule fires alongside `allow := true`, which the proxy classifies
as **yellow** and parks: warden-lite responds `202 Accepted` with
`{status, correlation_id, review_reasons}` and stashes the request in
its `pendings` table.

SDK side, the wrap throws `WardenPending` carrying the correlation id
and a pre-bound poll closure. The demo runner schedules an
auto-approve `warden-lite pending decide` shell-out after 1.5s;
meanwhile the partner code does `await pending.resolve()`, which polls
`GET /pending/{id}` every 250ms until `decision` flips. The shell-out
is purely a screencap choice — the CLI is just a thin wrapper over the
same `POST /pending/{id}/decide` endpoint partners can hit directly
from any HTTP client.

Three transitions:

- `decision: "allow"` → `resolve()` returns void, agent proceeds.
- `decision: "deny"`  → `resolve()` throws `WardenDenied` (same shape
  as the synchronous deny path, with the operator's note as the reason).
- Deadline elapsed    → `resolve()` throws `WardenTransportError`.

Default `pollIntervalMs: 2000`, `timeoutMs: 600_000` (10 minutes); pass
your own values if your approval cycle is faster or slower.
