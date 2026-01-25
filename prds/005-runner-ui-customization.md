# PRD-005: Runner UI Customization

**Type:** Product feature (requires design decisions)
**Complexity:** Medium
**Priority:** P0 for MVP

## Vision

Arc is a "window into Runners that live in repositories." The UI should reflect each Runner's identity as defined in their `.arc.yaml` - showing their name, personality, and visual identity rather than generic session metadata.

### Terminology

- **Runner**: A purpose-built agent aligned to a team/domain (e.g., Fraud, HR). A Runner is "productized behavior," not a one-off prompt. Runners have Runline-hosted capabilities and SOPs for enterprises.
- **Arc**: Internal project name for Runline's mobile interface into Runners.

## Current `.arc.yaml` Attributes

```yaml
runner:
  name: "Emila"                    # Display name
  tagline: "Executive assistant"   # Short description
  avatar: generated | <url>        # Profile image
  primaryColor: "#6366F1"          # Accent color

voice:
  elevenlabs_agent_id: "abc123"    # Voice binding
  greeting: "Hey, what's up?"      # Custom greeting
  language: "en"                   # Language code

org:
  id: "runline"                    # Organization binding
  require_auth: false              # Auth requirement
```

## UI Integration Points

### 1. Session List (P0)

**Current:** Shows path-based name + generated avatar
**Target:** Show Runner name + custom avatar + tagline

**Loading UX (decided):**
- Show path immediately as placeholder
- Show shimmer animation while loading `.arc.yaml`
- Replace with Runner name when loaded

```
┌─────────────────────────────────────┐
│ [Avatar]  ~/src/emila  ░░░░░░       │  <- Loading (shimmer)
│           ● Online                  │
└─────────────────────────────────────┘

         ↓ After load ↓

┌─────────────────────────────────────┐
│ [Avatar]  Emila                     │
│           Executive assistant       │
│           ● Online                  │
└─────────────────────────────────────┘
```

**Attributes used:**
- `runner.name` → Primary text (replaces path)
- `runner.tagline` → Secondary text
- `runner.avatar` → Profile image (or generated fallback)

### 2. Session Header (P0)

**Current:** Generic header with path
**Target:** Runner identity header

```
┌─────────────────────────────────────┐
│ ← [Avatar] Emila          [Voice] ⋮ │
└─────────────────────────────────────┘
```

**Attributes used:**
- `runner.name` → Header title
- `runner.avatar` → Small avatar
- `runner.primaryColor` → Header accent (optional)

### 3. Voice Activation (P1)

**Current:** Single hardcoded voice agent
**Target:** Per-session voice based on config

**Attributes used:**
- `voice.elevenlabs_agent_id` → Which voice agent to connect
- `voice.greeting` → Optional custom greeting
- `voice.language` → Language preference

### 4. Empty State / Onboarding (P2)

When no sessions exist, show guidance:

```
┌─────────────────────────────────────┐
│                                     │
│     No Runners connected            │
│                                     │
│  Start Claude Code in a repo with   │
│  .arc.yaml to customize your Runner │
│                                     │
└─────────────────────────────────────┘
```

## MVP Scope (Sean Dogfooding)

### Must Have
- [ ] Session list shows `runner.name` instead of path
- [ ] Session list shows `runner.tagline` as subtitle
- [ ] Session header shows Runner name
- [ ] Loading state: show path immediately with shimmer, replace when loaded
- [ ] Custom avatar image support from `runner.avatar` URL

### Nice to Have
- [ ] Generated avatar fallback with `runner.primaryColor`
- [ ] primaryColor theming for header accent
- [ ] Per-session voice binding

### Defer
- [ ] Organization features
- [ ] Multi-Runner management UI
- [ ] Runner settings/preferences

## Implementation Approach

### Option A: Patch Existing Components
- Modify `SessionListItem`, `SessionHeader` directly
- Import `useAgentConfigContext` and replace name sources
- Minimal changes, faster to ship

### Option B: Create Arc UI Layer
- New components in `sources/arc/ui/`
- Wrap existing components with Runner-aware versions
- More maintainable, easier to merge upstream

**Recommendation:** Option A for MVP, refactor to Option B later

## Files to Modify

Based on exploration needed:
- Session list component (find via `grep -rn "SessionList\|session.*list" sources/`)
- Session header component
- Possibly session detail/chat view

## Resolved Questions

1. **Loading UX:** Show path immediately, shimmer animation, replace with Runner name when loaded
2. **Fallback behavior:** When .arc.yaml missing, continue showing path
3. **Avatar support:** Support custom avatar images via URL in `runner.avatar`

## Open Questions

1. **Offline support:** Cache Runner configs locally?
2. **Refresh:** Manual refresh button? Auto-refresh on reconnect?
3. **Schema migration:** Keep `agent:` key for backwards compat or rename to `runner:`?

## Success Criteria

1. Open Arc → See "Emila" instead of "~/src/emila"
2. Open session → Header shows "Emila" with avatar
3. Loading state shows shimmer, not blank
4. Tap voice → Uses Emila's configured voice agent (if set)

## Evolution Path

### Phase 1: MVP (This PRD)
- Basic name/tagline display
- Path → Runner name loading transition
- Single user (Sean) dogfooding

### Phase 2: Visual Identity
- Custom avatars from URL
- Color theming
- Avatar generation improvements

### Phase 3: Enterprise
- Organization binding
- Multi-tenant session visibility
- SSO integration

### Phase 4: Runner Marketplace
- Discover public Runners
- Runner templates
- Sharing/cloning Runner configs
