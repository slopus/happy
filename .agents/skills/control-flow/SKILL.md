---
name: control-flow
description: >
  Analyze and design control flows and data structures. Produces compact
  ASCII tree diagrams showing triggers, call chains, payload shapes, state
  mutations, and re-render effects. Use when user asks to diagram, trace,
  visualize, or design a flow or data structure.
---

# /control-flow — Analyze and design control flows and data structures

Read the relevant source code and produce ASCII tree diagrams inside ```txt blocks.

## Format

- Each user action or IO event is a separate tree root
- Real function names and types — never invent
- Payload shapes as TypeScript types, not prose
- State mutations: which fields change, what triggers
- Re-render chain: which components and why
- Cross-package when the flow spans app → CLI → server
- Compact — skip trivial pass-throughs, show decisions

Example:

    User taps "Archive"
    │
    ├─ handleActionPress(action: SessionActionItem)
    │  └─ onClose() → setActionsAnchor(null)
    │
    ├─ sessionKill(sessionId: string)
    │  ├─ POST /api/sessions/:id/kill
    │  └─ → { success: boolean, message?: string }
    │
    └─ deleteSession(sessionId)
       ├─ mutates: sessions, sessionMessages, gitStatus, fileCache
       ├─ rebuilds: sessionListViewData
       └─ re-renders: SessionsListWrapper (data ref changed)

For data structures, show the shape and what depends on it:

    SessionRowData (flat primitives, cheap deep-equal)
    ├─ id, name, subtitle, avatarId     ← identity + display
    ├─ state: SessionState              ← collapsed from presence + agentState + thinking
    ├─ hasDraft: boolean                ← collapsed from draft string
    ├─ activeAt?: number                ← only inactive sessions (avoids heartbeat diffs)
    ├─ machineId, path, homeDir         ← grouping in ActiveSessionsGroup
    └─ completedTodosCount, totalTodosCount
       │
       consumed by:
       ├─ SessionItem         → renders purely from props, no store hooks
       ├─ ActiveSessionsGroup → groups by machineId + path
       └─ useDeepEqual        → 12 primitive comparisons vs full Session tree

## Principles

- Expressive yet compact — every line earns its place
- Show payload SHAPE not description
- Show state mutations → which store fields, what rebuilds
- Show re-render chain → component + reason
- Pseudo code only for branching logic between nodes
- Always output inside ```txt for alignment
- File:line refs when helpful, not mandatory — the flow matters more than the location

## Process

1. Parse topic into entry points
2. Grep/Explore to find the call chain
3. Read each step at the relevant lines
4. Build tree from trigger → final effect
5. Output as ```txt blocks
