#!/bin/bash
# Usage: withpg.sh diff.sh <scenario>
# Fresh database per server, both servers up, scenario run against each, normalized
# transcripts compared. Exit code 1 on any difference. Build the Rust server first.
source "$(dirname "$0")/env.sh"
S=$1
"$COMPAT/freshdb.sh" d_ts_$S && "$COMPAT/freshdb.sh" d_rs_$S || exit 1
rm -rf "$WORK/data-d_ts_$S" "$WORK/data-d_rs_$S"
"$COMPAT/tsserver.sh" d_ts_$S 3201 > "$WORK/ts-$S.log" 2>&1 & TS=$!
"$COMPAT/rsserver.sh" d_rs_$S 3202 > "$WORK/rs-$S.log" 2>&1 & RS=$!
for i in $(seq 1 80); do curl -s -o /dev/null http://127.0.0.1:3201/ && curl -s -o /dev/null http://127.0.0.1:3202/ && break; sleep 0.5; done
node "$COMPAT/run.mjs" $S http://127.0.0.1:3201 d_ts_$S http://127.0.0.1:3202 d_rs_$S
RC=$?
kill $TS $RS; wait $TS $RS 2>/dev/null
exit $RC
