# PRD: Arc Observability — Agent Trace Infrastructure

**Status:** Draft
**Author:** Sean + Emila
**Created:** 2026-01-25
**Repo:** `runline/arc`

---

## Problem Statement

As we build agentic workflows on Arc (Runline's Claude Code mobile interface), we need visibility into:
- System prompts and context injection
- Tool calls and their results
- Thinking tokens and decision flow
- Token usage and cost attribution

This is critical for:
1. **Debugging** — Why did the agent do X instead of Y?
2. **Context engineering** — Optimizing what context is injected when
3. **Compliance/audit** — What did agents do on behalf of users?
4. **Learning** — Understanding patterns from Anthropic's system prompts

**Current state:** No observability. Claude Code logs exist but aren't easily viewable or queryable.

---

## Goals

| ID | Goal |
|----|------|
| G1 | Capture traces for all Arc-initiated Claude Code sessions |
| G2 | View traces on mobile (where Arc users operate) |
| G3 | Support local-first with optional cloud sync |
| G4 | Integrate with existing Arc CLI flags/config |
| G5 | Future-proof for multi-agent orchestration tracing |

---

## Non-Goals

- Real-time streaming traces (batch is fine for v1)
- Modifying Claude Code internals
- Building a full APM solution (leverage Grafana stack)

---

## Technical Approach: OTEL Native

Claude Code supports OpenTelemetry natively via environment variable:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
claude  # traces sent to collector
```

This means Arc just needs to:
1. Run an OTEL collector
2. Set the env var when spawning Claude Code
3. Route traces to storage/viewer

---

## Architecture

### Local Mode (Phase 1)

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Arc CLI   │────▶│  Claude     │────▶│  Anthropic  │
│   --trace   │     │  Code       │     │  API        │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │ OTEL
                           ▼
                    ┌──────────────┐
                    │ OTEL         │
                    │ Collector    │
                    │ :4318        │
                    └──────┬───────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
       ┌─────────────┐           ┌─────────────┐
       │ Local File  │           │ Tempo       │
       │ Exporter    │           │ (optional)  │
       │ .jsonl      │           │ :3200       │
       └─────────────┘           └─────────────┘
```

**Components:**
- **OTEL Collector** — Receives traces on :4318 (OTLP/HTTP)
- **File Exporter** — Writes JSONL to `~/.arc/traces/`
- **Tempo** (optional) — Local trace storage with query API

### Cloud Mode (Phase 2)

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────┐
│   Arc CLI   │────▶│  OTEL       │────▶│  Grafana Cloud  │
│   --trace   │     │  Collector  │     │  (Tempo)        │
└─────────────┘     └─────────────┘     └────────┬────────┘
                                                 │
                                        ┌────────▼────────┐
                                        │  Grafana        │
                                        │  Dashboard      │
                                        └─────────────────┘
```

**Why Grafana Cloud:**
- Free tier: 50k traces, 50GB logs — plenty for early usage
- Native OTEL support
- Built-in trace viewer + querying
- $0.50/GB beyond free tier

---

## Implementation Phases

### Phase 1: Local Trace Capture (MVP)

**Goal:** `arc --trace` captures traces to local files

**Deliverables:**
1. OTEL collector config bundled with Arc
2. `--trace` flag in `arc` CLI
3. Collector lifecycle management (start/stop with session)
4. Local file exporter → `~/.arc/traces/<session-id>.jsonl`
5. HTML report generation (port claude-trace viewer)

**CLI UX:**
```bash
# Start with tracing
arc --trace

# Generate report from trace
arc trace view ~/.arc/traces/abc123.jsonl

# List recent traces
arc trace list
```

**Effort:** 3-4 days

### Phase 2: Local Tempo + Grafana

**Goal:** Query traces locally via Grafana

**Deliverables:**
1. Docker Compose for Tempo + Grafana (single binary mode)
2. `arc trace server` — starts local observability stack
3. Pre-built Grafana dashboards for agent traces
4. Trace correlation with session metadata

**CLI UX:**
```bash
# Start local observability stack
arc trace server

# Open Grafana (auto-tunneled for mobile)
arc trace dashboard
```

**Effort:** 2-3 days

### Phase 3: Cloud Sync (Grafana Cloud)

**Goal:** Optional sync to Grafana Cloud for cross-device access

**Deliverables:**
1. Grafana Cloud API key configuration
2. OTEL exporter to Grafana Cloud Tempo
3. Mobile-friendly Grafana dashboards
4. Retention policy configuration

**CLI UX:**
```bash
# Configure cloud sync
arc trace config --grafana-cloud

# View traces in browser (Grafana Cloud URL)
arc trace dashboard --cloud
```

**Effort:** 2-3 days

### Phase 4: In-App Trace Viewer

**Goal:** View traces directly in Arc mobile app

**Deliverables:**
1. Trace list view in app
2. Trace detail view (messages, tools, timing)
3. Filter by session, agent, date
4. Share trace as link

**Effort:** 1-2 weeks

---

## OTEL Collector Configuration

### Minimal Local Config

```yaml
# ~/.arc/otel-collector.yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  file:
    path: ${HOME}/.arc/traces/current.jsonl
    rotation:
      max_megabytes: 100
      max_days: 30

processors:
  batch:
    timeout: 1s

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [file]
```

### With Tempo

```yaml
exporters:
  file:
    path: ${HOME}/.arc/traces/current.jsonl
  otlp/tempo:
    endpoint: localhost:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [file, otlp/tempo]
```

### With Grafana Cloud

```yaml
exporters:
  otlp/grafana:
    endpoint: tempo-us-central1.grafana.net:443
    headers:
      authorization: Basic ${GRAFANA_CLOUD_API_KEY}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [file, otlp/grafana]
```

---

## Arc CLI Changes

### New Flags

| Flag | Description |
|------|-------------|
| `--trace` | Enable trace capture for session |
| `--trace-endpoint <url>` | Custom OTEL endpoint (default: localhost:4318) |

### New Subcommand: `arc trace`

```bash
arc trace                    # Show trace status
arc trace list               # List recent traces
arc trace view <file>        # Generate HTML report
arc trace server             # Start local Tempo + Grafana
arc trace dashboard          # Open Grafana (local or cloud)
arc trace config             # Configure trace settings
```

### Config File

```yaml
# ~/.arc/config.yaml
trace:
  enabled: true
  endpoint: http://localhost:4318
  cloud:
    provider: grafana
    api_key: ${GRAFANA_CLOUD_API_KEY}
```

---

## Data Model

### Trace Structure (OTEL Spans)

```
Trace: session-abc123
├── Span: user_prompt
│   ├── attributes: {prompt: "...", tokens: 150}
│   └── events: [{name: "submitted", timestamp: ...}]
├── Span: assistant_response
│   ├── attributes: {model: "claude-opus-4-5", tokens_in: 5000, tokens_out: 800}
│   ├── Span: tool_use (Edit)
│   │   └── attributes: {file: "...", result: "success"}
│   ├── Span: tool_use (Bash)
│   │   └── attributes: {command: "...", exit_code: 0}
│   └── events: [{name: "thinking", data: "..."}]
└── Span: session_end
    └── attributes: {total_cost: 0.15, duration_ms: 45000}
```

### Session Metadata

```json
{
  "session_id": "abc123",
  "agent": "emila",
  "repo": "/Users/sean/src/emila",
  "machine": "mac-studio",
  "started_at": "2026-01-25T10:00:00Z",
  "trace_file": "~/.arc/traces/abc123.jsonl"
}
```

---

## Mobile Viewing Strategy

### Option A: Ngrok Tunnel (Quick)

```bash
arc trace dashboard  # Starts Grafana + ngrok
# => https://abc123.ngrok.io (view on phone)
```

### Option B: Grafana Cloud (Recommended for prod)

- Native mobile browser support
- No tunnel management
- Cross-device access

### Option C: In-App Viewer (Future)

- Best UX but most effort
- Requires parsing OTEL in React Native

**Recommendation:** Start with B (Grafana Cloud free tier), fall back to A for offline/airgapped.

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Trace capture latency | <100ms overhead |
| Report generation | <5s for 1hr session |
| Mobile load time | <3s for trace list |
| Storage efficiency | <10MB per hour of session |

---

## Open Questions

1. **Trace sampling:** Capture everything or sample? (Start with everything)
2. **PII handling:** Mask sensitive data in traces? (Yes, configurable)
3. **Multi-agent:** How to correlate traces across agent handoffs?
4. **Cost attribution:** How to calculate $/trace for billing visibility?

---

## Dependencies

- [OTEL Collector](https://opentelemetry.io/docs/collector/) — Core infrastructure
- [Grafana Tempo](https://grafana.com/oss/tempo/) — Trace storage
- [Grafana Cloud](https://grafana.com/products/cloud/) — Hosted option (free tier: 50k traces)
- Claude Code OTEL support (native, env var)

---

## Timeline

| Phase | Deliverable | Effort | Target |
|-------|-------------|--------|--------|
| 1 | Local trace capture | 3-4 days | Week of Jan 27 |
| 2 | Local Tempo + Grafana | 2-3 days | Week of Feb 3 |
| 3 | Grafana Cloud sync | 2-3 days | Week of Feb 10 |
| 4 | In-app viewer | 1-2 weeks | TBD |

---

## References

- [OpenTelemetry Collector Setup](https://grafana.com/docs/opentelemetry/collector/)
- [Grafana Tempo on Kubernetes](https://medium.com/@nsalexamy/deploying-grafana-tempo-on-kubernetes-a-practical-guide-20708ed61c0b)
- [Grafana Cloud Pricing](https://grafana.com/pricing/) — Free tier includes 50k traces
- [Jaeger to Tempo Migration](https://developers.redhat.com/articles/2025/04/09/best-practices-migration-jaeger-tempo)
- [OTEL to Grafana Stack](https://grafana.com/docs/alloy/latest/collect/opentelemetry-to-lgtm-stack/)

---

## Appendix: Claude Code OTEL Env Var

Claude Code respects standard OTEL environment variables:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=claude-code
claude  # traces flow automatically
```

No code changes to Claude Code required — just env var injection in Arc CLI.
