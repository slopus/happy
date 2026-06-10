# Codex Image Attachments Design

## Goal

Give Codex image attachment parity with Claude in Happy sessions. A user should be able to attach one or more images to a Codex message from the Happy app, send the message, and have Codex receive the images together with the text.

## Scope

- Reuse the existing Happy attachment pipeline: encrypted blob upload, session `file` event, and inline image rendering in chat history.
- Enable image attachments for Codex sessions in the app. Claude remains supported. Gemini and OpenClaw remain unsupported until their runners consume `file` events.
- Deliver images to Codex through `codex app-server` multimodal turn input.
- Preserve existing end-to-end encryption boundaries. The server stores encrypted blobs and opaque refs only.
- Keep history, resume, and fork behavior safe: show Happy-owned `file` events when they exist, and avoid inventing image records when only an unavailable provider-local path remains.

## Non-Goals

- Add new server attachment APIs.
- Support arbitrary non-image files in Codex turns.
- Add image support for Gemini or OpenClaw.
- Rebuild Codex provider history as the source of truth for Happy attachments.
- Store decrypted attachment bytes in Happy server storage or session metadata.

## Current State

The app already supports selecting, pasting, previewing, encrypting, and uploading image attachments. The app currently gates delivery to Claude only, because Codex previously ignored `file` events.

The server already has attachment upload and download routes. It does not need to understand plaintext image bytes.

`ApiSessionClient` already parses session `file` events, downloads encrypted blobs, derives the session blob key, and can decrypt attachments. Claude uses this in `runClaude.ts`: file events are accumulated before the following user text and then attached to the queued message.

`MessageQueue2` already supports per-message `attachments`, and the Claude remote launcher already consumes those attachments when building multimodal Claude content blocks.

Codex currently drops the image path because `runCodex.ts` only enqueues `message.content.text`. It does not register `onFileEvent`, drain attachment buckets, or pass image input to `CodexAppServerClient`.

The installed `codex` on this machine is `codex-cli 0.137.0`. Generated app-server types show `UserInput` supports `{ type: "image", url }` and `{ type: "localImage", path }`, with optional `detail`.

## Architecture

Use Happy attachments as the source of truth and Codex `localImage` items as the delivery mechanism.

The app continues to send each image as:

1. encrypted blob upload
2. `session` role envelope with `ev.t = "file"`
3. normal user text message

The Codex CLI runner mirrors Claude's ownership model:

1. `session.onFileEvent` starts download and decrypt work for each file event.
2. `session.trackAttachmentDownload` stores promises in the current attachment bucket.
3. `session.onUserMessage` calls `drainAttachmentsForUserMessage` before resolving mode overrides.
4. `MessageQueue2.push` receives both text and attachments.
5. The Codex loop receives a queued batch with `message.attachments`.
6. Attachments are converted into Codex `InputItem` records for `turn/start`.

`CodexAppServerClient` should stop hardcoding turn input to only `[{ type: "text", text: prompt }]`. It should accept an optional `extraInputItems` array and build turn input as the text item followed by those extra items. Existing callers that omit `extraInputItems` keep the current text-only behavior.

The default image transport should be temporary local files and `{ type: "localImage", path }`. This avoids large `data:` URLs, keeps compatibility with app-server's native local-image support, and lets Codex handle file reading through its own app-server protocol.

## Data Flow

Live Codex message with images:

1. User selects images in `AgentInput`.
2. `sync.sendMessage` uploads encrypted images through existing attachment APIs.
3. The app enqueues one `file` event per uploaded image before the text message.
4. The app locally normalizes those `file` events so the chat immediately shows image bubbles.
5. `ApiSessionClient` routes fetched or socket-delivered `file` events to `runCodex.ts`.
6. `runCodex.ts` downloads and decrypts each blob, then claims the current bucket when the next text message arrives.
7. The Codex queue batches text and images together.
8. Before `client.sendTurnAndWait`, the runner writes decrypted bytes to a per-session temporary directory.
9. The turn starts with a text input item plus one `localImage` input item per valid image.
10. After the turn completes or aborts, temporary files are removed best-effort.

## Temporary File Handling

Use a per-Codex-session temp directory under the OS temp root. File names should be generated, not derived directly from user-supplied attachment names. The extension is chosen from detected image bytes. If the bytes do not match a supported image type, the image is skipped instead of writing a fallback file.

Temporary files must be scoped to one turn. The runner should clean them up in a `finally` block after `sendTurnAndWait`. If cleanup fails, log a debug message and continue.

