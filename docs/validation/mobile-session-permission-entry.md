# Mobile session entry and pending approval

Base: `6b419f7a85e24b897a81bbbaefb733274c0c873c` (2026-11-28).

## Problem and correction

In the project and timeline lists, selecting a `permission_required` session bypassed normal conversation navigation. The row loaded the pending tool message and navigated directly to `/session/<executionId>/message/<messageId>`. On Android, Back returned to the list because the chat had never been opened.

The row now always uses `useNavigateToSession(session.id)`. The existing navigation owns stable conversation identity, project routes, and current execution resolution. Pending permissions remain inside the existing transcript; explicitly opening a tool still opens its detail screen. Permission RPCs, modes, input controls, and approval decisions are unchanged.

This is an entry-path correction, not a redesign of all permission controls. There is no composer increment.

## Checks

| Case | Acceptance | Evidence / boundary |
| --- | --- | --- |
| C1 | Select a pending row and enter the chat | Before reproduced on API36 native components; project/time regression first failed against base, then passed after correction |
| C2 | Read chat text and retain the pending approval inside chat | Native component fixture; synthetic messages, local state, no account or execution |
| C3 | Explicitly open tool detail, Back returns to chat | Original Expo Router/tool detail; added `audit123` draft remains intact after Back |
| C4 | Selection mode toggles stable chat selection without navigating | Component regression |

21 targeted checks and 7 OTA runtime contract checks passed. Full application typecheck passed after regenerating local Expo route types from application routes, excluding colocated tests as Metro does. Independent code and interaction evidence reviews passed without blocking findings.

## Native evidence boundaries

The isolated harness mounts the original `CompactSessionRow`, normal navigation hook, `ConversationTranscript`, `MessageComposer`, and original message-detail route using synthetic session data. Sync visibility/message-loading callbacks are local; no model request or permission approval is submitted. It does not exercise the complete authenticated App, real sidebar drawer, real continuation/project data, a production OTA, or the user's physical phone.

The first emulator was taken over by another concurrent validation task. Capture/action work stopped on that instance; unrelated frames and the affected recording are excluded. A separate named AVD is used for the final sequence. UiAutomator can return an idle error while a pending tool timer updates; a previous XML file must not be treated as current evidence.

Final native validation uses the dedicated `Paws_Approval_20261128_6b419f7` AVD / `emulator-5590`, API36, 1080×2400, 420dpi, English system locale, `build.paws.dev` 1.7.1/runtime24 shell loading the worktree via Metro8097. C1/C2/C3 passed in that scope; no approval was submitted. The 35.96-second recording and screenshots were delivered through Happy. The real authenticated app, project/continuation data and user's phone remain unverified.

Development occurs in sibling worktree `happy--mobile-approval-audit`; root `happy` remains clean main. Temporary entry points have been restored and fixture files archived outside source. Release receipts and hashes belong to the task's local artifact report; artifact publication does not prove a phone loaded the update.
