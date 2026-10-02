# Codex native message queue acceptance

Ordinary composer submissions (Enter or the send button) queue a later turn
while a task is running. This remains true after clicking a queue row's
“Send now” and during subsequent turns. Tab also queues; autocomplete consumes
Tab first. Only the explicit queue-row action steers the active native turn.
Slash commands remain queued between turns. Steering uses `turn/steer` with the
expected native turn ID and never falls back to abort plus a new turn. It uses
the running turn's model, effort and permission settings.

## Initial real Ego acceptance (2026-10-02, historical Enter-to-steer behavior)

The initial acceptance below predates the follow-up staging correction. Its
Enter-to-steer case is historical; the current interaction is defined above.

Environment: isolated account, local full Happy server and Expo Web, built Paws
CLI connected to Codex 0.159.3 with a real gpt-6.1-sol model. The prompts only
waited or returned markers; they did not modify project files. No production
account, server, deployment or daemon was used.

| Case | Acceptance criterion | Result |
| --- | --- | --- |
| Enter while working | Original tool completes and original answer includes guidance; native turn ID unchanged | Pass |
| Tab while working | Message remains queued until original turn completes, then starts its own turn | Pass |
| Queue “Send now” | Queue row becomes same-turn guidance; unrelated queued row stays queued | Pass |
| Delete | Removed row is never delivered | Pass |
| Reload | Remaining queue survives refresh and dispatches after original completion | Pass |
| Queued `/skills` | Command cannot steer; completes locally, then following message dispatches | Pass |
| Recover for editing | Text returns to composer, row leaves queue, edits can be queued again | Pass |

Native trace for the Enter case: turn `01a0fb7b-9f37-7c30-92cc-5aec05a7ac0b`
started, `turn/steer` was acknowledged, and that same turn completed with
`ORIGINAL_DONE` and `STEER_REPLY_DONE`. Only afterward did queued turn
`01a0fb7c-712e-70f3-8cb0-44360d5fa7fb` start and answer `QUEUED_REPLY_DONE`.

Verified key frames were delivered through Happy Skills browser progress using
one Ego task space and run ID. Local fixture under
`packages/happy-app/sources/trash/message-staging-queue` is a UI/state-machine
debugging aid, not evidence for this full integration test.

The Happy media card contains a **sampled key-state video**, assembled from
verified frames (24 seconds, H.264/yuv420p, 1920×1080 at 30 fps), not a continuous
recording. Full decoding and visual coverage checks passed. The attempted CDP
screencast lagged behind the final UI and is not used as acceptance evidence.

## Reproduce

1. Build CLI in an isolated worktree. Create an isolated environment with the
   repository's `environments/environments.ts` helpers; run its full server and
   Expo Web. Authenticate its test account without recording credentials.
2. Start the built CLI in that environment's test project with its isolated
   `HAPPY_HOME_DIR`, server URL and Web URL. Use `--started-by daemon` to avoid
   affecting the normal daemon. Use a real authenticated Codex account/model.
3. Open that session in one Ego task space. Ask Codex to execute a 35-second
   Python sleep and reply `ORIGINAL_DONE`. While working, Tab-queue a request
   for `QUEUED_REPLY_DONE`, then Enter-queue guidance to append
   `STEER_REPLY_DONE`. Click that guidance row's “Send now”. Verify the same
   native turn remains active and the unrelated queued message is still
   present. Enter-submit another follow-up and verify it stays queued, then
   wait for the answers in order.
4. Repeat with a longer wait. Queue two texts, a `/skills` command and a final
   marker request using the explicit queue button. Recover and edit a text,
   requeue it, then delete it. Click another row's “Send now”; refresh and
   verify the remaining command/marker queue persists and drains in order.
5. Capture verified key states with `captureVerifiedBrowserStep`, report them
   to Happy, and close the same Ego task space only after the final verified
   state. Stop only the isolated CLI/server/Expo processes.

The reusable Chinese-locale Ego script is
`scripts/verify-codex-native-queue.ego.mjs`. After step 2, pass the already
recorded `EGO_TASK_SPACE_ID`, `EGO_TARGET_ID`, `EGO_SESSION_URL`, `EGO_RUN_ID`,
`HAPPY_CAPTURE_SESSION_ID` and the helper's file URL as
`EGO_CAPTURE_HELPER_PATH`, then run
`ego-browser nodejs < scripts/verify-codex-native-queue.ego.mjs`.
It reads real synchronized turn state, verifies editing, deletion, Enter/Tab,
reload and queued `/skills` progression, and emits the final verified frame.
The caller reports that exact frame to Happy and finishes the same task space.

Older CLIs without the advertised `codexSteer` capability retain queueing;
native steering requires the updated CLI. Native Android rendering, image
steering through the browser, and multi-device queue synchronization were not
part of this Web acceptance. The queue is local to the signed-in client.

## Old CLI send-now regression (2026-10-02)

The queue-row action previously remained enabled without `codexSteer` or an
active turn ID. Clicking it marked a queued message as failed even though no
RPC was attempted, which then blocked automatic queue draining. The view and
dispatcher now share an availability check; unavailable guidance leaves the
message queued. Idle slash-command retries are also enabled.

