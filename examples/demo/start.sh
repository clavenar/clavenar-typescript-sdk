#!/usr/bin/env bash
# Boot warden-lite, run the SDK demo, tear warden-lite down. Designed
# for the week-1 screencap — single command, clean output.
#
# Requires the warden-lite binary on $PATH (or override via
# WARDEN_LITE_BIN). Picks the local dev build under
# ../warden-lite/target/{release,debug}/ if nothing else is set.

set -euo pipefail

PORT="${WARDEN_LITE_PORT:-8088}"
UPSTREAM_PORT="${UPSTREAM_PORT:-9001}"
TOKEN="${WARDEN_TOKEN:-demo-token}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
POLICIES="$HERE/policies"
PIDFILE="$(mktemp -t warden-lite.XXXX.pid)"
STUB_PIDFILE="$(mktemp -t upstream-stub.XXXX.pid)"

# Resolve warden-lite binary.
WARDEN_LITE_BIN="${WARDEN_LITE_BIN:-}"
if [ -z "$WARDEN_LITE_BIN" ]; then
    for candidate in \
        "$ROOT/../warden-lite/target/release/warden-lite" \
        "$ROOT/../warden-lite/target/debug/warden-lite" \
        "$(command -v warden-lite 2>/dev/null || true)"; do
        if [ -x "$candidate" ]; then
            WARDEN_LITE_BIN="$candidate"
            break
        fi
    done
fi
if [ -z "$WARDEN_LITE_BIN" ] || [ ! -x "$WARDEN_LITE_BIN" ]; then
    echo "warden-lite binary not found." >&2
    echo "  Set WARDEN_LITE_BIN, or build the sibling repo: cd ../warden-lite && cargo build" >&2
    exit 2
fi

echo "warden-lite: $WARDEN_LITE_BIN"
echo "policies:    $POLICIES"
echo "port:        $PORT"
echo ""

cleanup() {
    for pf in "$PIDFILE" "$STUB_PIDFILE"; do
        if [ -f "$pf" ]; then
            pid="$(cat "$pf")"
            if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
                kill "$pid" 2>/dev/null || true
                wait "$pid" 2>/dev/null || true
            fi
            rm -f "$pf"
        fi
    done
}
trap cleanup EXIT INT TERM

# Stub upstream so allowed requests get a clean 200 instead of 502.
UPSTREAM_PORT="$UPSTREAM_PORT" node "$HERE/upstream-stub.mjs" 2>/dev/null &
echo "$!" > "$STUB_PIDFILE"

"$WARDEN_LITE_BIN" start \
    --port "$PORT" \
    --policies "$POLICIES" \
    --ledger :memory: \
    --upstream "http://127.0.0.1:$UPSTREAM_PORT/" \
    --token "$TOKEN" >/dev/null 2>&1 &
echo "$!" > "$PIDFILE"

# Wait for the proxy to bind.
attempts=0
until curl -fsS "http://localhost:$PORT/" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -gt 50 ]; then
        echo "warden-lite did not come up on :$PORT" >&2
        exit 3
    fi
    sleep 0.1
done

echo "warden-lite is up. Running demo..."
echo "----------------------------------------------------------------"

cd "$ROOT"
# Export WARDEN_LITE_BIN so run.ts can shell out to it for the
# operator auto-approve path. Without this, run.ts would have to
# duplicate the candidate-resolution logic.
export WARDEN_LITE_BIN
WARDEN_ENDPOINT="http://localhost:$PORT" WARDEN_TOKEN="$TOKEN" \
    node --import tsx "$HERE/run.ts"
