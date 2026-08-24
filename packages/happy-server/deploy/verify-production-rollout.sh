#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "Usage: $0 <image-version> <namespace>" >&2
    exit 2
fi

version="$1"
namespace="$2"
rollout_timeout="${ROLLOUT_TIMEOUT:-15m}"

if [[ ! "$version" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "Invalid image version: $version" >&2
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

expected_image="docker.korshakov.com/handy-server:${version}"
umask 077
kube_dir="$(mktemp -d)"
trap 'rm -rf "$kube_dir"' EXIT
printf '%s' "$HAPPY_SERVER_KUBECONFIG_BASE64" | base64 --decode > "$kube_dir/kubeconfig"

run_kubectl() {
    docker run --rm \
        -v "$kube_dir:/workspace:ro" \
        --user "$(id -u):$(id -g)" \
        bitnami/kubectl:latest \
        --kubeconfig=/workspace/kubeconfig \
        "$@"
}

deployed_image="$(
    run_kubectl get --namespace "$namespace" deployment/handy-server \
        -o jsonpath='{.spec.template.spec.containers[?(@.name=="handy")].image}'
)"
if [[ "$deployed_image" != "$expected_image" ]]; then
    echo "Expected $expected_image, found $deployed_image; rollout verification stopped" >&2
    exit 1
fi

run_kubectl rollout status --namespace "$namespace" deployment/handy-server --timeout="$rollout_timeout"

deployed_image="$(
    run_kubectl get --namespace "$namespace" deployment/handy-server \
        -o jsonpath='{.spec.template.spec.containers[?(@.name=="handy")].image}'
)"
if [[ "$deployed_image" != "$expected_image" ]]; then
    echo "Deployment image changed during rollout verification" >&2
    exit 1
fi