Real Ego regression used the isolated `fresh-birch` account/server/Expo app,
an actual pre-feature CLI build (advertised version 1.3.16), and a freshly
built native-steering CLI (1.3.17 source). No production worker was restarted.

| Case | Observed result |
| --- | --- |
| Old CLI while running | Send now disabled; upgrade/new-session explanation visible; text remains queued |
| Old CLI after completion | Original and queued marker requests both received actual model replies; queue emptied |
| New CLI queue-row Send now | Guidance accepted in original turn `01a0fc92-fe15-7e30-aea5-3faf6929d2fc`; original tool and guided answer completed |
| Remaining queued text | Received model reply in separate turn `01a0fc93-b1d9-7280-b1b9-8909684eebf2` |
| Take back for edit | Restored exact queued text to the visible session input |

To repeat: start one old and one new real worker against an isolated environment.
For the old worker, request a 35-second sleep, then Enter-submit a second marker
request while busy. Verify the disabled queue-row action and wait for both
answers. For the new worker, Tab-queue a marker request and guidance, click the
guidance row's Send now, and verify the original native turn identity and both
final replies. Capture/report verified states using the existing Ego helper.

Previously failed or interrupted submissions remain manual retries because
acceptance can be ambiguous. This patch does not automatically resend them.
Old CLIs also lack the immediate-command completion lifecycle: queued `/skills`
and similar commands may hold later messages. Use an updated CLI for command
queues and native guidance. Publishing only the Web does not update workers;
existing sessions retain the runner that started them.

[Acceptance video](evidence/codex-queue-compatibility-20261002.mp4): real CDP interaction samples with verified old-CLI key states and the final native result appended. Not an uninterrupted recording.

## Repeated follow-up staging regression (2026-10-02)

Case `QUEUE-REPEAT` covers one continuous user path: after an explicit Send now,
ordinary follow-up submissions must keep appearing in the staging area.
The previous composer chose native steering whenever a running turn was
available. A first submission could queue during startup, while later Enter
submissions went directly into the active turn. The composer now consistently
queues ordinary submissions while busy; explicit queue-row Send now remains
the same-turn guidance action.

The real baseline reproduced the problem with the installed native-capable CLI:
after Send now, another Enter submission produced zero queued rows instead of
one. The corrected Web code revision is
`54394f89784f2366fbcfa2c8bda01756b6a50eef`. Acceptance used an isolated test
account and CLI home, the actual installed CLI, Codex 0.159.3 and a real
gpt-6.1-sol model at medium effort. Prompts only waited or returned markers.

| Boundary assertion | Ordinary real Ego result |
| --- | --- |
| First and second Send now | Original native turn identity preserved; only selected queue row removed |
| Consecutive Enter after first guidance | Two follow-ups remain visible in the queue |
| Send button while busy | Queue grows from two to three |
| Refresh after second guidance | Three remaining rows persist |
| Enter during the next native turn | Later follow-up remains queued without replacing that turn |
| Automatic delivery | Queue empties; all seven unique markers appear in actual replies |

Ordinary run: 139.6 seconds. Original turn
`01a0fce4-3bdc-7bb3-bbce-1c80ec8fdcd4`, second turn
`01a0fce5-3d5a-7371-b0ba-1d0c026494d8`, final turn
`01a0fce6-41a8-78c3-a525-728f758fe677`.
Three original/guidance markers share the original answer; seven markers do
not mean seven separate answers.

The same Case also passed in the recorded rerun (199.6 seconds),
with original turn `01a0fce7-c896-7822-afd8-e4ce6ec5a2c1`, second turn
`01a0fce9-9a16-75e1-a59a-20ea01fb9dbe` and final turn
`01a0fcea-53ac-72b1-9ee5-3841c3bdbf1c`.

[Before](evidence/repeated-message-staging-before-20261002.png) and
[after](evidence/repeated-message-staging-after-20261002.png) show the same
desktop viewport (2506×880), with separate isolated sessions and marker text.
[Second-turn state](evidence/repeated-message-staging-second-turn-20261002.png)
and [final state](evidence/repeated-message-staging-final-20261002.png) supplement
that single visible Case. Independent code and PC interaction reviews passed;
70 relevant automated tests and the app typecheck passed.

The reusable runner is `scripts/verify-repeated-message-staging.ego.mjs`.
It requires a freshly created isolated account/session and an already-owned
Ego task space. Supply the following configuration before the script body:

```js
globalThis.repeatedMessageStagingConfig = {
    EGO_ARTIFACT_DIR: "/absolute/test-artifacts",
    EGO_TASK_SPACE_ID: "recorded numeric ID",
    EGO_TARGET_ID: "recorded exact target ID",
    EGO_SESSION_URL: "https://test-web.example/session/isolated-session-id",
    EGO_TEST_CREDENTIALS_FILE: "/absolute/isolated-cli-home/access.key",
    EGO_CLI_PACKAGE_PATH: "/absolute/installed-cli/package.json",
    EGO_TEST_API_URL: "https://test-api.example",
    EGO_CAPTURE_HELPER_PATH: "file:///absolute/capture-browser-step.mjs",
    HAPPY_CAPTURE_SESSION_ID: "current Happy capture session ID",
    EGO_RUN_ID: "one ID for this whole browser task",
    EGO_RECORDING: "0" // Use "1" in a fresh session for the recorded rerun.
};
```

