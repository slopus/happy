#!/usr/bin/env bash
# Prove an encrypted snapshot restores, on a machine that holds the age identity.
# Decrypted data is streamed into the checks and never written to disk.
set -euo pipefail
SNAPSHOT="${1:?usage: backup-drill.sh SNAPSHOT_DIR AGE_IDENTITY_FILE}"
IDENTITY="${2:?usage: backup-drill.sh SNAPSHOT_DIR AGE_IDENTITY_FILE}"
for tool in age pg_restore sha256sum tar; do
  command -v "${tool}" >/dev/null || { echo "${tool} is required" >&2; exit 1; }
done

(cd "${SNAPSHOT}" && sha256sum --check --quiet SHA256SUMS)
# Read each stream to its end so age authenticates every chunk.
age --decrypt -i "${IDENTITY}" "${SNAPSHOT}/rakazo.dump.age" \
  | { pg_restore --list >/dev/null && cat >/dev/null; }
age --decrypt -i "${IDENTITY}" "${SNAPSHOT}/appdata.tgz.age" \
  | { tar -tzf - >/dev/null && cat >/dev/null; }
echo "Backup ${SNAPSHOT} decrypts and verifies"
