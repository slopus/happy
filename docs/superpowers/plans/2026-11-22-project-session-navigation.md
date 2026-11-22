# Project session navigation implementation plan

> Execution: parent implements Web UI; independent agent implements authorized history RPC; independent review before merge.

Goal: turn the approved right-side prototype into real project/feature session navigation, deploy through main CI, then verify production with Ego.

Spec: docs/design/goal-session-navigation/REVIEW.md and the approved interactive preview. User approved development, publishing and automatic repairs on 2026-11-22; no further design approval required.

Architecture: a Web-only navigation provider at the stable ProjectGoalsOwner holds sidebar resource, grouping and creation state. ProjectDetailsPanel.web exposes sessions/details/files; native fallback stays unchanged. CLI supplies full historical totals and bounded pages through an authorized aggregate RPC, with existing task identity and account history checks. Canonical activity and SessionView own status/unread/drafts.

Constraints: sibling worktree; root clean main; current theme tokens; no Tauri; no business polling; formal Web only https://47.115.228.20:8443 through merged-main CI; preserve existing workers during local daemon activation.

Review focus: old/unhydrated history is not completed; no loaded-page totals presented as exact; task rebinding/duplicate IDs fail closed; account/project/navigation change fences late work; archived/deleted/retired sessions remain absent; status changes follow events and unread clears only after real focused content.

- [x] Add tests and authorized paginated goalProjectConversations RPC with exact group totals and bounded header-only reads.
- [x] Add model tests for status, grouping, deleted/archive filtering and partial pages; implement provider and Web panel with error/retry/loading/empty/offline states.
- [x] Wire stable owner navigation and existing/new scope routing; reuse keyed SessionView drafts; verify existing workspace regressions and full typecheck.
- [ ] Independent code review and focused fixes; push PR with actual validation and screenshot scope (production Ego key steps requested; no separate PR before/after matrix requested).
- [ ] Match-head normal merge after CI; track exact Web and OTA runs; activate required daemon RPC without killing workers.
- [ ] Ego production: real project/feature totals, filters/search, create scope conversation and real model reply, history/task switch with draft, details/files and refresh. Repair and repeat affected paths if needed.

Case acceptance: C1 real group counts/path and pagination; C2 correct current conversation + draft survives switch; C3 exact scoped new conversation; C4 canonical attention/running/unknown, no premature unread clear; C5 details/files accessible and layout/keyboard usable.

Implementation ruling: realdataKeydaemon lacks accountcontentsecret; complete metadata is decrypted detached by signed-in Web, filtered to selectedmachine and sent without keys. Server independently validates completecatalog fingerprint/versions and canonical ownership. This replaces the assumption that daemon can decrypt every untracked header. Actual filesystem and authority preflight pass; final Ego remains required.
