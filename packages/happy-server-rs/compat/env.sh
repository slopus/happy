# Sourced by the harness scripts. WORK holds the throwaway Postgres cluster, logs
# and server data dirs (default: <repo>/.context/compat, gitignored).
COMPAT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$COMPAT/../../.." && pwd)"
WORK="${WORK:-$ROOT/.context/compat}"
PGPORT="${PGPORT:-55432}"
export PGHOST=127.0.0.1 PGPORT
mkdir -p "$WORK"
