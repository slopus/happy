# Arc CLI Initiative

**Owner:** Sean
**Status:** Planning
**Created:** 2026-01-25

---

## Overview

Arc CLI is Runline's fork of Happy CLI — a mobile interface for AI agents running on Claude Code. Arc extends Happy with enterprise features for credit union deployments.

## Documents

| Document | Purpose |
|----------|---------|
| [IMPLEMENTATION.md](./IMPLEMENTATION.md) | Technical implementation plan for Arc CLI features |
| [INFRASTRUCTURE.md](./INFRASTRUCTURE.md) | Deployment models, orchestration, CU hosting |
| [../observability/PRD.md](../observability/PRD.md) | OTEL trace capture PRD |

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Code isolation | All Arc code in `src/arc/` | Easy upstream merges |
| Tracing | OTEL → Grafana | Claude Code native support |
| CU deployment | CU-hosted containers | Data stays in their boundary |
| Mac vs Linux | Mac for Runline, Linux for CUs | CUs don't need macOS features |

## What Arc Adds to Happy

| Feature | Happy | Arc |
|---------|-------|-----|
| Agent identity | Path-based | `.arc.yaml` config |
| Observability | None | OTEL traces |
| Enterprise auth | — | SSO, API keys |
| CU deployment | — | Docker, Helm, Terraform |
| Control plane | — | Agent registry, routing |

## Timeline

| Phase | What | Effort |
|-------|------|--------|
| 1 | Foundation (arc subcommand, config, .arc.yaml) | 1-2 days |
| 2 | Tracing (--trace, OTEL) | 2-3 days |
| 3 | Agent identity (session metadata) | 1 day |
| 4 | CLI rename & branding | 0.5 days |
| 5 | CU deployment artifacts | 1-2 weeks |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 Runline Control Plane                       │
│         (Auth, Routing, Observability, Registry)            │
└──────────────────────────┬──────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
   ┌───────────┐    ┌───────────┐    ┌───────────┐
   │ Runline   │    │ CU Cloud  │    │ CU Cloud  │
   │ (Mac)     │    │ (Azure)   │    │ (AWS)     │
   │           │    │           │    │           │
   │  Emila    │    │  Agent A  │    │  Agent B  │
   └───────────┘    └───────────┘    └───────────┘
```

## Quick Links

- **Arc repo:** `~/src/runline/arc`
- **Happy upstream:** https://github.com/slopus/happy
- **CLI source:** `arc/cli/src/`
- **Arc customizations:** `arc/cli/src/arc/` (to be created)

## Next Actions

- [ ] Set up upstream remote: `git remote add upstream https://github.com/slopus/happy.git`
- [ ] Create `src/arc/` directory structure
- [ ] Implement `--trace` flag (Phase 2)
- [ ] Build Docker image for CU deployment
