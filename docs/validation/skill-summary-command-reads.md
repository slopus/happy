# Skill reads in the Worked summary

The first fix recognized Claude `Read(SKILL.md)` but missed the user's actual
Worked summary: terminal reads remained ordinary Bash/CodexBash records.
Mixed diagnostic/read commands and POSIX paths with escaped spaces both
prevented whole-command Skill classification.

The client now adds command-read activity to the existing summary while keeping
the terminal tool, details, permissions and strict whole-command classifier.
The status describes the containing command, never an invented per-file outcome.
Skill failure diagnostics remain attached to actual Skill calls; terminal
diagnostics stay on the original tool.

| Case | Required result | Regression |
| --- | --- | --- |
| C1 | A collapsed Worked group shows release-ops, confirmation-ops, happy-visual-workflow, dev and android-ops from the retained terminal commands, alongside native Ego and subagents. | `ToolGroupView.skillCommandReads.test.tsx` uses the real group and activity strip; old model fails, fixed model passes. |
| C2 | Standalone command activity preserves the original terminal and its navigation/permission/error data. | `MessageView.skillCommandReads.test.tsx` |
| C3 | Shell quoting and escaped spaces work; mentions, searches, writes, control flow, aliases, substitutions, heredocs, redirection and unexpanded glob paths do not invent Skill reads. | `skillCommandReads.test.ts`, `skillCommandReads.controlFlow.test.ts` |
| C4 | Native Skill, document reads, ownership and browser evidence retain their existing behavior. | Full App regression suite |

## Verification

- Initial regression: 14 expected assertion failures, without import errors.
- Independent adversarial review found 13 additional cases; each failed before
  the conservative control-flow/path guards were added.
- Full App suite: 588 files, 5395 tests passed.
- Independent review: passed, including 55 directly relevant checks.
- Final typecheck and whitespace checks run before the PR.

## Production acceptance

Return to the exact reported historical Worked group at the formal Web origin.
With the group collapsed, verify all five named Skills are visible in its
activity summary, native Ego and both subagents remain, and original terminal
details still open. Capture the same desktop viewport and theme before/after.
Screenshots containing private conversation text are delivered privately in
Happy Skills rather than attached to the public PR.

Complex shell structures remain ordinary terminal records when their reader
execution cannot be established conservatively. No commands or historical
messages are rewritten or executed for this compatibility fix.
