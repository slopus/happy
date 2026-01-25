# Arc PRDs

Product requirement documents for Arc development tasks.

## Ralph Loop Compatibility

These PRDs are designed to be used with [Ralph Wiggum autonomous loops](https://paddo.dev/blog/ralph-wiggum-autonomous-loops/).

**Key principles:**
- Clear, programmatic success criteria
- Mechanical, well-scoped tasks
- Verifiable outcomes via tests/builds
- Conservative iteration estimates

## Running with Ralph

```bash
# Example: Run PRD-001 with Ralph
cd ~/src/runline/arc
ralph --max-iterations 5 --prompt "$(cat prds/001-agent-display-name.md)"
```

## PRD Index

| PRD | Title | Complexity | Status |
|-----|-------|------------|--------|
| [001](./001-agent-display-name.md) | Runner Display Name Integration | Low | Ready |
| [002](./002-libsodium-version-pin.md) | Pin libsodium-wrappers Version | Low | ✅ Done |
| [003](./003-complete-branding.md) | Complete Runline Branding | Low | ✅ Done |
| [004](./004-voice-binding.md) | Per-Session Voice Binding | Medium | Ready |
| [005](./005-runner-ui-customization.md) | Runner UI Customization | Medium | Ready |

## PRD Template

When creating new PRDs, include:

1. **Type** - Ralph-friendly or requires human judgment
2. **Complexity** - Low/Medium/High
3. **Estimated iterations** - Conservative estimate
4. **Goal** - One sentence
5. **Success Criteria (Programmatic)** - Must be verifiable by commands
6. **Current State** - What exists now
7. **Implementation Steps** - Numbered, specific
8. **Files to Modify** - Explicit list
9. **Files to NOT Modify** - Guardrails
10. **Verification Commands** - Exact commands to run
11. **Rollback** - How to undo if broken

## Not Ralph-friendly Tasks

Some tasks require human judgment:
- EAS build configuration (needs account setup)
- TestFlight deployment (needs Apple credentials)
- Architectural decisions
- Security-sensitive changes
