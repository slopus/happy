# Antigravity independent reasoning effort

## Behavior

Paws consumes agy's categorized `thought_level` configuration. Active-session model/effort selection is acknowledged through `setAcpConfig`; the model is set first and its returned configuration determines the effort range. Selections are persisted only after acknowledgment. Both pickers share a per-session pending state, and the real message writer refuses submission during configuration changes. Navigation does not discard an acknowledgment for the original valid worker/account.

New-session selection uses observed per-model configuration snapshots. For other models, agy's actually advertised legacy `base-effort` variant IDs seed supported ranges; no variants are invented. Missing capability information leaves effort unspecified, following agy. Current configuration snapshots remain authoritative. At prompt time the executor applies model, validates effort against the updated selector, applies it, and verifies acknowledgment before prompting. Configuration errors fail the turn visibly without silently using another effort or killing the connection.

The existing pickers, layout and theme tokens are reused on Web and mobile. No native dependency, package, icon or runtime changes. Existing workers need a new CLI process to gain the new RPC.

## Validation

- App full suite: 573 files, 5,090 tests passed.
- CLI full unit suite: 200 files, 1,928 passed, 2 skipped. Run with inherited `HAPPY_CODEX_ACCOUNT_PROFILE_ID` removed from the test subprocess only and two workers. The initial inherited-account run caused shared-connection configuration assertions and parallel subprocess timeouts; isolated reruns passed. User configuration was not changed.
- App and CLI TypeScript checks passed.
- Regression coverage includes per-model ranges, stale effort normalization, outbound message metadata, ACP model-before-effort ordering, invalid effort rejection, shared header/composer pending state, send boundary protection, navigation acknowledgment persistence and account-change rejection.
- Independent code review: two reported races fixed and re-reviewed; no remaining critical/important findings.
- Real local agy 1.5.13 through production `AcpBackend`: Neon xhigh acknowledged; switching to Argon returned low/medium/high with current high; setting low acknowledged; returning to Neon restored four available levels and retained low. No prompt was submitted in this protocol probe.
- Android runtime contract test passed. Native device loading and full browser interaction were not performed in this local validation.
- Screenshots/video not requested or captured.

## Delivery

PR, CI, Web/OTA publication and execution-runtime activation evidence are recorded separately after completion. A protocol probe and tests do not by themselves establish online availability.
