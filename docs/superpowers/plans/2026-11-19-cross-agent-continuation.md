# Cross-agent continuation: new linked sessions

Approved direction: retain the original session and create a new Claude/Codex session in the same directory, carrying native conversation history. No in-place runtime switching. Base d5bd86ab.

Approaches: same-chat switching needs worker handover and segment-aware display; text excerpts are simpler but lose tools/images. Selected: new linked native sessions with a bounded, explicit conversion contract.

1. Add provider-neutral conversation readers, image materialization, and native importers. Claude reads its main parent chain; Codex uses account-scoped app-server thread/read (including pagination handled by the client). Shell history maps to paired tool calls; unsupported tools become text; private reasoning/system context excluded; limit failures explicit.
2. Add an idempotent machine operation resolving source identity from daemon/server metadata, refusing application-bound or running sources, exporting before spawning, and preserving origin. Prepare Codex imports inside its selected account home using a complete native legacy rollout; Claude uses a new native JSONL. No model work during import.
3. Add a quick action for the opposite agent only when source/native metadata and machine capability support it. Keep request identity across ambiguous retries; show errors; navigate on success. Source link uses existing parentSessionId UI.
4. Run conversion, RPC, account isolation, retry, menu and relevant existing tests plus typechecks. Independent review fixes precede final delivery. Browser actions must use Ego. Screenshot collection follows repository opt-in rules; no new deployment origin. Preview OTA requires the corresponding release/Android OPS and a functional compatible CLI.

Cases: C1 Claude→Codex, C2 Codex→Claude, C3 source unchanged and linked directory, C4 failures/retries create no duplicates, C5 unsupported/running/offline/older daemon gated, C6 images/tools/compressed history preserve available context or fail explicitly.

Status: local implementation and automatic checks complete. Native format roundtrip and independent review passed. See docs/validation/2026-11-19-cross-agent-continuation.md. Real model continuation, device acceptance and online release were not performed; user declined screenshots for this task.
