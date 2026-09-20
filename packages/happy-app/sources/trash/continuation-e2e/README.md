# Continuation regression (Ego)

Use the user's authorized logged-in Ego task space; never export credentials or private conversation screenshots to this repository. Run the branch's normal Expo Web client against the existing Paws server and use dedicated synthetic test sessions.

Cases:

- **CONT-HISTORY-MISSING**: Open a successor whose parent snapshot returns 404. The short transcript immediately shows a readable unavailable-history message, no retry button, and no claim that the entire previous history is present. The successor remains readable and usable.
- **CONT-HANDOFF**: Create a Codex session with a synthetic project name and next task. Finish/stop its worker, choose Continue in a new session, then send only “Continue; report the project and next task.” The model must name both. The saved handoff must be in the actual encrypted outgoing prompt, while the chat bubble displays only the typed text.
- **CONT-PARENT-DELETE**: After saving a successor, delete only the dedicated synthetic source. Reload the successor before its first prompt. The model must still receive the handoff and the history status must explain the missing source.
- **CONT-RELOAD**: Reload after delivery, send a second prompt, and verify the historical excerpt is not reinserted. Concurrent sends and tool-heavy latest pages are covered by focused composition tests.

Run unit coverage:

```sh
pnpm exec vitest run sources/sync/sessionContinuation.test.ts sources/sync/sessionContinuation.integration.test.ts sources/sync/continuationContext.test.ts sources/sync/sync.sessionWriters.test.ts sources/hooks/useContinuationHistory.test.tsx sources/components/ConversationTranscript.pagination.test.tsx sources/components/continuationTranscript.test.ts
pnpm typecheck
```

Record only passing synthetic paths as H.264 MP4. Report verified key frames with the session-bound Happy helper. Stop all test workers and remove local preview credentials at completion; do not touch original conversations or other workers.

## Verified result — 2026-09-20

All four cases passed in the normal Expo Web client using Ego and a real Codex worker. Two dedicated synthetic sessions were created. The source was deleted after the successor saved its context; a full reload occurred before the first successor prompt. The model correctly returned `ORCHID-7392: fix empty-line handling in the CSV parser` without those facts in the new prompt. After another reload it returned the same task.

An authenticated, in-memory decryption of server messages confirmed that the first user message contained the historical excerpt and `continuationContextSourceId`; the second user message contained neither. No credentials or original conversations are included in these artifacts.

- Focused regression suite: **176 tests passed** in 7 files; typecheck passed.
- Android OTA runtime contract: **6 tests passed**.
- Independent code review: passed after reserving the latest user request within the excerpt budget.
- Independent 1440×900 PC screenshot review: passed for normal continuation and missing-parent short transcript; no overlap or ineffective retry action.
- [Recorded CONT-RELOAD replay](continuation-reload-e2e.mp4): H.264, yuv420p, 1440×780, 30 fps. The clip starts after reload and shows the follow-up and correct response; the initial source creation/deletion is covered by live E2E and session-bound screenshots, not this clip. Full decode and sampled visual checks passed; delivered to Happy. Mobile-device playback has not been independently confirmed.
- Setup limitation: the existing Archive fallback returned HTTP 415; only the dedicated source worker was stopped and the source archived with the authenticated API before using the real continuation UI. This unrelated fallback is outside this change.
- Existing continuations created before this fix have no saved excerpt. A deleted original conversation is not recoverable through this fix.
