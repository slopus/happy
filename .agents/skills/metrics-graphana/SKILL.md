---
name: metrics-graphana
description: >
  Query and manage Grafana dashboards and Prometheus metrics for Happy infrastructure.
  Covers grafanactl CLI usage, direct Prometheus queries through Grafana proxy,
  and dashboard-as-code workflows. Use when user asks about metrics, dashboards,
  monitoring, Grafana, Prometheus, or wants to add/modify panels.
---

# Metrics & Grafana

You are the observability operator for the Happy infrastructure. You can query live Prometheus metrics, manage Grafana dashboards as code, and investigate production behavior.

## Environment Variables

Credentials are stored in the repo root `.env` file (gitignored). Load them before running commands:

```
GRAFANA_URL=...
GRAFANA_USER=...
GRAFANA_PASSWORD=...
GRAFANA_PROMETHEUS_UID=...
```

To load in shell:
```bash
set -a; source .env; set +a
```

All commands below use `$GRAFANA_URL`, `$GRAFANA_USER`, `$GRAFANA_PASSWORD`, and `$GRAFANA_PROMETHEUS_UID` from the environment.

---

## Prerequisites

### Install grafanactl

```bash
go install github.com/grafana/grafanactl/cmd/grafanactl@latest
```

Ensure `$HOME/go/bin` is on your PATH.

### Configure grafanactl

```bash
# Load env vars first
set -a; source .env; set +a

# Create a context for the Happy Grafana instance
grafanactl config set contexts.happy.grafana.server "$GRAFANA_URL"
grafanactl config set contexts.happy.grafana.user "$GRAFANA_USER"
grafanactl config set contexts.happy.grafana.password "$GRAFANA_PASSWORD"
grafanactl config set contexts.happy.grafana.org-id 1

# Switch to the context
grafanactl config use-context happy

# Verify
grafanactl config check
```

Config file lives at `~/Library/Application Support/grafanactl/config.yaml` (macOS) or `~/.config/grafanactl/config.yaml` (Linux).

---

## grafanactl CLI Reference

### List resources

```bash
grafanactl resources list                    # List all resource types
grafanactl resources get dashboards          # List all dashboards
grafanactl resources get folders             # List all folders
```

### Pull dashboards (export to disk)

```bash
grafanactl resources pull dashboards -p ./resources -o json
grafanactl resources pull dashboards/DASHBOARD_ID -p ./resources -o json
```

### Push dashboards (deploy from disk)

```bash
# Push all dashboards from ./resources
grafanactl resources push dashboards -p ./resources

# Push a specific dashboard
grafanactl resources push dashboards/DASHBOARD_ID -p ./resources

# IMPORTANT: Use --omit-manager-fields to keep dashboards editable from the Grafana UI
grafanactl resources push dashboards -p ./resources --omit-manager-fields

# Dry run (no changes)
grafanactl resources push dashboards -p ./resources --dry-run
```

### Workflow: Edit a dashboard

```bash
# 1. Pull current state
mkdir -p /tmp/grafana-work
grafanactl resources pull dashboards -p /tmp/grafana-work -o json

# 2. Edit the JSON files (add panels, modify queries, etc.)

# 3. Push back — always use --omit-manager-fields to avoid locking the UI
grafanactl resources push dashboards -p /tmp/grafana-work --omit-manager-fields
```

> **Warning:** Pushing without `--omit-manager-fields` marks the dashboard as "provisioned"
> and locks it from UI edits. Always include this flag unless you explicitly want CLI-only management.

---

## Querying Prometheus Directly

You can query Prometheus through Grafana's datasource proxy API. This is useful for live investigation without touching the Grafana UI.

### Instant query (current value)

```bash
curl -s -u "$GRAFANA_USER:$GRAFANA_PASSWORD" \
  --data-urlencode 'query=YOUR_PROMQL_HERE' \
  "$GRAFANA_URL/api/datasources/proxy/uid/$GRAFANA_PROMETHEUS_UID/api/v1/query" \
  | python3 -m json.tool
```

### Range query (time series)

```bash
curl -s -u "$GRAFANA_USER:$GRAFANA_PASSWORD" \
  --data-urlencode 'query=YOUR_PROMQL_HERE' \
  --data-urlencode 'start=UNIX_TIMESTAMP' \
  --data-urlencode 'end=UNIX_TIMESTAMP' \
  --data-urlencode 'step=60' \
  "$GRAFANA_URL/api/datasources/proxy/uid/$GRAFANA_PROMETHEUS_UID/api/v1/query_range" \
  | python3 -m json.tool
```

