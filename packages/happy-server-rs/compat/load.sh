#!/bin/bash
# Usage: WORK=/tmp/happy-compat withpg.sh load.sh [target...]
# Targets: ts, rs1, rs2, rs4, rsN (HAPPY_WORKERS=N, or all CPUs for rsN). Each target
# gets a fresh database and runs examples/loadgen.rs's sockets, fanout and rpc
# scenarios; one JSON line per scenario, with the host's load average and IO
# pressure at its start. Build first: cargo build --release --bins --examples.
source "$(dirname "$0")/env.sh"
TARGETS="${*:-ts rs1 rs2 rs4 rsN}"
LOADGEN="$ROOT/packages/happy-server-rs/target/release/examples/loadgen"
export PROFILE=release COMPAT_NO_PRELOAD=1
port_pid() { ss -ltnpH "sport = :$1" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
host() { printf '{"load":"%s","io_full_avg10":%s,"io_some_avg10":%s}' "$(cut -d' ' -f1-3 /proc/loadavg)" \
    "$(awk '/^full/{split($2,a,"=");print a[2]}' /proc/pressure/io)" "$(awk '/^some/{split($2,a,"=");print a[2]}' /proc/pressure/io)"; }
# TcpExt ListenOverflows + ListenDrops: a SYN dropped on a full accept queue costs the client a 1 s retransmit.
drops() { awk '/^TcpExt:/{if(!h){split($0,k);h=1}else{split($0,v);for(i in k)if(k[i]=="ListenOverflows"||k[i]=="ListenDrops")n+=v[i];print n}}' /proc/net/netstat; }
for target in $TARGETS; do
    db=d_load_$target
    "$COMPAT/freshdb.sh" $db || exit 1
    case $target in
        ts) "$COMPAT/tsserver.sh" $db 3201 > "$WORK/load-$target.log" 2>&1 & port=3201 ;;
        rsN) "$COMPAT/rsserver.sh" $db 3202 > "$WORK/load-$target.log" 2>&1 & port=3202 ;;
        rs*) HAPPY_WORKERS=${target#rs} "$COMPAT/rsserver.sh" $db 3202 > "$WORK/load-$target.log" 2>&1 & port=3202 ;;
    esac
    SRV=$!
    for i in $(seq 1 80); do curl -s -o /dev/null http://127.0.0.1:$port/ && break; sleep 0.5; done
    pid=$(port_pid $port)
    for s in sockets fanout rpc; do
        h=$(host); d0=$(drops)
        r=$(SERVER_PID=$pid "$LOADGEN" 127.0.0.1:$port $s 2>&1 | tail -1)
        echo "{\"target\":\"$target\",\"host\":$h,\"listen_drops\":$(( $(drops) - d0 )),\"result\":$r}"
        sleep 2
    done
    # The fanout messages that reached Postgres (a sanity check on its ops/s).
    echo "{\"target\":\"$target\",\"session_messages\":$(psql -h 127.0.0.1 -p $PGPORT -U postgres -d $db -At -c 'SELECT count(*) FROM "SessionMessage"')}"
    kill $SRV; wait $SRV 2>/dev/null
    sleep 1
done
