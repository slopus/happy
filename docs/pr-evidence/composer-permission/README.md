# Composer permission selector evidence

All screenshots use the same Playwright fixture, Chromium viewport `1280x900`, DPR `1`, locale `en`, and light theme. Before images were captured from the `origin/main` baseline; after images were captured by the aggregate permission/model/effort regression on this branch. Crops preserve native scale and matching source coordinates within each pair.

| Case | Before | After | Expected change |
| --- | --- | --- | --- |
| 1 | `case-1-before.png` | `case-1-after.png` | Composer exposes the two permission modes with honest descriptions. |
| 2 | `case-2-before.png` | `case-2-after.png` | First Full access selection opens the session-scoped risk confirmation. |
| 3 | `case-3-before.png` | `case-3-after.png` | Confirmed Full access appears in the composer while historical messages keep their original permission metadata. |
| 4 | `case-4-before.png` | `case-4-after.png` | Reopening the selector shows Full access selected without repeating the confirmation in the same session. |
