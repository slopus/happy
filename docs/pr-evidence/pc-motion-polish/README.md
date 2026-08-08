# PC/Web motion polish acceptance evidence

Visible UI cases: 3

Each composite uses the same authenticated two-file fixture, DPR `1`, and browser zoom `100%`.
The top row is the `1280 × 720` viewport and the bottom row is the `1920 × 1080` viewport.
Within each row, the left half is the baseline and the right half is the final implementation.

| Case | Problem | Evidence |
| --- | --- | --- |
| `PC-MOTION-06` | Capability Hub ↔ Files used a hard content cut. | [Right-panel tab comparison](pc-motion-06-before-after.png) |
| `PC-MOTION-07` | Changes ↔ All Files replaced the file surface abruptly. | [File-mode tab comparison](pc-motion-07-before-after.png) |
| `PC-MOTION-08` | Chat ↔ Diff ↔ File lacked push/back/forward continuity and could remount Chat. | [Workspace history comparison](pc-motion-08-before-after.png) |

The final recorded E2E also covers rapid reversal, runtime reduced motion, outgoing-layer focus isolation,
and Chat DOM identity. The final candidate had zero all-transparent rapid samples, zero reduced-motion
violations, and zero unexpected runtime errors.
