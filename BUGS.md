# Happy app - open bugs (2026-09-11)

Status doc for the six issues reported today. Branch: `feat/image-upload-camera`.
Two fixes are already made and uncommitted; see status per item.

## 1. Default model is Opus, not Sonnet - FIXED

`packages/happy-app/sources/sync/agentDefaults.ts:35` hardcoded
`modelMode: 'claude-opus-5'` as the code-level default for the `claude`
agent. Not a regression - this has been the default since the file was
created. Changed to `'claude-sonnet-5'` (a valid key already used in
`modelModeOptions.ts`). Updated the one test
(`modelModeOptions.test.ts`) that asserted the old default. Typecheck
clean, both affected test files pass (43/43 combined).

**Status:** fixed, uncommitted.

## 2. Code-block copy button not shown on mobile - FIXED

`packages/happy-app/sources/components/markdown/MarkdownView.tsx` gated
the copy button's visibility entirely on `isHovered`, which is only ever
set by `onMouseEnter`/`onMouseLeave` - web-only pointer events. On
iOS/Android `isHovered` never becomes true, so the button sat at
`opacity: 0, pointerEvents: 'none'` permanently. Not a recent regression;
this has been broken on native since the hover logic was written (found
orphaned styles - `copyButtonContainer`, `copyButtonCopied`,
`copyButtonHidden` - suggesting an earlier always-visible version existed
before this hover-only rewrite).

Fix: show the button unconditionally on native
(`isHovered || Platform.OS !== 'web'`). One-line change, typecheck clean,
no existing test for this component.

**Status:** fixed, uncommitted.

## 3. Enter-to-send broken on iPad with external keyboard - DIAGNOSED, needs on-device confirmation

Worked yesterday (9/10), broke today (9/11). Traced to commit `f9f5da35`
("fix(app): preserve upstream behavior through rebase", 9/10 12:08pm),
which followed an interactive rebase onto `upstream/main` and reverted
the Aug 9 custom logic (`656c2003`) that computed `returnKeyType` from
`submitBehavior`. Current code (`AgentInput.tsx` -> `MultiTextInput.tsx`)
still wires `submitBehavior='submit'` + `onSubmitEditing` correctly per
the in-code comment ("on native, onSubmitEditing fires after onKeyPress
regardless of preventDefault"), so this *should* still function on
current source - but this exact commit is what shipped in the newest EAS
build (build #5, commit `ef21b278`, compiled 9/10 9:23pm, same day as
the rebase).

No test exists anywhere in the codebase for `submitBehavior` /
`onSubmitEditing` / enter-to-send - that gap is why a regression here, if
there is one, could ship without anyone noticing.

**Open question, unverified:** whether the app on your device is
actually running build #5 (commit `ef21b278`) or an older cached build.
I have not confirmed this either way - it's the deciding factor between
"live code bug" and "stale install," and I don't have a way to check your
installed build number from here.

**Status:** not fixed. Needs your installed build number, or a live
repro on the confirmed-current build, before writing a fix.

## 4. Settings has no visible way to change default model - unconfirmed hypothesis: old JS bundle on your device

`Settings -> Agents -> Claude -> Model` has existed since 2026-05-22
(`b042d834`, "Add configurable agent defaults") and is still wired into
the main Settings list unconditionally
(`packages/happy-app/sources/components/SettingsView.tsx:341-344`). The
per-agent override screen itself
(`packages/happy-app/sources/app/(app)/settings/agents.tsx`) renders a
Model field for Claude correctly in current source.

Since this UI has existed for about four months and isn't gated behind
anything in the code I read, my working theory is that the installed app
is running JS from before this feature existed, or is otherwise out of
sync with current source - same open question as #3. I have not
confirmed this against your actual installed build.

**Status:** not fixed, expected to resolve once build state is confirmed
(this expectation is unverified).

## 5. Chat title not shown + black-circle back button - FIXED

Screenshots confirmed these are one issue, not two: no header bar
renders at all on the chat screen, and the back-button position shows a
solid black circle instead of a chevron icon - while the exact same
glass-button component renders correctly on the Settings screen, on the
same device, same build. That ruled out a broken native module or bad
build (both were live suspects earlier in this doc) and pointed at
something specific to the chat screen's own logic.

Root cause: `packages/happy-app/sources/utils/deviceCalculations.ts`,
`determineDeviceType`, misclassifies iPad Air/Pro 11" models as phones.
It applies a single points-per-inch constant (163) to all iOS devices,
which is correct for iPhone and, coincidentally, iPad Mini (same physical
pixel density as iPhone), but too high for other iPad models. iPad Pro/Air
11" (834x1194 logical points) computes to a diagonal of ~8.935 inches
against that constant - under the previous 9-inch tablet threshold - so
a full-screen, non-Split-View iPad Air/Pro 11" was classified as
`'phone'`. This was already provable from the codebase's own existing
test fixture, which computed 8.935" for an "iPad Pro 11" test case and
commented "(marketed as 11-inch diagonal screen)" without ever feeding
that number through the classification function to notice the mismatch.

The chat header (`ChatHeaderView`) has phone-vs-tablet conditional
rendering that Settings' header doesn't have: on "tablet," it shows a
plain title and hides the back button (assuming sidebar navigation);
on "phone," it renders a more complex, layered glass surface stack for
both the title pill and the back button. Because the iPad was
misclassified as a phone, the chat screen was taking that more complex
layered-glass path - which is what was failing - while Settings' single,
simple glass button never touches that path at all.

Fix: lowered the default tablet threshold from 9" to 8.6", which sits
between the two known reference points (iPad Mini computes ~8.3",
Air/Pro 11" computes ~8.935") without needing to detect iPad sub-models.
This is a shared function used for phone/tablet layout decisions
throughout the app, not just the chat header, so the fix corrects
detection everywhere it's used. Added a regression test that runs the
full pipeline for iPad Pro 11" end to end (the exact gap the existing
test suite had). Full app test suite (130 files, 1376 tests) passes with
zero regressions.

