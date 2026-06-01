#!/usr/bin/env bash
# Boot clavenar-lite, run the SDK demo, tear clavenar-lite down. Designed
# for the week-1 screencap — single command, clean output.
#
# Requires the clavenar-lite binary on $PATH (or override via
# CLAVENAR_LITE_BIN). Picks the local dev build under
# ../clavenar-lite/target/{release,debug}/ if nothing else is set.

set -euo pipefail

PORT="${CLAVENAR_LITE_PORT:-8088}"
UPSTREAM_PORT="${UPSTREAM_PORT:-9001}"
TOKEN="${CLAVENAR_TOKEN:-demo-token}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
POLICIES="$HERE/policies"
PIDFILE="$(mktemp -t clavenar-lite.XXXX.pid)"
STUB_PIDFILE="$(mktemp -t upstream-stub.XXXX.pid)"

# Resolve clavenar-lite binary.
CLAVENAR_LITE_BIN="${CLAVENAR_LITE_BIN:-}"
if [ -z "$CLAVENAR_LITE_BIN" ]; then
    for candidate in \
        "$ROOT/../clavenar-lite/target/release/clavenar-lite" \
        "$ROOT/../clavenar-lite/target/debug/clavenar-lite" \
        "$(command -v clavenar-lite 2>/dev/null || true)"; do
        if [ -x "$candidate" ]; then
            CLAVENAR_LITE_BIN="$candidate"
            break
        fi
    done
fi
if [ -z "$CLAVENAR_LITE_BIN" ] || [ ! -x "$CLAVENAR_LITE_BIN" ]; then
    echo "clavenar-lite binary not found." >&2
    echo "  Set CLAVENAR_LITE_BIN, or build the sibling repo: cd ../clavenar-lite && cargo build" >&2
    exit 2
fi

echo "clavenar-lite: $CLAVENAR_LITE_BIN"
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

"$CLAVENAR_LITE_BIN" start \
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
        echo "clavenar-lite did not come up on :$PORT" >&2
        exit 3
    fi
    sleep 0.1
done

echo "clavenar-lite is up. Running demo..."
echo "----------------------------------------------------------------"

cd "$ROOT"
# Export CLAVENAR_LITE_BIN so run.ts can shell out to it for the
# operator auto-approve path. Without this, run.ts would have to
# duplicate the candidate-resolution logic.
export CLAVENAR_LITE_BIN
CLAVENAR_ENDPOINT="http://localhost:$PORT" CLAVENAR_TOKEN="$TOKEN" \
    node --import tsx "$HERE/run.ts"
