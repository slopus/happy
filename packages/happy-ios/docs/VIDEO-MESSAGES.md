# Round video messages: a plan

Status: plan only. Nothing here is built. The microphone (`RecordButton`)
ships with one mode, dictation. This page describes the second mode,
Telegram's round video message ("video circle"), and how to add it.

## What it is for

The person holds the button and talks to the front camera. The result is a
short round video that they "send into the void". Over time the void could:

- start a new task from it (the first version);
- bring people into the conversation: a teammate, or whoever is mentioned in
  the video;
- publish it somewhere (a channel, a doc, a changelog).

The goal is more video made with Happy. Recording has to cost no more than
dictation does today: one hold, nothing to set up, nothing to confirm.

## What Telegram does

Read from Telegram-iOS master (November 2026), in our own words. Paths are
in that repository.

**One button, two modes.** `ChatTextInputMediaRecordingButton` holds either
the microphone or the camera. A press starts a 0.19 s timer
(`micButtonInteractionBegan`, `modeTimeoutTimer`). Released before it fires,
the press is a tap: `switchMode()` flips voice ↔ video and a tooltip says
"Hold to record audio. Tap to switch to video." Held past it, the press
starts recording in the current mode. Everything after that is shared: slide
left cancels, slide up locks (`TGModernConversationInputMicButton`), and the
same lock pill, cancel line and clock appear. Our `RecordGesture` and
`RecordOverlay` are those shared parts already.

**The camera screen.** `VideoMessageCameraScreen` is a controller over the
chat:

- The preview is a circle, `min(369, band − 24)` points across, centred, at
  40% of the height above the input panel (20% on a tablet). The chat stays
  visible, dimmed by a blurred background.
- The camera is the front camera, 1080p (`preset: .hd1920x1080`). The circle
  shows the middle of a 3:4 (or 9:16 with the dual camera) frame, cropped
  square. With dual-camera support it records front and back together and a
  tap swaps them.
- A 4 pt white ring at 60% opacity (`RecordingProgressView`) fills over the
  edge as the clock runs. `strokeEnd` is animated linearly at
  `duration / 60`, so a full ring is the 60 s limit. At 59.5 s it stops by
  itself.
- A flip button and a flash button sit at the bottom left on glass. Front
  "flash" is a white screen at full brightness (`updateScreenBrightness`),
  brought back afterwards over 0.2 s.
- Pinch zooms (`handlePinch` → `camera.setZoomLevel`).
- Locked, the bottom gets a stop button. Stop shows a preview with a trim bar
  (`updateTrimRange`), where the person can scrub, play, delete or send.
  Recording again after a stop appends to the same video (`initialDuration`
  carries over).
- Presses less than 0.5 s apart are ignored (`lastActionTimestamp`).
- "View once" is offered for one-to-one chats.

**Sending.** The video is exported at 30 fps with
`recommendedVideoExportConfiguration`: H.264 square, about 400×400, small
bitrate. It goes as an mp4 with the `.instantRoundVideo` flag and a
thumbnail. While recording, `setupLiveUpload` starts uploading the file as
it grows, so sending is close to instant when the person lets go.

**Showing it.** In the chat the message is a circle
(`ChatMessageInteractiveInstantVideoNode`). It plays muted on loop while on
screen and plays with sound, larger, when tapped. A radial ring
(`InstantVideoRadialStatusNode`) shows progress. The circle flies from the
camera screen to its place in the chat (`messageTransitionNode` with
`.videoMessage`).

## What we would build

### 1. The mode

- Add `case videoMessage` to `RecordMode` and to `RecordMode.offered`. With
  two modes, `RecordMode.tapSwitches` is true.
- `RecordButton`: a release before `RecordGesture.Metrics.tapDuration`
  calls `mode = mode.next` and shows a tooltip, as Telegram's does. While only
  dictation exists, the same tap locks the recording instead (Kirill's
  call). With video in, decide which wins: Telegram's switch, or tap-to-lock
  with a long-press menu to switch. Recommendation: Telegram's switch,
  because people already know it.
- The glyph: Ionicons `videocam` (in `HappyIcons` already) in place of
  `mic`. The choice is remembered per device in `UserDefaults`.

### 2. The camera screen (`VideoMessageScreen`, HappyUI)

- A window-level overlay like `RecordOverlay`, so the press keeps going: the
  recording begins on the touch-down and the button's gesture keeps
  tracking. `RecordOverlay`'s bar, lock pill and circle are reused as they
  are. The circle preview is new.
- `VideoMessageLayout` (HappyLayout, exact-frame tests): the preview circle
  (Telegram's 369 cap, 24 margin, at 40% / 20%), the progress ring, the flip
  and flash buttons, the locked stop.
- Capture: `AVCaptureSession` with the front camera at 1080p into
  `AVAssetWriter`, cropped to a square centre at write time (no re-encode
  later). The ring's progress is `duration / 60`, stopping at 59.5 s. The
  microphone goes into the same file. Reuse `Sources/HappyUI/Camera`
  (docs/CAMERA.md), which already copies Telegram's camera session setup.
- Locked: stop → a preview that loops, with Send and Delete. Trimming and
  appending can wait for version 2.

### 3. Sending into the void (version 1: a new task)

- The video goes as an attachment (`OutgoingAttachment`, `video/mp4`), the
  same path pictures take, so the computer gets the file.
- The task's first message is the video plus its transcript. The transcript
  comes from the same on-device `Dictation`, fed by the capture's audio. The
  agent can then act on what was said and mentioned, with the video kept
  as the source.
- On home that is `makeNewWork(dictated:)` with an attachment. In a chat it
  is the next message.
- Upload while recording, as Telegram's live upload does, once the
  attachment pipeline can stream (it can't today: an attachment is read
  whole before upload).

### 4. Showing it

- Chat rows: a round video bubble that plays muted on loop when visible and
  with sound on tap. The ring shows progress. It is drawn in our own UltraList
  row; it needs the Chat workstream.
- Home rows: a small circle thumbnail in the task's row.

### 5. Later: where else the void sends

- Mentions: the transcript names people. The task can offer to share with
  them, or the agent can ask.
- Teammates: share the task (needs team accounts).
- Publish: the agent posts it where the person says (a docs page, a channel),
  as any other artifact.

## Order of work

1. `RecordMode.videoMessage` and the tap switch with its tooltip (small;
   behind a flag until 2 lands).
2. `VideoMessageLayout` and its tests, then `VideoMessageScreen` with capture
   and the progress ring, reusing `RecordGesture` and `RecordOverlay`.
3. Sending as a new task (attachment plus transcript), then in chats.
4. The round bubble in chats.
5. Live upload, trim, append, dual camera, then the "void" destinations.

## Open questions

- Tap: switch modes (Telegram) or keep tap-to-lock? See "The mode".
- Is 60 s the right limit for "into the void"? Telegram's is 60 s.
- Where do videos live long term (the computer's workspace, or a Happy
  store), and who can see them once teammates come in?
- Does the agent get the video file, the transcript, or both? This plan says
  both.