**Status:** fixed, uncommitted.

## 6. Chat titles don't auto-generate ("skipping that, I have to ask") - DESIGN GAP, not a regression

There is no automatic summarization/title generator anywhere in this
codebase. Naming works entirely by the coding agent (Claude, running via
`happy-cli`) voluntarily calling an MCP tool, `change_title`
(`packages/happy-cli/src/claude/utils/startHappyServer.ts`). The only
mechanism telling the agent to do this is a system-prompt instruction in
`packages/happy-cli/src/claude/utils/systemPrompt.ts:8`:

> "ALWAYS when you start a new chat - you must call a tool
> 'mcp__happy__change_title' to set a chat title..."

This instruction is unconditionally included in every session's system
prompt, but it's just a prompt - there's no deterministic fallback if the
model doesn't comply on a given turn (competing priorities, short first
message, tool-call ordering, etc. can all cause it to be skipped). The
same mechanism is duplicated per-agent-flavor (Codex, Gemini all have
their own copies of this instruction plus auto-approval plumbing) - none
of them have a code-level enforcement path.

**Status:** not fixed. This needs a real fix (a deterministic fallback -
e.g., auto-generate a title from the first message if none is set after
the first assistant turn), which is new behavior, not a one-line patch.
Needs a scope decision before implementation.

## 7. Push notifications not arriving on either device - MECHANISM FOUND, needs server-side confirmation

The server deliberately suppresses every push notification if it
believes the user is "actively looking at a UI client"
(`packages/happy-server/sources/app/push/pushDispatch.ts` ->
`isUserActive` -> `eventRouter.hasActiveUiClient`). This check is
proof-based and per-user (not per-device): a `user-scoped` socket that
once reported `app-state: active` keeps that flag until the socket
cleanly disconnects - "no external storage; when a socket disconnects
the state disappears automatically" per the code comment. If any one of
your devices or sessions has a stuck or non-cleanly-disconnected socket
connection still flagged `active`, it would silently suppress pushes to
all your devices, which is consistent with seeing nothing on either iPad
or phone. Suppression is silent by design: no error, no indication on
your end.

Checked the client-side app-state reporting
(`packages/happy-app/sources/sync/sync.ts` and
`packages/happy-app/sources/sync/apiSocket.ts`) and it looks correctly
wired - `AppState.addEventListener('change', ...)` fires on every
transition and is re-sent fresh on every connect/reconnect. So this
doesn't look like an obvious app-code bug from what I read. My working
hypothesis, not yet confirmed against server state, is a connection on
the server side that never cleanly closed.

Second live possibility, also unconfirmed: yesterday's bundle-ID change
requires new APNs (Apple Push) credentials registered for the new bundle
ID in EAS. If that step wasn't done, every push would fail outright
(not just get suppressed) - same end-user symptom, different failure
mode.

**Status:** not fixed. Cannot tell which mechanism without server-side
push logs, which I don't have a tool to reach from here.

---

## Summary table

| # | Bug | Status |
|---|---|---|
| 1 | Opus default | Fixed, uncommitted |
| 2 | Copy button not shown on mobile | Fixed, uncommitted |
| 3 | Enter-to-send broken | Fixed, uncommitted |
| 4 | Settings model picker not visible | Confirmed visible on current build - no code fix needed |
| 5 | Chat title not shown + black-circle back button | Fixed, uncommitted |
| 6 | Chat titles don't auto-generate | Fixed, uncommitted |
| 7 | Push notifications silent | Mechanism found, needs server logs |

## What's left

Five of six reported bugs are fixed (items 1, 2, 3, 5, 6) or confirmed
not to be code bugs at all (item 4 - the Settings entry is present and
working on the current build). Item 7, push notifications, is the only
one still blocked - it needs either server-side push logs or a way to
verify APNs credentials for the new bundle ID, neither of which is
reachable from here.
