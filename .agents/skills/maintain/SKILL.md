---
name: maintain
description: >
  Maintain the slopus/happy open source project. Triage issues, manage the
  GitHub project board, draft closing comments, find duplicates, check if
  bugs are fixed on main, and engage with community contributors. NEVER
  posts comments or closes issues without showing exact text and getting
  approval first.
---

# /maintain - Open Source Project Maintenance

You are maintaining slopus/happy as an open source project. Every issue
is a relationship with a user. Every close is a chance to build trust.

## References (single source of truth - read these, don't inline)

- Contribution priorities: `docs/CONTRIBUTING.md`
- Roadmap themes: `docs/roadmap.md`
- GitHub Project board: https://github.com/orgs/slopus/projects/1

## Golden rule

NEVER close, comment on, or modify issues without showing the exact
text to the maintainer first and getting explicit approval. Even when
told "close all" or "do X" - show the plan, get sign-off.

## Comment voice

- Casual, lowercase, warm. Like texting a coworker.
- No mdashes (use - or commas). No "We're excited to". No AI smell.
- Credit community contributors by @mention when they helped.
- When a fix exists, ask the reporter to help verify it.
- Only mention `npm i -g happy` when the fix is in the CLI package.
- Keep it short: 3 sentences for dupes, 5 max for canonicals.

## Milestones = Themes

Milestones on the GitHub project are broad themes, not specific bugs.
Individual bugs go in the project board's Bugs tab with Priority
(P0/P1/P2) and Size (XS-XL). Only assign a milestone when a bug is
clearly part of a larger theme.

When creating or suggesting milestones, align with `docs/roadmap.md`
sections. Examples of good themes:

- "table stakes" - parity with conductor, daily driver quality
- "multi-agent" - opencode, copilot, cursor, ACP
- "self-hosting" - docker, docs, standalone deployment
- "workspaces" - cross-machine project management

Bad milestone: "fix redis streams" (too specific, that's just a bug)

## Workflow

### Phase 1: Fetch and cluster

1. Pull all open issues from the project board
2. Group by rough topic
3. Present cluster summary with counts

### Phase 2: Deep dive per cluster

For each cluster, spawn a subagent (opus) that:

1. Reads every issue body + comments
2. Identifies duplicate groups with a canonical for each
3. Notes who filed each issue - repeat contributor? filed a PR?
   detailed report? This matters for how we respond.
4. Credits community members who provided fixes or analysis
5. Finds related PRs (open, closed, merged, draft)

### Phase 3: Code check

For each cluster's key issues, spawn a subagent that:

1. Searches the codebase on main - is the bug actually fixed?
2. Checks git log for related merged commits
3. Identifies WHO fixed it (community PR? maintainer?)
4. Verdict: FIXED_ON_MAIN, PARTIALLY_FIXED, or STILL_BROKEN

### Phase 4: Draft actions

For each issue, draft ONE of:

- **CLOSE_FIXED** - cite the fix, ask reporter to verify
- **CLOSE_DUPE** - link canonical, explain the connection
- **KEEP_OPEN** - assign to project board with priority/size
- **NEEDS_INFO** - draft a question for the reporter

### Phase 5: Present for review

Show the maintainer a table per cluster:

| # | Title | Author | Action | Draft comment |

Include who opened each issue and any notable context about them.
WAIT for approval before executing anything.

### Phase 6: Project board updates

For issues that stay open, suggest:
- Priority (P0/P1/P2)
- Size (XS/S/M/L/XL)
- Milestone (theme) if applicable
- Status (Backlog/Ready/In progress)
