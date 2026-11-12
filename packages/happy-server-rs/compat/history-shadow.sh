#!/bin/bash
# Usage: withpg.sh [withminio.sh] history-shadow.sh [scenario...]
# The differential scenarios with the Rust server in HISTORY_OFFLOAD=shadow, paging
# everything older than a second, then its log and metrics checked: no bad page,
# no shadow or verifier mismatch, no storage error.
source "$(dirname "$0")/env.sh"
SCENARIOS="${*:-phase1 phase2 phase2-slow phase3 phase3-bare phase3-devlog phase4-batch phase4-metrics phase4-mobile}"
export HISTORY_OFFLOAD=shadow HISTORY_DB_RETENTION=0s HISTORY_OFFLOAD_SETTLE=1s HISTORY_OFFLOAD_INTERVAL=1s
export HISTORY_VERIFY_INTERVAL=2s HISTORY_PAGE_MAX_ROWS=${HISTORY_PAGE_MAX_ROWS:-3}
export METRICS_ENABLED=true RS_METRICS_DUMP=1
RC=0
for s in $SCENARIOS; do
    "$COMPAT/diff.sh" "$s" || RC=1
    bad=$(grep -cE 'is bad|shadow read mismatch|shadow read of session|offload of session .* stopped|offload sweep failed|page verifier failed' "$WORK/rs-$s.log")
    m=$(grep -E '^history_(pages|shadow_reads|verifier_checks|storage_errors)_total\{' "$WORK/rs-$s.metrics" | sed -E 's/,?app="happy-server"//; s/\{\}//' | tr '\n' ' ')
    echo "    history: $bad problem log lines; $m"
    [ "$bad" = 0 ] || { RC=1; grep -E 'history' "$WORK/rs-$s.log" | head -5; }
    grep -qE 'history_(shadow_reads|verifier_checks)_total\{.*result="mismatch"|history_storage_errors_total\{|history_pages_total\{.*state="bad"' "$WORK/rs-$s.metrics" && RC=1
done
exit $RC
