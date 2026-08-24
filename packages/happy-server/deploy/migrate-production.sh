#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "Usage: $0 <image-version> <namespace>" >&2
    exit 2
fi

version="$1"
namespace="$2"
timeout_seconds="${MIGRATION_TIMEOUT_SECONDS:-600}"

if [[ ! "$version" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "Invalid image version: $version" >&2
    exit 2
fi

if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
    echo "MIGRATION_TIMEOUT_SECONDS must be a positive integer" >&2
    exit 2
fi

if [[ ${#namespace} -gt 63 || ! "$namespace" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
    echo "Invalid Kubernetes namespace: $namespace" >&2
    exit 2
fi

if [[ -z "${HAPPY_SERVER_KUBECONFIG_BASE64:-}" ]]; then
    echo "HAPPY_SERVER_KUBECONFIG_BASE64 is required" >&2
    exit 2
fi

image="docker.korshakov.com/handy-server:${version}"
umask 077
kube_dir="$(mktemp -d)"
trap 'rm -rf "$kube_dir"' EXIT
printf '%s' "$HAPPY_SERVER_KUBECONFIG_BASE64" | base64 --decode > "$kube_dir/kubeconfig"

run_kubectl() {
    docker run --rm -i \
        -v "$kube_dir:/workspace:ro" \
        --user "$(id -u):$(id -g)" \
        bitnami/kubectl:latest \
        --kubeconfig=/workspace/kubeconfig \
        "$@"
}

run_kubectl get --namespace "$namespace" secret/handy-secrets >/dev/null

migration_job="$(run_kubectl create --namespace "$namespace" -f - -o name <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  generateName: handy-server-migrate-
spec:
  activeDeadlineSeconds: $timeout_seconds
  backoffLimit: 0
  ttlSecondsAfterFinished: 86400
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: $image
          command: ["sh", "-c"]
          args:
            - cd /repo/packages/happy-server && ../../node_modules/.bin/prisma migrate deploy
          envFrom:
            - secretRef:
                name: handy-secrets
EOF
)"

deadline=$((SECONDS + timeout_seconds))
while true; do
    succeeded="$(run_kubectl get --namespace "$namespace" "$migration_job" -o jsonpath='{.status.succeeded}')"
    failed="$(run_kubectl get --namespace "$namespace" "$migration_job" -o jsonpath='{.status.failed}')"

    if [[ "$succeeded" == "1" ]]; then
        run_kubectl logs --namespace "$namespace" "$migration_job" || true
        exit 0
    fi

    if [[ -n "$failed" && "$failed" != "0" ]]; then
        run_kubectl logs --namespace "$namespace" "$migration_job" || true
        run_kubectl describe --namespace "$namespace" "$migration_job" || true
        echo "Migration failed; deployment was not started" >&2
        exit 1
    fi

    if (( SECONDS >= deadline )); then
        run_kubectl logs --namespace "$namespace" "$migration_job" || true
        run_kubectl describe --namespace "$namespace" "$migration_job" || true
        echo "Migration timed out; deployment was not started" >&2
        exit 1
    fi

    sleep 2
done