### List all metric names

```bash
curl -s -u "$GRAFANA_USER:$GRAFANA_PASSWORD" \
  "$GRAFANA_URL/api/datasources/proxy/uid/$GRAFANA_PROMETHEUS_UID/api/v1/label/__name__/values" \
  | python3 -c "import json,sys; [print(n) for n in json.load(sys.stdin)['data']]"
```

### Filter metric names

```bash
# Find all RPC-related metrics
curl -s -u "$GRAFANA_USER:$GRAFANA_PASSWORD" \
  "$GRAFANA_URL/api/datasources/proxy/uid/$GRAFANA_PROMETHEUS_UID/api/v1/label/__name__/values" \
  | python3 -c "import json,sys; [print(n) for n in json.load(sys.stdin)['data'] if 'rpc' in n.lower()]"
```

---

## Key Metrics

### Application metrics (handy-server)

| Metric | Type | Description |
|--------|------|-------------|
| `rpc_calls_total` | counter | RPC calls by method and result (success, not_available, target_disconnected, timeout) |
| `rpc_call_duration_seconds_bucket` | histogram | RPC call duration by method |
| `rpc_lookup_retries_bucket` | histogram | Number of retries per socket lookup by method |
| `rpc_fetchsockets_timeouts_total` | counter | fetchSockets timeout count by context (lookup, presence) |
| `websocket_connections_total` | gauge | Active WebSocket connections by type |
| `websocket_events_total` | counter | WebSocket events by type |
| `http_requests_total` | counter | HTTP requests by method, route, status |
| `http_request_duration_seconds_bucket` | histogram | HTTP request duration by route |
| `session_cache_operations_total` | counter | Session cache hits/misses by operation |
| `session_alive_events_total` | counter | Session keepalive events |
| `machine_alive_events_total` | counter | Machine keepalive events |
| `database_records_total` | gauge | Record counts by table |
| `database_updates_skipped_total` | counter | Skipped DB updates by type |

### Useful PromQL queries

```promql
# RPC success rate by method
sum by(method) (rate(rpc_calls_total{result="success"}[5m]))
/ (sum by(method) (rate(rpc_calls_total[5m])))

# RPC failures by method and reason
sum by (method, result) (rate(rpc_calls_total{result!="success"}[5m]))

# RPC failures by type only
sum by (result) (rate(rpc_calls_total{result!="success"}[5m]))

# RPC P95 latency by method
histogram_quantile(0.95, sum by (method, le) (rate(rpc_call_duration_seconds_bucket[5m])))

# Socket lookup retry distribution (P95)
histogram_quantile(0.95, sum by (method, le) (rate(rpc_lookup_retries_bucket[5m])))

# fetchSockets timeout rate by context
sum by (context) (rate(rpc_fetchsockets_timeouts_total[5m]))

# HTTP error rate
sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))

# Top routes by request rate
topk(10, sum by(method, route) (rate(http_requests_total[5m])))
```

---

## Dashboards

### Happy Server Application Metrics
- **ID:** `470da978-91f7-4721-be2c-cc451bf074a2`
- **Tags:** happy-server, application, websocket, http, database
- **Panels:** WebSocket connections, session cache, alive events, HTTP metrics, database stats, RPC metrics

### Adding a panel

When adding panels to a dashboard JSON, follow this pattern:
1. Use the Prometheus datasource: `{"type": "prometheus", "uid": "$GRAFANA_PROMETHEUS_UID"}`
2. Pick the next available `id` (check existing panels for max id)
3. Position with `gridPos`: `h` = height (8 standard), `w` = width (12 half, 24 full), `x` = column (0 or 12), `y` = row
4. Common panel types: `stat`, `timeseries`, `piechart`, `bargauge`, `table`
5. Set appropriate `unit`: `percentunit`, `ops`, `s`, `short`, `reqps`

---

## Tips

- Always pull before editing to get the latest state
- Use `--dry-run` on push to preview changes
- The `--omit-manager-fields` flag is essential for hybrid CLI+UI workflows
- Range queries need Unix timestamps — use `date +%s` to get current time
- When investigating metrics, start with instant queries for current state, then use range queries for trends
