# PC List drag-and-drop visual evidence

Visible UI cases: 2. All screenshots were captured by the isolated Chromium
Web E2E at `1440×900`, DPR `1`, English locale, and the dark Gingham theme.

- `SIDEBAR-SESSION-DROP-01`: the after frame captures the Advisor drop target
  while a real mouse drag is active. The Case then moves the session to Advisor
  and Unassigned while preserving its Tags and the active conversation route.
- `SIDEBAR-LIST-REORDER-02`: the after frame captures the Advisor target while a
  List drag is active. The Case exercises both target halves and confirms the
  resulting before/after order remains after reload.

Both drag paths move outside the active target and back before dropping. The
target must return to its resting theme surface on leave and highlight again on
re-entry, protecting against stale drop feedback.

The same `[SIDEBAR-LISTS-TAGS]` Case passed in ordinary and evidence modes. Its
stable 25fps H.264/yuv420p acceptance video passed `ffprobe`, full decode, and
full-duration contact-sheet review.
