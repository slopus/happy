# Context Panel & Diff Viewer Spec

## Three-Column Layout

Happy adopts a symmetric three-column layout: sessions | content | context.

```
┌─────────────┬──────────────────────────────┬─────────────────┐
│  Sessions   │         Center (content)     │  Context Panel  │
│   ~220px    │        fills remaining       │    ~220px       │
└─────────────┴──────────────────────────────┴─────────────────┘
```

- Left and right columns are the **same width** so the center content is always visually centered.
- Center is always the content surface: chat, diff viewer, file viewer, terminal (future), tour (future).
- Right panel is **navigation and status only** — clicking items opens them in center.
- Right panel state is **per-worktree**, shared across all sessions in that worktree.
- Zen mode hides both panels, full width for center content.

## Context Panel (Right)

### Sub-tabs at top

Three tabs: **Changed** | **Important** | **All**

#### Changed (v1 — build first)

Git diff file list for the worktree. Shows modified/added/deleted files with line change counts.

```
▼ Changes (3)
  M src/auth.ts          +3  -2
  M src/routes.ts        +1  -1
  A src/helpers/token.ts  +12
```

Clicking a file opens the unified diff in center, scrolled to that file's section.

#### Important (v2 — later)

A "working set" skeleton — files the agent recently read or wrote, shown in a reduced view. This is a different lens on changes: not just what changed in git, but what the agent *touched* and *why*. Like a context map of the agent's recent activity.

- Files are ordered by recency of access (read or write)
- Shows a reduced skeleton: file name, what the agent did (read/edited/created), relevant line ranges
- Helps the user understand the agent's mental model — "these are the files it was working with"

#### All (v3 — later)

Full hierarchical file tree browser. Search, create, rename, delete. Like a mini IDE explorer. Clicking opens file in center viewer.

### Below tabs (aspirational — not in v1)

These sections are future additions that appear below the tab content. Not part of initial implementation.

- **Pipeline / Flow** (aspirational) — ACP loops, custom pipelines, CI-like status. Any repeating or orchestrated work.
- **Terminals** (aspirational) — list of active terminals on the machine, with port numbers. Click to open terminal in center.
- **Guided Tour** (aspirational) — entry point for onboarding walkthrough. Inspired by [Graphite Code Tours](https://graphite.com/blog/code-tours) which turn PRs into guided narrative walkthroughs where explanation lives alongside code diffs.

## Diff Viewer (Center)

### Single scrollable diff surface

All changed files rendered as **one continuous scrollable page** — not per-file tabs.

```
┄┄ src/auth.ts ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  ← sticky file header
  40 │
  41 │ function checkAuth(token: Token) {
  42 │-  if (token.expired) {
     │+  if (isExpired(token)) {
  43 │     return res.status(401)
  44 │-      .send('unauthorized')
     │+      .json({ error: 'expired' })
  45 │   }

  ──── Unchanged (12 lines) ────                 ← collapsed, click to expand

┄┄ src/routes.ts ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  53 │-  app.use(oldAuth)
     │+  app.use(newAuth)

┄┄ end ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
```

- File headers are sticky dividers as you scroll
- Right panel index highlights which file you're currently scrolled to
- Click index entry → smooth scroll to that file's section
- Collapsed unchanged regions between hunks (click to expand)
- `← Back to chat` returns to the session at the same scroll position
- View modes: [Unified] [Side-by-side] [Full file]

### Syntax highlighting

Full syntax highlighting in diffs. Green/red backgrounds for additions/removals with the actual language coloring preserved.

## Mobile Behavior

Two-push navigation:

### Push 1: Index screen (right panel content, full screen)

```
┌─────────────────────────┐
│ ← Session    Changes    │
├─────────────────────────┤
│ [Changed] [Imp.] [All]  │
│                         │
│  M src/auth.ts     +3-2 │
│  M src/routes.ts   +1-1 │
│                         │
│  Pipeline               │
│  ✓ lint    ⟳ test       │
│                         │
│  Terminals              │
│  ● dev-server :3000     │
└─────────────────────────┘
```

### Push 2: Full diff, scrolled to tapped file

```
┌─────────────────────────┐
│ ← Index          2 files│
│                         │
│ ┄ src/auth.ts ┄┄┄┄┄┄┄┄ │
│ (scroll up to see)      │
│                         │
│ ┄ src/routes.ts ┄┄┄┄┄┄ │  ← scrolled here
│  53 │- app.use(oldAuth) │
│     │+ app.use(newAuth) │
│                         │
│ ┄ end ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │
│                         │
│ ┌─────────────────────┐ │
│ │ file index    [2/2] │ │  ← sticky mini-nav
│ └─────────────────────┘ │
└─────────────────────────┘
```

- Sticky mini-nav at bottom for jumping between files without going back
- Swipe back → index → swipe back → session

## Better Table Rendering

Part of the session content quality push alongside diffs. Tables in agent output should render as actual formatted tables, not monospace markdown blocks.

## Better Session Content (related improvements)

- Clickable file paths in agent messages (resolve against remote machine context)
- Richer inline tool output (syntax-highlighted snippets, not collapsed JSON)
- Better table rendering in agent output
- Fix black stripe artifact in file edit tool rendering
- Fix duplicated plan presentation

## Platform Focus

Desktop first. Mobile second — mobile navigation (push index → push diff) is designed but not part of initial implementation.

## Sidebar Show/Hide

Simple: both sidebars are always visible. One zen mode toggle hides both, restores both. Desktop only.

- Zen button in header bar or `Cmd+0`
- Zen hides both panels, center goes full width
- Exit zen restores both panels
- No individual panel toggles — keep it simple

## Implementation Priority

v1 (build now — desktop):
1. **Three-column layout** with sidebar show/hide
2. **Changed tab** in right panel — git diff file list
3. **Unified diff viewer** in center — single scrollable page, click file in index to scroll
4. **Clickable file paths in chat** — low effort, high impact
5. **Zen mode** toggle

v2 (next):
6. **Important tab** — working set skeleton
7. **Better table rendering** in session messages
8. **Mobile push navigation** for index + diff

v3 (aspirational):
9. **All tab** — file tree browser
10. **Pipeline/flow section** in context panel
11. **Terminals list** in context panel
12. **Guided Tour** entry point

## References

- [Graphite Code Tours](https://graphite.com/blog/code-tours) — guided narrative walkthroughs of PR changes
- Superset: side-by-side diff, file tree, changes panel (see docs/competition/superset/)
- Conductor: right panel diff viewer with comment selection (see research notes)
- GitHub PR "Files changed" — single scrollable diff surface with file index
