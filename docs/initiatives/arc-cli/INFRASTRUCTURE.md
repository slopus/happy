# Arc Infrastructure: Deployment & Orchestration Considerations

**Status:** Draft / Exploratory
**Created:** 2026-01-25

---

## The Core Question

How do we deploy and manage Arc agents at scale?

**Current state:** Single machine, single agent, manual setup
**Future state:** Fleet of agents, centralized control, enterprise customers

---

## Deployment Models

### Model A: Static Mac Minis (Current Path)

```
┌─────────────────────────────────────────────────────────┐
│                    Runline Control Plane                │
│  (API, Auth, Session Routing, Agent Registry)           │
└─────────────────────────┬───────────────────────────────┘
                          │ WebSocket / HTTPS
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   ┌─────────┐       ┌─────────┐       ┌─────────┐
   │Mac Mini │       │Mac Mini │       │Mac Mini │
   │ Agent 1 │       │ Agent 2 │       │ Agent 3 │
   │ (Emila) │       │ (Sales) │       │ (Ops)   │
   └─────────┘       └─────────┘       └─────────┘
```

**Pros:**
- Native macOS capabilities (Keychain, AppleScript, native apps)
- No container overhead
- Simple to understand and debug
- Persistent state (filesystem, credentials)
- Works today with Happy/Arc

**Cons:**
- Hardware management overhead
- Scaling = buying more Minis
- No ephemeral isolation (security boundary per agent)
- Manual provisioning
- Colocated or cloud-hosted Macs (expensive)

**Cost:** ~$500-700/Mini + hosting (~$50-100/mo if cloud-hosted)

---

### Model B: Docker on Linux (Classic Cloud)

```
┌─────────────────────────────────────────────────────────┐
│                    Runline Control Plane                │
└─────────────────────────┬───────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   ┌─────────┐       ┌─────────┐       ┌─────────┐
   │Container│       │Container│       │Container│
   │ Agent 1 │       │ Agent 2 │       │ Agent N │
   └────┬────┘       └────┬────┘       └────┬────┘
        └─────────────────┴─────────────────┘
                          │
                    ┌─────▼─────┐
                    │  Docker   │
                    │  Host(s)  │
                    └───────────┘
```

**Pros:**
- Ephemeral by default (spin up/down per session)
- Easy horizontal scaling (K8s, ECS, Fly.io)
- Isolation between agents
- Standard cloud infrastructure
- Cost-effective at scale

**Cons:**
- No macOS (Linux only)
- Lost: Keychain, AppleScript, native Mac apps
- Container escape = security concern
- Claude Code in container = needs testing
- Persistent state requires volumes or external storage

**Cost:** ~$20-50/mo per always-on agent (smaller for ephemeral)

---

### Model C: Apple Virtualization Framework (Emerging)

Apple's container/VM system for macOS (introduced in macOS 13+):

```
┌─────────────────────────────────────────────────────────┐
│                    Runline Control Plane                │
└─────────────────────────┬───────────────────────────────┘
                          │
                    ┌─────▼─────┐
                    │ Mac Host  │
                    │ (Orchestrator)
                    └─────┬─────┘
                          │ Virtualization.framework
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   ┌─────────┐       ┌─────────┐       ┌─────────┐
   │ macOS   │       │ macOS   │       │ macOS   │
   │ VM 1    │       │ VM 2    │       │ VM N    │
   │ (Emila) │       │ (Sales) │       │ (Ops)   │
   └─────────┘       └─────────┘       └─────────┘
```

