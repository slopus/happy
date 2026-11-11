#!/bin/bash
# Usage: withpg.sh <command...>
# Starts a throwaway Postgres on 127.0.0.1:$PGPORT, runs the command, stops it.
source "$(dirname "$0")/env.sh"
if [ ! -f "$WORK/pgdata/PG_VERSION" ]; then
    rm -rf "$WORK/pgdata"
    initdb -D "$WORK/pgdata" -U postgres --auth=trust >/dev/null || exit 1
    cat >> "$WORK/pgdata/postgresql.conf" <<CONF
listen_addresses = '127.0.0.1'
unix_socket_directories = ''
port = $PGPORT
fsync = off
synchronous_commit = off
full_page_writes = off
max_connections = 400
CONF
fi
pg_ctl -D "$WORK/pgdata" -l "$WORK/pg.log" -o "-p $PGPORT" -w start >/dev/null || { tail -5 "$WORK/pg.log"; exit 1; }
trap 'pg_ctl -D "$WORK/pgdata" -m fast stop >/dev/null' EXIT
"$@"
