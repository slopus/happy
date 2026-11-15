#!/usr/bin/env bash
# Install as /usr/local/sbin/rakazo-deploy-main (the CI forced command). It runs the deploy script
# from the commit CI tested (or origin/main), so deploy changes take effect without reinstalling anything on the host; only
# this launcher is installed, and it rarely changes.
set -Eeuo pipefail

if [[ -z "${RAKAZO_DEPLOY_DIR:-}" && -r /etc/rakazo/deploy.env ]]; then
  # shellcheck disable=SC1091
  source /etc/rakazo/deploy.env
fi
APP_DIR="${RAKAZO_DEPLOY_DIR:-/srv/rakazo}"
[[ "${APP_DIR}" == /* ]] || { echo "RAKAZO_DEPLOY_DIR must be an absolute path" >&2; exit 1; }

cd "${APP_DIR}"
git fetch --quiet --prune origin main
# Run it from memory: the deploy resets the checkout, which would rewrite a script file that bash
# is still reading.
# CI names the commit it tested ("deploy-main <sha>" as the SSH command). Deploy exactly that
# commit, so a commit merged after the green run cannot ship untested. Without one, deploy main.
requested="${SSH_ORIGINAL_COMMAND:-}"
requested="${requested#deploy-main}"
requested="${requested//[[:space:]]/}"
if [[ -n "${requested}" ]]; then
  [[ "${requested}" =~ ^[0-9a-f]{40}$ ]] || { echo "Expected a full commit SHA to deploy" >&2; exit 1; }
  git merge-base --is-ancestor "${requested}" origin/main ||
    { echo "Commit ${requested} is not on main" >&2; exit 1; }
  deployed=""
  [[ -r .last-deployed-revision ]] && deployed="$(tr -d '[:space:]' <.last-deployed-revision)"
  # Runs can finish out of order; never roll production back to an older green commit.
  if [[ -n "${deployed}" && "${deployed}" != "${requested}" ]] &&
    git cat-file -e "${deployed}^{commit}" 2>/dev/null &&
    git merge-base --is-ancestor "${requested}" "${deployed}"; then
    echo "Production already runs ${deployed}, which includes ${requested}; nothing to deploy."
    exit 0
  fi
  revision="${requested}"
else
  revision="$(git rev-parse origin/main)"
fi
script="$(git show "${revision}:infra/compose/deploy-main.sh")"
RAKAZO_DEPLOY_REVISION="${revision}" exec bash -c "${script}" rakazo-deploy-main "$@"