**Key technologies:**
- **Virtualization.framework** — Apple's hypervisor API
- **Tart** — Open-source tool for macOS VMs (https://github.com/cirruslabs/tart)
- **Orchard** — Orchestration layer for Tart VMs

**Pros:**
- Full macOS environment (Keychain, native apps, etc.)
- Ephemeral VMs (snapshot, clone, destroy)
- Isolation between agents
- Fast boot (~10-30 seconds with Tart)
- Can run on Mac Mini fleet OR cloud Macs (MacStadium, AWS EC2 Mac)

**Cons:**
- Requires macOS host hardware (Apple Silicon or Intel Mac)
- Licensing: macOS can only run on Apple hardware
- More complex than Docker
- Newer technology, less battle-tested
- Storage: each VM is 20-50GB base

**Cost:** Same as Model A hardware, but better utilization

---

### Model D: Hybrid (Recommended Path)

```
Phase 1: Static Mac Minis
    │
    ▼ (when we need isolation/ephemeral)
Phase 2: Tart VMs on Mac Minis
    │
    ▼ (when we need Linux agents or cost optimization)
Phase 3: Docker for Linux agents + Tart for Mac agents
```

**Rationale:**
- Start simple (static Minis work today)
- Add Tart when we need agent isolation or ephemeral sessions
- Add Docker/Linux when we have agents that don't need macOS

---

## Key Challenges

### 1. Session Persistence vs Ephemeral

| Aspect | Persistent | Ephemeral |
|--------|------------|-----------|
| Agent memory | Filesystem | External (S3, DB) |
| Credentials | Keychain / .env | Secrets manager |
| Boot time | Instant | 10-60 seconds |
| State drift | Risk | None |
| Cost | Fixed | Pay-per-use |

**Decision needed:** Do agents need persistent filesystem? Or can we externalize state?

For Emila-style agents:
- `memory-bank/` → Could be git repo (cloned on boot)
- Credentials → Secrets manager (Vault, AWS Secrets)
- Session state → Turso (already external)

### 2. Credential Management

**Current:** Credentials in `~/.claude/`, `~/.arc/`, Keychain

**Challenge:** How do ephemeral VMs get credentials?

**Options:**
| Approach | Pros | Cons |
|----------|------|------|
| Pre-baked in VM image | Fast boot | Security risk, rotation hard |
| Injected at boot | Secure, rotatable | Slower boot, infra needed |
| Secrets manager (Vault) | Best practice | Complexity, latency |
| Keychain + VM snapshot | macOS native | Snapshot management |

**Recommendation:** Inject at boot via environment variables or mounted secrets file.

### 3. Orchestration Layer

**What we need:**
- Start/stop agents on demand
- Route sessions to available agents
- Health monitoring
- Scaling (manual or auto)
- Log aggregation

**Options:**
| Tool | Fits | Notes |
|------|------|-------|
| **Kubernetes** | Docker/Linux | Overkill for small scale |
| **Docker Compose** | Docker/Linux | Simple, single-host |
| **Fly.io** | Docker/Linux | Easy scaling, built-in routing |
| **Orchard** | Tart/macOS | Purpose-built for Mac VMs |
| **Custom (systemd + API)** | Mac Minis | Simple, full control |

**Recommendation:** Start with custom systemd + API on Mac Minis, evaluate Orchard for Phase 2.

### 4. Networking & Routing

**Challenge:** How does mobile app reach the right agent?

**Current (Happy):** Direct WebSocket to relay server → spawns Claude on that machine

**At scale:**
```
Mobile App
    │
    ▼
┌───────────────┐
│  API Gateway  │  (auth, routing)
└───────┬───────┘
        │
   ┌────┴────┐
   ▼         ▼
Agent A   Agent B
```

**Routing strategies:**
- **Sticky sessions** — User always routes to same agent
- **Agent affinity** — Route by agent type (Emila → Mac 1)
- **Load balancing** — Round-robin across available agents

### 5. Boot Scripts & Provisioning

**What needs to happen on agent boot:**

```bash
# 1. Clone/pull agent repo
git clone https://github.com/runline/emila.git /workspace
# or: git -C /workspace pull

# 2. Inject credentials
cp /secrets/.claude-credentials ~/.claude/
cp /secrets/.arc-config ~/.arc/

# 3. Install dependencies (if not baked into image)
cd /workspace && npm install

# 4. Start Arc daemon
arc daemon start

# 5. Register with control plane
curl -X POST https://api.runline.ai/agents/register \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -d '{"agent_id": "emila-1", "status": "ready"}'
```

**Optimization:** Bake steps 1-3 into VM image, run 4-5 on boot.

---

## Infrastructure Components Needed

### Phase 1: Static Mac Minis

| Component | Solution | Status |
|-----------|----------|--------|
| Control plane API | Runline backend | Exists |
| Agent registration | API endpoint | Build |
| Session routing | Relay server (Happy) | Exists |
| Credential storage | Local + manual | Works |
| Monitoring | ? | Need |
| Log aggregation | ? | Need |

### Phase 2: Tart VMs

| Component | Solution | Status |
|-----------|----------|--------|
| VM images | Tart + Packer | Build |
| Orchestration | Orchard or custom | Evaluate |
| Secrets injection | Vault or env vars | Build |
| Persistent storage | Shared volume or git | Design |
| Snapshot management | Tart CLI | Built-in |

### Phase 3: Hybrid (Docker + Tart)

| Component | Solution | Status |
|-----------|----------|--------|
| Container orchestration | Fly.io or K8s | Evaluate |
| Unified control plane | Runline API | Extend |
| Cross-platform routing | API Gateway | Build |

---

## Tart Deep Dive (Model C)

### What is Tart?

Open-source tool for running macOS VMs on Apple Silicon:
- Uses Apple's Virtualization.framework
- Fast boot times (10-30s)
- OCI-compatible image format
- CLI-first, scriptable

### Basic Usage

```bash
# Pull a base macOS image
tart pull ghcr.io/cirruslabs/macos-sonoma-base:latest

# Clone for a new agent
tart clone macos-sonoma-base emila-agent

# Run the VM
tart run emila-agent

# SSH into it
ssh admin@$(tart ip emila-agent)

# Create a snapshot
tart clone emila-agent emila-agent-snapshot-$(date +%Y%m%d)
```

### Arc Agent Provisioning with Tart

```bash
#!/bin/bash
# provision-arc-agent.sh

AGENT_NAME=$1
BASE_IMAGE="ghcr.io/cirruslabs/macos-sonoma-base:latest"

# Clone from base
tart clone $BASE_IMAGE $AGENT_NAME

# Start VM
tart run $AGENT_NAME &
sleep 30  # Wait for boot

# Get IP
VM_IP=$(tart ip $AGENT_NAME)

# Provision via SSH
ssh admin@$VM_IP << 'EOF'
  # Install dependencies
  brew install node git
  npm install -g @anthropic-ai/claude-code

  # Clone agent repo
  git clone https://github.com/runline/emila.git ~/agent

  # Install Arc CLI
  cd ~/agent && npm install

  # Start daemon
  arc daemon start
EOF

# Snapshot the provisioned state
tart stop $AGENT_NAME
tart clone $AGENT_NAME $AGENT_NAME-provisioned
```

### Orchard for Orchestration

Orchard is a scheduler for Tart VMs:
- REST API for VM lifecycle
- Pooling (keep VMs warm)
- Integration with CI/CD

```yaml
# orchard-config.yaml
workers:
  - name: mac-mini-1
    resources:
      vms: 4  # Run 4 VMs per Mini

pools:
  - name: arc-agents
    image: ghcr.io/runline/arc-agent:latest
    min_instances: 2
    max_instances: 10
```

---

## Recommendation: Phased Approach

### Now (Week 1-2)
- **Static Mac Minis** with Arc daemon
- Manual provisioning
- Simple systemd service for daemon
- Register agents with Runline API

### Soon (Month 1-2)
- Add **monitoring** (health checks, alerts)
- Add **log aggregation** (ship to Grafana Cloud)
- Evaluate **Tart** for ephemeral isolation

### Later (Month 3+)
- **Tart VMs** for multi-tenant isolation
- **Orchard** or custom orchestrator
- **Docker** for Linux-only agents (cost optimization)

---

## Open Questions

1. **Multi-tenant isolation** — Do enterprise customers need hard VM boundaries?
2. **State externalization** — Can we make agents fully stateless (git + secrets)?
3. **macOS licensing** — For cloud-hosted Macs, what's the licensing model?
4. **Boot time SLA** — Is 30s VM boot acceptable, or do we need warm pools?
5. **Cost model** — Per-agent pricing vs per-session vs per-minute?

---

---

## Credit Union Deployment Model

**Key insight:** Most CUs run Windows/Linux infrastructure. They don't need macOS.

### Architecture: CU-Hosted Agents

```
┌─────────────────────────────────────────────────────────────┐
│                 Runline Control Plane                       │
│  (Auth, Agent Registry, Session Routing, Observability)     │
│                    runline.ai                               │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS / WebSocket
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌────────────┐  ┌────────────┐  ┌────────────┐
    │ FCU Cloud  │  │ ABC CU     │  │ XYZ CU     │
    │ (Azure)    │  │ (AWS)      │  │ (On-prem)  │
    │            │  │            │  │            │
    │ ┌────────┐ │  │ ┌────────┐ │  │ ┌────────┐ │
    │ │ Agent  │ │  │ │ Agent  │ │  │ │ Agent  │ │
    │ │Container│ │  │ │Container│ │  │ │  VM   │ │
    │ └────────┘ │  │ └────────┘ │  │ └────────┘ │
    └────────────┘  └────────────┘  └────────────┘
```

**Benefits:**
- Agent runs in CU's environment (their compliance boundary)
- Data stays in their cloud/network
- We provide control plane, they provide compute
- Scales with their infrastructure, not ours

### Deployment Options by CU Infrastructure

| CU Has | Deployment | Runline Provides | CU Provides |
|--------|------------|------------------|-------------|
| **Azure** | Container Instance or AKS | Docker image, helm chart | Compute, network |
| **AWS** | ECS, Fargate, or EC2 | Docker image, CloudFormation | Compute, network |
| **GCP** | Cloud Run or GKE | Docker image | Compute, network |
| **On-prem VMware** | VM image (OVA) | VM template, install script | VM host, network |
| **On-prem Docker** | Docker Compose | Compose file, image | Docker host |
| **Windows Server** | WSL2 + Docker | Install script | Windows Server |

### What Runline Provides (SaaS Control Plane)

```
┌─────────────────────────────────────────────┐
│           Runline Control Plane             │
├─────────────────────────────────────────────┤
│ • Authentication (SSO, API keys)            │
│ • Agent registration & health monitoring    │
│ • Session routing (mobile → agent)          │
│ • Observability (traces, logs, metrics)     │
│ • Agent identity (.arc.yaml registry)       │
│ • MCP tool marketplace                      │
│ • Billing & usage tracking                  │
└─────────────────────────────────────────────┘
```

### What CU Provides (Agent Runtime)

```
┌─────────────────────────────────────────────┐
│           CU Infrastructure                 │
├─────────────────────────────────────────────┤
│ • Compute (container/VM)                    │
│ • Network (egress to Runline + Anthropic)   │
│ • Secrets (API keys, credentials)           │
│ • Data access (their systems via MCP)       │
│ • Compliance boundary (SOC2, etc.)          │
└─────────────────────────────────────────────┘
```

### Agent Container Specification

```dockerfile
# Dockerfile for Arc Agent (Linux)
FROM node:20-slim

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install Arc CLI
COPY arc-cli /usr/local/bin/arc
RUN chmod +x /usr/local/bin/arc

# Agent workspace
WORKDIR /agent
COPY . /agent

# Install agent dependencies
RUN npm install

# Environment (injected at runtime)
ENV ANTHROPIC_API_KEY=""
ENV RUNLINE_AGENT_TOKEN=""
ENV RUNLINE_CONTROL_PLANE="https://api.runline.ai"

# Start Arc daemon (connects to control plane)
CMD ["arc", "daemon", "start", "--foreground"]
```

### Deployment Artifacts We Ship

| Artifact | Purpose | Format |
|----------|---------|--------|
| Docker image | Container deployment | `ghcr.io/runline/arc-agent:latest` |
| Helm chart | Kubernetes deployment | `runline/arc-agent` |
| CloudFormation | AWS deployment | YAML template |
| Terraform | Multi-cloud | HCL modules |
| VM image | VMware/Hyper-V | OVA/VHDX |
| Install script | Manual setup | Bash/PowerShell |

### Network Requirements

```
CU Agent → Internet (outbound only)
├── api.runline.ai:443      # Control plane
├── api.anthropic.com:443   # Claude API
├── *.mcp-servers.com:443   # MCP tools (varies)
└── (internal CU systems)   # Via MCP connectors
```

**No inbound ports required** — agent connects outbound to control plane.

### Security Model

```
┌─────────────────────────────────────────────────────────────┐
│                    Trust Boundaries                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────┐          ┌─────────────────┐          │
│  │ Runline (us)    │          │ CU (them)       │          │
│  │                 │          │                 │          │
│  │ • Control plane │◄────────►│ • Agent runtime │          │
│  │ • Auth/routing  │  mTLS    │ • Their data    │          │
│  │ • Observability │          │ • Their secrets │          │
│  │                 │          │                 │          │
│  └─────────────────┘          └─────────────────┘          │
│                                                             │
│  We NEVER see:                We see:                       │
│  • CU's raw data              • Session metadata            │
│  • CU's credentials           • Agent health                │
│  • CU's internal traffic      • Anonymized traces (opt-in)  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Pricing Model Options

| Model | Description | Fits |
|-------|-------------|------|
| **Per-agent/mo** | Flat fee per registered agent | Predictable, simple |
| **Per-session** | Pay per mobile session | Usage-based |
| **Per-seat** | Per CU employee using agents | Enterprise |
| **Platform fee + usage** | Base + API calls | Hybrid |

### Phased Rollout for CUs

**Phase 1: Managed Pilot**
- Runline hosts agent for pilot CU (on our infra)
- Validate use case, gather feedback
- CU doesn't need to deploy anything

**Phase 2: CU-Hosted**
- Provide Docker image + docs
- CU deploys in their cloud
- Runline provides support

**Phase 3: Self-Service**
- CU provisions via Terraform/Helm
- Automated onboarding
- Dashboard for fleet management

---

## Runline Internal Agents (Mac-Based)

For Runline's own agents (Emila, internal tools), we still use Mac:

| Agent | Why Mac | Deployment |
|-------|---------|------------|
| Emila | Keychain, AppleScript, native apps | Mac Mini (Sean's) |
| Internal ops | Same | Mac Mini fleet |

CU agents don't need these capabilities — they're API/MCP-based.

---

## References

- [Tart](https://github.com/cirruslabs/tart) — macOS VMs on Apple Silicon
- [Orchard](https://github.com/cirruslabs/orchard) — Tart orchestration
- [Apple Virtualization.framework](https://developer.apple.com/documentation/virtualization)
- [MacStadium](https://www.macstadium.com/) — Cloud-hosted Macs
- [AWS EC2 Mac](https://aws.amazon.com/ec2/instance-types/mac/) — Mac instances on AWS
