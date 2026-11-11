# Sourced by the harness scripts. WORK holds the throwaway Postgres cluster, logs
# and server data dirs (default: <repo>/.context/compat, gitignored).
COMPAT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$COMPAT/../../.." && pwd)"
# On a host under write pressure point WORK at a tmpfs (WORK=/tmp/happy-compat): Node
# writes stdout to a file synchronously, so a stalled log write stalls the TS server.
WORK="${WORK:-$ROOT/.context/compat}"
PGPORT="${PGPORT:-55487}"
export PGHOST=127.0.0.1 PGPORT
# Third-party endpoints (Expo, ElevenLabs, GitHub) go to a mock the scenario runs here.
COMPAT_MOCK="${COMPAT_MOCK:-http://127.0.0.1:3299}"
export COMPAT_MOCK
mkdir -p "$WORK"
