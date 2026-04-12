#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OVERLAY="$REPO_ROOT/deploy/overlays/local"

echo "=== Happy Local Deployment (minikube) ==="

# 1. Ensure minikube is running
if ! minikube status --format='{{.Host}}' 2>/dev/null | grep -q Running; then
    echo "Starting minikube..."
    minikube start
else
    echo "minikube is running."
fi

# 2. Point docker to minikube's daemon
echo "Configuring docker to use minikube..."
eval $(minikube docker-env)

# 3. Build the server image
echo "Building happy-server:local image..."
docker build -t happy-server:local -f "$REPO_ROOT/Dockerfile.server" "$REPO_ROOT"

# 4. Run prisma migrations inside a temporary pod
echo "Running database migrations..."
kubectl kustomize "$OVERLAY" --load-restrictor=LoadRestrictionsNone | kubectl apply -f -

echo "Waiting for postgres to be ready..."
kubectl wait --for=condition=ready pod -l app=happy-postgres --timeout=60s

# Run migrations via a one-shot job
kubectl run happy-migrate --rm -i --restart=Never \
    --image=happy-server:local \
    --image-pull-policy=Never \
    --env="DATABASE_URL=postgresql://happy:happy@happy-postgres:5432/happy" \
    -- sh -c "cd /repo && npx prisma migrate deploy --schema=packages/happy-server/prisma/schema.prisma" \
    2>/dev/null || true

# 5. Restart server pods to pick up fresh image
echo "Restarting server pods..."
kubectl rollout restart deployment/handy-server
kubectl rollout status deployment/handy-server --timeout=120s

# 6. Print status
echo ""
echo "=== Deployed ==="
kubectl get pods
echo ""
echo "Server replicas: $(kubectl get deployment handy-server -o jsonpath='{.spec.replicas}')"
echo ""
echo "To access the server:"
echo "  kubectl port-forward svc/handy-server 3005:3000"
echo ""
echo "To view logs from both pods:"
echo "  kubectl logs -l app=handy-server --all-containers -f"
echo ""
echo "To test cross-process events, connect WebSocket clients"
echo "and verify events route between pods."
