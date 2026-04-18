# Integration Tests

Stress tests that run against a real multi-replica Happy server on minikube.

## Prerequisites

- minikube
- kubectl
- docker
- node 20+ with `socket.io-client`, `tweetnacl`, `ioredis` available

## Start local cluster

```bash
bash local.sh
```

This builds the server image, applies the kustomize overlay (2-replica server + Postgres + Redis + MinIO), runs Prisma migrations, and rolls out the deployment.

After it finishes, open a tunnel to the service:

```bash
minikube service handy-server --url
```

Use the printed URL as `SERVER_URL` for the tests below. If port-forwarding instead:

```bash
kubectl port-forward svc/handy-server 3005:3000
# SERVER_URL=http://127.0.0.1:3005
```

## Run tests

All tests accept `SERVER_URL` env var (defaults to `http://127.0.0.1:3000`).

### Prod-realistic stress (stream pressure + RPC reliability)

```bash
SERVER_URL=http://<tunnel-url> node stress-prod-realistic.mjs [entries_per_sec]
```

Scenarios: `full-server-outage`, `reconnect-connect-err`, `rpc-after-reconnect`, `cascading-disruption`. Default rate: 5000 entries/sec.

### RPC registration under pod kills

```bash
SERVER_URL=http://<tunnel-url> node stress-rpc-registration.mjs <scenario|all>
```

Scenarios: `fire-and-forget`, `register-race-timing`, `reconnect-no-ack`, `rapid-sessions`, `rolling-deploy`, `stale-room-cleanup`, `ios-session-flow`, `high-concurrency`, `cross-replica-3pod`.

### Sync degradation and recovery

```bash
SERVER_URL=http://<tunnel-url> node stress-sync-degradation.mjs <scenario|all>
```

Scenarios: `full-server-outage`, `reconnect-connect-err`, `sync-after-gap`, `rpc-after-reconnect`, `cascading-disruption`.

## Useful kubectl commands

```bash
# Watch pods
kubectl get pods -w

# Tail server logs
kubectl logs -l app=handy-server --all-containers -f

# Kill a specific pod (for pod-kill scenarios)
kubectl delete pod <pod-name> --grace-period=0

# Restart deployment
kubectl rollout restart deployment/handy-server

# Access Redis CLI
kubectl exec -it happy-redis-0 -- redis-cli

# Access MinIO console
kubectl port-forward svc/happy-minio 9001:9001
# then open http://localhost:9001 (minioadmin/minioadmin)
```
