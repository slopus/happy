# Paws Web session steward implementation plan

Goal: The existing Paws chief in Bots can list/read all owned coding sessions, report evidence-based progress, submit instructions, resume an original session and observe the exact submitted turn while this authenticated Web client is connected.

Architecture: A bounded event-driven reverse tool bridge in the existing Bots gateway binds one browser lease to its native chief/space. Server-side tools carry trusted run identity, not model-supplied account identity. The Web host executes a fixed allowlist through existing sync/encryption and machine resume APIs. No Paws credential enters Bots. Tool output is intentionally model-visible.

Constraints: sibling worktree only; Web only; no external account access or PAT; no polling or automatic mutation retry; close/account switch cancels pending work; do not replay old user instructions on resume. Existing Bot approval policy remains authoritative. No deployment authorized by this plan.

## Tasks
- [x] Gateway broker: node tests fail then pass for exact owner/space isolation, lost connection, duplicate/late reply, timeout, bounded state and no mutation replay. Add authenticated stream/result/internal-call routes using existing lease and bridge secret.
- [x] Web tools: tests fail then pass for paginated directory, bounded detached history reads, stable message ids, resume preconditions and exact localId/turn tracking. Wire browser callbacks without exporting account keys. Stream connected throughout the mounted Bots workspace.
- [x] Bot tools: owner-initiated chief-only tools, schema validation, existing approval/effect journal, fixed server-configured bridge destination. Browser transport dispatches only allowlisted tool calls. Document optional worker bridge configuration.
- [x] Verify targeted Node/Vitest suites and typechecks/builds; fresh whole-branch review; document actual remaining deployment/browser acceptance boundaries.

Review focus: account change during async send, cross-space requests, multiple tabs, initial subscription race, stale completion, unknown mutation outcome, legacy turn without localIds, full catalog pagination, machine offline, secrets in tool output.

User approved the minimal scope and explicitly asked to begin. Execution is inline; no additional plan approval required. Existing production services are not changed.

Evidence: `docs/validation/2026-11-20-bots-session-steward.md`.
Ruling: retain existing queued-message receipts rather than adding new caller-selected local IDs; the reverse broker and existing effect journal prevent automatic write replay.
Ruling: full App sync/provider/browser acceptance and production activation remain explicitly unverified; source implementation is not a deployment.
