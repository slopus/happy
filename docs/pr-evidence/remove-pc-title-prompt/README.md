# Remove duplicated PC title prompt

- Visible UI cases: `1`
- Viewport: supplied PC capture, `1496×212`, light theme
- Before source: user-provided issue screenshot
- After source: same capture with only the targeted prompt bubble removed as a
  static visual projection; no E2E or app runtime was used, per request

| Case ID | Problem | Before | After |
| --- | --- | --- | --- |
| PC-TITLE-PROMPT-01 | The first user prompt repeats the fallback session title as a dark bubble directly below the PC header. | [before.png](before.png) | [after.png](after.png) |

The implementation is additionally covered by a focused unit test proving that
only the oldest visible prompt whose derived fallback title matches the current
session title is filtered. Later prompts, renamed titles, and non-Web platforms
remain unchanged.
