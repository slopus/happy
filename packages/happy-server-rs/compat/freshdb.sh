#!/bin/bash
# Usage: freshdb.sh <db>  -- drops/creates the database and applies the TS server's
# Prisma migrations with psql (what `prisma migrate deploy` would run).
source "$(dirname "$0")/env.sh"
set -e
PSQL="psql -q -U postgres -v ON_ERROR_STOP=1"
$PSQL -c "DROP DATABASE IF EXISTS \"$1\"" >/dev/null 2>&1
$PSQL -c "CREATE DATABASE \"$1\"" >/dev/null
for f in $(ls -d "$ROOT"/packages/happy-server/prisma/migrations/*/ | sort); do
    $PSQL -d "$1" -f "$f/migration.sql" >/dev/null
done
