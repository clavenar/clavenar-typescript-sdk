# Week-1 demo

End-to-end demonstration of the `@vanteguardlabs/warden-ai-sdk` wrap pattern. Runs a
mocked Anthropic client through `wardenWrap` and shows two outcomes:

- `fetch_user` is allowed by policy → message passes through.
- `delete_user` is denied by policy → `WardenDenied` is thrown.

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
[1/2] agent: "fetch user 42"
        tool_use: fetch_user({"id":42})
        warden:   [ALLOW] tool="fetch_user"
        result:   message returned, your tool-execution loop runs the tool

[2/2] agent: "delete user 42"
        tool_use: delete_user({"id":42})
        warden:   [DENY]  tool="delete_user" intent="Routine"
        result:   WardenDenied thrown — your existing throw-handler kicks in
                  toolName=delete_user
                  intentCategory=Routine
                  reason: Violation: delete_user is a destructive operation …
```

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

For the website / outreach reel:

```sh
asciinema rec --command 'pnpm demo' demo.cast
asciinema upload demo.cast      # or convert to gif: agg demo.cast demo.gif
```

The full run is ~3 seconds; the read-aloud script is what fills the
60 seconds.

## Why both layers fire on `delete_user`

The `intent="Routine"` line in the deny verdict is intentional: the
heuristic Brain didn't flag `delete_user` as dangerous (it has no
keyword match), but the **policy** denied it. Two independent layers,
both running, either one able to veto. That's the point.
