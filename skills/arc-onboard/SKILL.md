---
name: arc-onboard
description: Use at session start in the Arc repo to understand current state and determine next actions
---

# Arc Onboarding Skill

Run this skill when starting a session in the Arc repo to:
1. Understand the current initiative state
2. Identify what's been done vs what's pending
3. Recommend the highest-leverage next action

## Checklist

### 1. Read Initiative Docs

Read these files to understand current state:

- [ ] `docs/initiatives/arc-cli/README.md` — Initiative overview
- [ ] `docs/initiatives/arc-cli/IMPLEMENTATION.md` — Technical plan
- [ ] `docs/initiatives/arc-cli/INFRASTRUCTURE.md` — Deployment architecture
- [ ] `docs/initiatives/observability/PRD.md` — Tracing PRD

### 2. Check Implementation Progress

Verify what's been built:

```bash
# Check if src/arc/ exists
ls -la cli/src/arc/ 2>/dev/null || echo "src/arc/ not created yet"

# Check for ARC MODIFICATION markers in Happy files
grep -r "ARC MODIFICATION" cli/src/*.ts 2>/dev/null || echo "No Arc modifications yet"

# Check if --trace flag exists
grep -n "trace" cli/src/index.ts 2>/dev/null | head -5
```

### 3. Check Git State

```bash
# Current branch
git branch --show-current

# Recent commits
git log --oneline -10

# Pending changes
git status --short

# Upstream sync status
git remote -v | grep upstream || echo "Upstream not configured"
```

### 4. Evaluate Phase Progress

Based on IMPLEMENTATION.md phases:

| Phase | Status | Check |
|-------|--------|-------|
| 1: Foundation | ? | Does `cli/src/arc/index.ts` exist? |
| 2: Tracing | ? | Does `--trace` flag work? |
| 3: Agent Identity | ? | Does session load `.arc.yaml`? |
| 4: CLI Rename | ? | Is binary named `arc`? |

### 5. Determine Next Action

Based on what's missing, recommend ONE next action:

**If Phase 1 not done:**
→ Create `cli/src/arc/` directory structure with stub files

**If Phase 1 done but Phase 2 not:**
→ Implement `--trace` flag with OTEL env injection

**If Phases 1-2 done but Phase 3 not:**
→ Load `.arc.yaml` in session and expose agent metadata

**If all phases done:**
→ Build Docker image and test CU deployment

## Output Format

After evaluation, output:

```
## Arc Session Context

**Current Phase:** [1/2/3/4 or Complete]
**Blockers:** [Any issues found]
**Recommended Next Action:** [Specific task]
**Files to Start With:** [List of files]
```

## Notes

- This skill is for orientation, not implementation
- After running, switch to implementation work
- Update initiative docs if plans change
