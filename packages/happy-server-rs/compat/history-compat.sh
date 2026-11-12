#!/bin/bash
# Usage: [HISTORY_OFFLOAD=shadow|retain] withpg.sh [withminio.sh] history-compat.sh [scenario...]
# The differential scenarios with the Rust server in HISTORY_OFFLOAD=shadow (default)
# or retain, paging (and in retain mode deleting) everything older than a second,
# then its log and metrics checked: no bad page, no shadow or verifier mismatch, no
# storage error. In retain mode a scenario's own SessionMessage queries first stop
# the deletion and put the rows back (run.mjs, GET /__test/history/hold).
source "$(dirname "$0")/env.sh"
SCENARIOS="${*:-phase1 phase2 phase2-slow phase3 phase3-bare phase3-devlog phase4-batch phase4-metrics phase4-mobile}"
export HISTORY_OFFLOAD=${HISTORY_OFFLOAD:-shadow} HISTORY_DB_RETENTION=0s HISTORY_OFFLOAD_SETTLE=1s HISTORY_OFFLOAD_INTERVAL=1s
export HISTORY_VERIFY_INTERVAL=2s HISTORY_PAGE_MAX_ROWS=${HISTORY_PAGE_MAX_ROWS:-3} HISTORY_SCAN_PAUSE=0s
export HISTORY_OFFLOAD_ROWS_PER_SEC=100000 HISTORY_RETAIN_ROWS_PER_SEC=100000
[ "$HISTORY_OFFLOAD" = retain ] && export HAPPY_RS_TEST_HOOKS=1
export METRICS_ENABLED=true RS_METRICS_DUMP=1
RC=0
for s in $SCENARIOS; do
    "$COMPAT/diff.sh" "$s" || RC=1
    bad=$(grep -cE 'is bad|is damaged|is missing|shadow read mismatch|shadow read of session|offload of session .* stopped|retain of session .* stopped|offload sweep failed|page verifier failed|rehydrating page' "$WORK/rs-$s.log")
    m=$(grep -E '^history_(pages|shadow_reads|verifier_checks|storage_errors|rows_deleted)_total' "$WORK/rs-$s.metrics" | sed -E 's/,?app="happy-server"//; s/\{\}//' | tr '\n' ' ')
    echo "    history ($HISTORY_OFFLOAD): $bad problem log lines; $m"
    [ "$bad" = 0 ] || { RC=1; grep -E 'history' "$WORK/rs-$s.log" | head -5; }
    grep -qE 'history_(shadow_reads|verifier_checks)_total\{.*result="(mismatch|error)"|history_storage_errors_total\{|history_pages_total\{.*state="bad"' "$WORK/rs-$s.metrics" && RC=1
done
exit $RC
