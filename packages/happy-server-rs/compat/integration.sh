#!/bin/bash
# Usage: withpg.sh integration.sh [scenario...]
# The single-server scenarios of happy-server's deploy/integration-tests, unmodified,
# against the TS server (3201) and then the Rust server (3202), each on a fresh
# database. The rest need several replicas, Redis or kubectl (rolling-deploy,
# cross-replica-3pod, stress-prod-realistic, test-rpc-dead-daemon).
source "$(dirname "$0")/env.sh"
TESTS="$ROOT/packages/happy-server/deploy/integration-tests"
SCENARIOS="${*:-fire-and-forget register-race-timing reconnect-no-ack rapid-sessions ios-session-flow high-concurrency}"
"$COMPAT/freshdb.sh" d_ts_it && "$COMPAT/freshdb.sh" d_rs_it || exit 1
rm -rf "$WORK/data-d_ts_it" "$WORK/data-d_rs_it"
"$COMPAT/tsserver.sh" d_ts_it 3201 > "$WORK/ts-it.log" 2>&1 & TS=$!
"$COMPAT/rsserver.sh" d_rs_it 3202 > "$WORK/rs-it.log" 2>&1 & RS=$!
for i in $(seq 1 80); do curl -s -o /dev/null http://127.0.0.1:3201/ && curl -s -o /dev/null http://127.0.0.1:3202/ && break; sleep 0.5; done
RC=0
for side in ts:3201 rs:3202; do
    for s in $SCENARIOS; do
        log="$WORK/it-${side%%:*}-$s.log"
        SERVER_URL=http://127.0.0.1:${side##*:} node "$TESTS/stress-rpc-registration.mjs" "$s" > "$log" 2>&1
        r=$?
        echo "=== ${side%%:*} $s: exit $r (full log: $log)"
        grep -E 'Results|PASSED|FAIL|err:|CRASH|p50|p99|avg|latency' "$log" | tail -8
        [ $r = 0 ] || RC=1
    done
done
kill $TS $RS; wait $TS $RS 2>/dev/null
exit $RC