Prepend that configuration to the runner and pipe the combined file into
`ego-browser nodejs`. Embedded Ego Node may not inherit shell environment
variables; the explicit configuration avoids that ambiguity. Credentials are
read only from the isolated CLI file and are never printed. The runner checks
the exact task/target/URL, generates fresh markers, captures verified frames,
and emits a result JSON. Report each returned frame once to Happy before
finishing the same task space. Native lifecycle waits allow 180 seconds for
real model latency; they do not treat the first final-text event as turn end.

This acceptance covers the specified desktop path. It does not cover narrow
viewports, permissions, offline delivery, attachment guidance, or multi-device
queue synchronization.

[Repeated staging acceptance video](evidence/repeated-message-staging-20261002.mp4)
contains real CDP interaction samples and the verified final state appended.
It is not an uninterrupted recording. The 212.9-second H.264/yuv420p MP4 is
2506×880 at 30 fps; full decoding and visual coverage checks passed. It was
sent as a Happy media card; playback on another device has not been confirmed.
Test sessions and workers were removed, the isolated daemon stopped, and
only the newly created test account credentials were removed from the browser
and CLI home. The existing main daemon and user sessions were preserved.


## Startup handoff and input/reply order (2026-10-03)

Source revision `ffc797e440e11052a6e8af2a24acc08dacb467d7` fixes a second
race: dequeue cleared `queuedMessages` before the native `turn-start`. During
that gap the app could dispatch the next staged input. Its bubble then appeared
before the previous answer, and every later turn remained one input ahead.
The initial busy state without a native turn ID could also incorrectly release
the frontend's submission barrier.

The CLI now retains a pending count from dequeue until the root turn-start has
been scheduled on the same serialized agent-state writer. A batch finally
releases it for local commands and failures before native start. The frontend
requires a new native turn ID before treating a Codex submission as started.

| Case | Pass condition | Result |
| --- | --- | --- |
| COLD-1 | Pending input remains busy between dequeue and native turn-start; later inputs stay staged | Pass |
| ORDER-2 | Send now joins the first turn; each queued input appears after the previous actual reply | Pass |

Both an ordinary run and a fresh recorded rerun used the real 8444 app, an
isolated account/CLI home, Codex 0.159.3 and gpt-6.1-sol/medium. To cover the
short handoff deterministically, the runner briefly SIGSTOPs only its own
Codex app-server before submitting the first input, then SIGCONTs it after
staging the next three inputs. It does not mock the protocol, queue state or
model. The original user's session was read-only.

The recorded run used the installed `queue-handoff-ffc797e4-20261002` CLI.
Inputs 1–5 and their actual replies had sequence pairs **2→8, 11→13, 16→18,
21→23, 26→28**. Thus every next input followed the preceding reply.
Input 8 was explicit native guidance in the first turn
`01a0fd58-a0c4-7000-bf73-aa5fffa44ba0`; remaining inputs used separate turns.
The final verdict required an empty staging queue, all five actual replies,
and completion of the final reply's native turn. The initial
ordinary run exceeded a 240-second model wait; verification continued in the
same session without resubmitting. The recorded rerun passed in 89.1 seconds.

[Pending inputs after guidance](evidence/codex-cold-start-staged-20261003.png)
and [ordered final transcript](evidence/codex-cold-start-ordered-20261003.png)
are verified Ego frames from that rerun. The
[98.1-second acceptance video](evidence/codex-cold-start-order-20261003.mp4)
uses real CDP frame samples plus the same run's verified final screenshot
held for five seconds;
it is not an uninterrupted screen recording. H.264/yuv420p, 1920×674,
30 fps, full decoding passed. The source handoff hold is explicit test timing
control, not a claim that every startup normally takes this long.

The rerun entry is `scripts/verify-cold-start-staging.ego.mjs`. Prepend
`globalThis.coldStartConfig` with EGO_ARTIFACT_DIR (containing the isolated
`home/access.key`, `home/daemon.state.json`, and `project/`), EGO_RECORDING,
EGO_TASK_SPACE_ID, EGO_TARGET_ID, EGO_FROM_URL, EGO_CLI_PACKAGE_PATH,
EGO_TEST_API_URL, EGO_WEB_ORIGIN, EGO_EXPECTED_REVISION,
EGO_CAPTURE_HELPER_PATH, HAPPY_CAPTURE_SESSION_ID and EGO_RUN_ID. Use the
already-owned task/target and a fresh frame directory; report each exact
verified frame once, then clean up only that test account and daemon.

Validation: 13 relevant CLI tests, 17 staging tests, CLI build/typecheck and
app typecheck passed. Independent code review passed. This does not validate
mobile/offline/permission/attachment paths, reconnect or late-child events.
A startup error before any native turn may conservatively retain a barrier
and require explicit retry; automatic recovery from every startup error is
not claimed. Existing historical message order is not rewritten.
