## Summary

<!-- What changed and why? -->

## Visual evidence

Visible UI cases: 0

<!--
For every user-visible PC Web/UI change, set the count above and add one row per Case.
Embed images directly. Two images or one clearly labelled before/after composite are both valid.
Use immutable commit-SHA URLs or GitHub uploaded attachments; branch URLs may break after merge.
An overview/contact sheet is optional and does not replace the per-Case rows.
For a non-visual PR, keep the count at 0 and explain why below the table.
-->

| Case | Problem | Before | After |
| --- | --- | --- | --- |
| N/A | Non-visual change | N/A | N/A |

Visual evidence waiver: not requested

<!--
Maintainer-only exception. If approved for this exact PR, replace the line above with:
Visual evidence waiver: approved
- Confirmed by: @maintainer
- Scope: Case IDs covered by the waiver
- PR: #N
- Confirmed on: YYYY-MM-DD
- Approved head SHA: full 40-character commit SHA
- Confirmation URL: GitHub PR comment or review URL
- Visual validation not performed: exact omitted checks and accepted risk

Keep the real Visible UI cases count and Case rows. Write "Waived by maintainer" in missing
image cells; do not count waiver text as screenshot evidence and do not check the two screenshot
completion boxes below.
-->

## E2E acceptance

<!--
When E2E or mobile video acceptance is requested, add one row per Case.
The video link must be accessible from the review device; a local absolute path is not evidence.
State mobile playback as confirmed only after the reviewer can open the same file on mobile.
Video supplements, but does not replace, the per-Case visual evidence above.
-->

| Case | Result | Spec / rerun | Mobile video | Report / Trace |
| --- | --- | --- | --- | --- |
| N/A | Not requested | N/A | N/A | N/A |

- Environment and side effects: N/A
- Mobile playback: not requested
- Known gaps: none

## Validation

<!-- Tests, typecheck, E2E, independent review, and known gaps. -->

- [ ] The declared visible Case count equals the number of unique before/after screenshot groups embedded above.
- [ ] Every visual Case uses comparable viewport/DPR/scale evidence and a stable image URL.
- [ ] Requested E2E videos use a non-local stable URL, map to a Case, and disclose mobile playback status.
- [ ] An independent reviewer checked the rendered PR body, not only local files or a chat report.
- [ ] Independent code review passed.
- [ ] Relevant automated tests passed.
- [ ] Typecheck passed, or the PR explains why it is not applicable.
- [ ] Every CI check triggered for the current head passed.
- [ ] The exact merge message was shown to and approved by the maintainer.
- [ ] The merge does not bypass branch protection.
