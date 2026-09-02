# Fork large-history replay evidence

Case: `FORK-HISTORY-01`

Both PNGs come from the same isolated Web E2E case, current PR head, 1280x720
viewport, DPR 1, dark theme, and post-navigation checkpoint. `before`
deterministically applies the legacy newest-first 50-envelope outbox order;
`after` exercises the built CLI's `ApiSessionClient` chronological history
replay against the isolated PGlite Server.

The case uses 334 turns (668 encrypted session envelopes) and verifies:

- click-to-route stays below the 15-second regression ceiling;
- the latest agent turn is visible after navigation;
- the decrypted REST transcript contains the exact 668 expected envelope IDs
  in chronological order, with contiguous seq values from 1 through 668;
- a concurrently duplicated first upload batch is acknowledged idempotently;
- backward UI pagination reaches the earliest history page (`before_seq <= 101`).

Targeted CLI tests additionally interrupt the first replay, reconnect with the
durable `codexHistoryReplay` marker, verify stable envelope IDs are reused, and
confirm the final cursor is written only after the complete retry succeeds.

Observed click-to-route timings:

- legacy-order baseline: 6377 ms;
- real-CLI ordinary run: 5651 ms;
- real-CLI recording run: 5614 ms.

Artifacts:

- `case-1-before.png`: legacy-order baseline, 1280x720, DPR 1;
- `case-1-after.png`: chronological real-CLI replay, 1280x720, DPR 1;
- `fork-large-history-acceptance.mp4`: H.264/yuv420p, 1280x720,
  25 fps, 143.40 seconds, faststart.

The test environment used isolated local Server/Web/session data and was fully
stopped and removed after each run. Mobile playback was not requested.
