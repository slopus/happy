# Public share UI evidence

All screenshots were captured from the real Happy PC Web composition with the
same 1440 x 900 CSS viewport, browser scale, and DPR. The checked-in images are
case-specific crops produced from those full-viewport captures without
rescaling. The fixture data is synthetic and contains no private session data.

| Case | Before | After | Observable proof |
| --- | --- | --- | --- |
| `SHARE-UI-001` | `share-ui-001-header-before.png` | `share-ui-001-header-after.png` | Neutral document icon, stronger title hierarchy, and clock metadata replace the orange paw header. |
| `SHARE-UI-002` | `share-ui-002-copy-before.png` | `share-ui-002-copy-after.png` | Keyboard-focused copy control changes to a check icon and `Copied`, then resets in the recorded flow. |
| `SHARE-UI-003` | `share-ui-003-icons-before.png` | `share-ui-003-icons-after.png` | Work summary, chevron, jump, and scroll controls render real vector glyphs. |
| `SHARE-UI-004` | `share-ui-004-public-readonly-before.png` | `share-ui-004-public-readonly-after.png` | Anonymous public transcript remains a focused, read-only document without owner navigation or editing controls. |

`public-share-e2e-after.mp4` records the successful owner share flow,
anonymous viewer, and keyboard copy feedback. It ends on the observable
`Public snapshot active` owner state. Revocation is asserted by the automated
E2E but intentionally excluded from this positive-path recording.
