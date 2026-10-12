# Question card browser acceptance

Start `node e2e/fixtures/question-card/serve.mjs` from `packages/happy-app`.
The fixture imports the actual MarkdownView, RN Web, theme tokens, typography,
Markdown parser and icon glyph/font assets. It replaces unrelated native features
and the outgoing message boundary with an isolated HTTP `/reply` endpoint.
No account, production session, machine, or model is accessed.

Only Ego may operate this fixture. Create one task space, record its numeric ID
and `p1` target ID, then import `verify.ego.mjs` in an `ego-browser nodejs` round:

```js
const { verifyQuestionCard } = await import('file:///ABSOLUTE_WORKTREE/packages/happy-app/e2e/fixtures/question-card/verify.ego.mjs');
await verifyQuestionCard(
  { taskSpace, cdp, pageInfo, currentTab, listTaskSpaces, useOrCreateTaskSpace },
  {
    taskSpaceId: RECORDED_SPACE_ID,
    targetId: 'RECORDED_P1_TARGET_ID',
    sessionId: 'CURRENT_HAPPY_CAPTURE_SESSION_ID',
    runId: 'ONE_UNIQUE_RUN_ID_FOR_THIS_TASK',
    skillName: 'ego-browser',
    captureHelperUrl: 'file:///CURRENT_HAPPY_RUNTIME/packages/happy-cli/scripts/capture-browser-step.mjs',
  },
);
```

Report each returned verified evidence receipt through Happy exactly once.
Add `record: true` only after the normal run passes. Recording mode reruns the
same assertions and writes fresh JPEGs directly from CDP. These are verified
state frames, not continuous motion recording; assemble and label the resulting
MP4 as a state-by-state acceptance demonstration.

Cases: selection requires explicit send; exact option delivery; custom input
clears selection; failed delivery preserves the draft; retry trims input;
skip/close never send; 1440px dark, 390px dark and 320px light have no horizontal
overflow; narrow input content is not clipped and Send is fully visible.

`?theme=dark&revision=before` replays the base MarkdownView at `7c57bc20` with
the same text, assets, theme adapter and viewport for Before/After evidence.
Stop this fixture process and finish the recorded Ego task space after delivery.
This acceptance does not certify the full SessionView/CLI chain or native mobile
keyboard, screen reader, or installed OTA behavior.