The CLI should validate image bytes before writing or sending them. At minimum, detect PNG, JPEG, GIF, and WebP magic bytes. Unsupported formats are skipped with a debug log. This matches the defensive Claude path and avoids provider-side validation failures for misleading MIME types such as HEIC reported as a generic image.

## History, Resume, And Fork

Happy history is authoritative for images that were sent through Happy. Because the app stores `file` events before text, reopening the same Happy session should render images from those stored encrypted refs without relying on Codex provider history.

Codex thread backfill should continue to restore text, agent messages, reasoning, and tools from provider history. It should not duplicate Happy-owned image events if the Happy session already contains those events.

If a Codex thread item contains provider image input during a provider-history backfill:

- If Happy already has a matching `file` event in the session stream, prefer that stored event.
- If no matching Happy `file` event exists, the provider item is `localImage`, and the file still exists locally, backfill uploads it through the normal encrypted attachment path and emits a `file` event.
- If the provider item is an image URL or missing local path, do not create a fake `file` event. Preserve the text part and log the skipped image.

This gives good behavior for Happy-originated sessions while avoiding false history records when provider-local files have disappeared.

## App Changes

Update the attachment support gate in `sync.sendMessage` so Codex is supported:

- supported: no flavor, Claude, Codex
- unsupported: Gemini, OpenClaw, unknown explicit non-supported flavors

Keep the existing image picker, paste, drag-and-drop, preview strip, max-count, max-size, encrypted upload, and upload-failure handling.

Update user-facing image upload copy that says Claude-only so it names the supported agents or uses agent-neutral wording.

## CLI Changes

`runCodex.ts` should register `session.onFileEvent` using the same pattern as `runClaude.ts`. The callback should download, decrypt, log failures, and call `session.trackAttachmentDownload`.

`session.onUserMessage` should call `await session.drainAttachmentsForUserMessage()` before enqueueing. Special commands such as `/clear` should carry any attachments consistently with normal messages, although Codex clear handling should still prioritize the clear semantics.

The main Codex processing loop should pass queued attachments into the turn input builder. It should also display the text message in the Ink UI as today; image names may be logged but do not need a new terminal UI surface.

`CodexAppServerClient.sendTurn` and `sendTurnAndWait` should accept image input items without changing existing callers. Existing behavior with no attachments must remain byte-for-byte equivalent at the JSON-RPC boundary except for harmless object property ordering.

## Error Handling

Attachment upload failures in the app continue to show the existing upload-failed alert and send any successfully uploaded images.

Unsupported agent flavors continue to show the not-supported alert and send text only.

Download or decrypt failures in the CLI skip only the failed image. The text message still reaches Codex.

Unsupported image formats are skipped after byte detection. The text message still reaches Codex.

If all images are skipped, the turn is sent as text-only.

If temporary file creation fails, skip affected images, log the failure, and send text plus any remaining valid images.

If Codex rejects multimodal input, surface the existing Codex error path and keep the session alive. Do not retry with plaintext image descriptions or unencrypted uploads.

## Security And Privacy

The server never receives plaintext attachment bytes.

Decrypted bytes exist only in the app during upload and in the local CLI process during delivery to Codex.

Temporary files are local to the machine running the CLI and are removed after each turn. Their names should not include original user file names.

Logs must not include image bytes, base64 payloads, or presigned URLs. Logs may include generated temp file count, attachment display name, size, and MIME detection result.

## Testing

Add focused coverage for:

- app `sendMessage` treats Codex as attachment-supported and still rejects Gemini/OpenClaw
- Codex runner file-event handling downloads, decrypts, and attaches images to the next user message
- attachment ownership remains per-message and does not leak late downloads into the wrong Codex turn
- `CodexAppServerClient.sendTurn` sends text-only input exactly as before when no attachments are supplied
- `CodexAppServerClient.sendTurn` includes `localImage` items when supplied
- unsupported image bytes are skipped without blocking text delivery
- temporary files are cleaned up after success, abort, and error paths
- Codex thread backfill does not duplicate existing Happy `file` events and degrades safely when provider-local image paths are unavailable

Verification should include the targeted unit tests plus the relevant package typecheck.

## Rollout

This feature is naturally guarded by the existing image upload feature setting. No new feature flag is required.

If a user has the image upload feature disabled, Codex behavior remains unchanged.

If the installed Codex app-server lacks image input support, the turn should fail through the normal Codex error handling path. The implementation should log enough protocol context to diagnose version mismatch without exposing secrets or image bytes.
