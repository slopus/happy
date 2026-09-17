# Incremental group context acceptance — 2026-09-18

- Original regression reproduced: second debate turn re-included the member's
  own answer and prior scheduling prompts. The regression now passes using the
  real Party store and a test-only remote SDK boundary.
- Service tests cover separate member positions, concurrent arrivals, failed and
  stopped turns, persisted restart, replacement sessions, explicit oversize
  rejection and the existing current-task attachment scope.
- Real SDK acceptance used the dedicated Linux test account/executor, two fresh
  Codex sessions, `gpt-5.6-luna` / `low`, and two rounds (four public replies).
  Each member's first durable user message contained a unique background marker;
  neither member's second message repeated it or the opening instruction.
  All four replies had session/localId/root-turn/turn-end/public-message provenance.
- Only those two completed test workers were terminated after verifying all their
  user turns belonged to this test. Full histories were retained; the local test
  server closed. No user production sessions were changed.
- Native Codex compaction was not forced or separately tested here. This change
  removes duplicate group-text injection, not the underlying model context limit.
- Existing rooms bootstrap once if they lack a delivery checkpoint. Failures can
  cause conservative redelivery; no exactly-once claim. Historical image pixels
  are not replayed, matching the previous current-task attachment contract.
- Independent read-only review found an attachment aggregation regression; it was
  removed and regression-tested. No remaining Critical/Important findings.
