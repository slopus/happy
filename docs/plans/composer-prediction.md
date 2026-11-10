# Codex composer predictions

The conversation composer can offer a short prediction of the user's next
message after a successful Codex turn. It is an optional candidate, never an
implicit user message or authorization. Only accepting it writes a normal,
editable draft; sending remains a separate user action.

## Interaction

- Request once per completed source turn while the conversation is focused,
  foregrounded, connected, at the latest messages, and has no draft, attachments,
  selected context, staged messages, or outgoing messages. Sampling overlaps final
  history synchronization; display waits until that synchronization is ready.
- Render only subdued ghost text using the current theme's input placeholder
  token and the same typography as the input. There is no toolbar, visible Tab
  prompt or close button. Tab accepts on Web; tapping the text accepts on native.
  Shift+Tab retains focus navigation, Enter does not accept, and Escape dismisses.
- Normal autocomplete retains keyboard priority. Existing nonempty-input queue
  shortcuts keep their behavior. IME composition and paste invalidate first.
- Typing and accepted drafts hide the candidate while retaining a completed
  same-context cache. Deleting all text restores that cache immediately with no
  RPC or model request. Explicit dismissal, attachments, backgrounding, changed
  session/model/permissions/directory or the next root turn discard it. Pending
  sampling is still cancelled at input/IME/paste start and cannot revive late.
  Results are checked against the source, context key and synchronous input
  generation before display, including a type-then-delete race.
- Predictions are not saved to the draft, transcript, or message queue. Empty,
  tool-only, unsupported, malformed, cancelled and failed samples are silent.

## Transport and lifecycle

`composerPrediction` and `composerPredictionCancel` use the existing encrypted
session RPC. The client submits only a request ID and source turn ID; the CLI
binds the actual Codex thread and fixes the prediction prompt. Application-bound
sessions do not advertise this capability. Older Happy workers do not advertise
it either. An app-server reporting method-not-found disables the capability for
that worker after the actual request, without a paid capability probe.

The coordinator deduplicates requests for a source across device subscribers and
keeps a single in-memory result. One device's cancellation does not cancel a
sample another device still awaits. The last subscriber cancels the exact Codex
JSON-RPC request; a cancellation received before its request is also remembered.
Cancellation or failure does not automatically retry the same source.

The native experimental `thread/sample` inherits the parent's model, provider,
configuration and history on a temporary fork. It intercepts model output before
Core executes tools and returns null for tool calls. It also owns fork cleanup.
Do not replace it with ordinary `thread/fork` + `turn/start`, or with the separate
`thread/prediction/request` method: the latter is unimplemented in the audited
upstream commit.

MCP startup/discovery is disabled for the auxiliary sample where upstream supports
that optimization (Responses Lite with inherited incremental tool definitions);
other model paths retain upstream behavior. The sample still inherits context
and cannot execute tools.

Low effort is requested as a hint: upstream applies it only for supported
models/providers. There is no separate model parameter on this API. Auxiliary
inference consumes model usage and can benefit from inherited prompt caching;
cache hits, low effort and low latency are not guaranteed.

The CLI uses a single 20-second deadline, below upstream's 30-second limit. The
outer encrypted RPC budget is 25 seconds. A deadline or abort sends
`thread/sample/cancel`; inference is not polled or automatically retried. Root
mutations and start/settings notifications invalidate and cancel auxiliary work
without waiting for it or interrupting the root turn.

## Verification and reruns

From the CLI package:

```sh
env -u HAPPY_CODEX_ACCOUNT_PROFILE_ID pnpm exec vitest run --project unit \
  src/codex/composerPrediction.test.ts \
  src/codex/codexAppServerClient.test.ts \
  src/codex/codexAppServerSharedConnection.test.ts
```

The new suite drives a local JSON-RPC WebSocket server and verifies sharing,
source invalidation, exact cancellation, unsupported workers, null samples and
deadlines. It does not reproduce the model's tool barrier; that behavior is
owned by upstream's audited response interceptor.

From the app package:

```sh
pnpm exec vitest run sources/hooks/useComposerPrediction.test.tsx \
  sources/components/MessageComposer.paste.test.tsx \
  sources/components/MultiTextInput.web.test.tsx \
  sources/-session/SessionView.hydration.test.tsx \
  sources/-session/SessionView.agentSpace.test.tsx sources/themePacks.test.ts
pnpm typecheck
```

An opt-in real-model smoke is available from the CLI package:

```sh
pnpm exec tsx scripts/smoke-composer-prediction.ts
```

This consumes one root model response and one sample using current Codex
authentication, creates a dedicated native thread, and verifies unchanged root
history and exactly one root start. It does not write a Happy session or alter
the installed CLI/daemon. The native test thread remains in Codex history.

2026-11-10 real smoke: installed Codex 0.166.0, parent model gpt-6.1-sol,
prediction `Yes, make it warmer.`, sample round-trip approximately 11.9 seconds,
unchanged root history, one root start. An initial 5-second deadline expired,
which led to the current 20-second budget. This is one measured request, not a
latency benchmark. Browser screenshots and native-device interaction are not
claimed by this smoke.

Audited upstream: openai/codex commit
`b32ada5320b043bde03a10edab6b88fc126812b4`,
`codex-rs/app-server/src/thread_sample.rs` and
`codex-rs/app-server/tests/suite/v2/thread_sample.rs`.

2026-11-11 refinement: a single sequential same-source comparison on gpt-6.1-sol
returned `改得更温暖一点。` for both samples, 9454 ms with MCP initialization
and 7632 ms with `disableMcp: true`. Input tokens were 40129 vs 35871 (24832
cached for both); output tokens were 11 for both. Root history was unchanged
with one root start. This is one measurement with order/cache/network effects,
not a latency benchmark or a claim of instant first prediction. The immediate
delete-to-restore path uses the already completed UI cache and does no inference.
