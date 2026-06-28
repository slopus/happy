# Codex Image Attachments Design

## Goal

Give Codex image attachment parity with Claude in Happy sessions. A user should be able to attach one or more images to a Codex message from the Happy app, send the message, and have Codex receive the images together with the text.

## Scope

- Reuse the existing Happy attachment pipeline: encrypted blob upload, session `file` event, and inline image rendering in chat history.
- Enable image attachments for Codex sessions in the app. Claude remains supported. Gemini and OpenClaw remain unsupported until their runners consume `file` events.
- Deliver images to Codex through `codex app-server` multimodal turn input.
- Maintain a local Codex image cache for plaintext files handed to `localImage`, so Codex provider-history paths can survive fork and resume on the same machine.
- Preserve existing end-to-end encryption boundaries. The server stores encrypted blobs and opaque refs only.
- Keep history, resume, and fork behavior safe: show Happy-owned `file` events when they exist, and avoid inventing image records when only an unavailable provider-local path remains.

## Non-Goals

- Add new server attachment APIs.
- Support arbitrary non-image files in Codex turns.
- Add image support for Gemini or OpenClaw.
- Rebuild Codex provider history as the source of truth for Happy attachments.
- Store decrypted attachment bytes in Happy server storage or session metadata.
- Recover provider-only image history across machines when the only remaining Codex record is a local filesystem path.

## Current State

The app already supports selecting, pasting, previewing, encrypting, and uploading image attachments. The app currently gates delivery to Claude only, because Codex previously ignored `file` events.

The server already has attachment upload and download routes. It does not need to understand plaintext image bytes.

`ApiSessionClient` already parses session `file` events, downloads encrypted blobs, derives the session blob key, and can decrypt attachments. Claude uses this in `runClaude.ts`: file events are accumulated before the following user text and then attached to the queued message.

`MessageQueue2` already supports per-message `attachments`, and the Claude remote launcher already consumes those attachments when building multimodal Claude content blocks.

Codex currently drops the image path because `runCodex.ts` only enqueues `message.content.text`. It does not register `onFileEvent`, drain attachment buckets, or pass image input to `CodexAppServerClient`.

The installed `codex` on this machine is `codex-cli 0.137.0`. Generated app-server types show `UserInput` supports `{ type: "image", url }` and `{ type: "localImage", path }`, with optional `detail`.

The local `codexAppServerTypes.ts` file is a cherry-picked snapshot and still names this union `InputItem`. The current generated protocol names the same turn input union `UserInput`. The implementation should either refresh the local snapshot or keep the local alias while matching the current generated wire shape.

Codex fork backfill currently happens only on the `HAPPY_FORK_CODEX_THREAD_ID` path in `runCodex.ts`, where the runner calls `readThread` and maps provider turns through `mapCodexThreadToSessionEnvelopes`. Direct `happy codex --resume <threadId>` currently resumes the provider thread but does not replay provider turns into a new Happy session.

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
6. Attachments are written to the local Codex image cache and converted into Codex `localImage` records for `turn/start`.

`CodexAppServerClient` should stop hardcoding turn input to only `[{ type: "text", text: prompt }]`. It should accept an optional `extraInputItems` array and build turn input as the text item followed by those extra items. If the prompt is empty and there are image items, omit the empty text item rather than sending `text: ""`. Existing callers that omit `extraInputItems` keep the current text-only behavior.

The default image transport should be cached local files and `{ type: "localImage", path }`. This avoids large `data:` URLs, keeps compatibility with app-server's native local-image support, lets Codex handle file reading through its own app-server protocol, and preserves provider-history paths for same-machine fork and resume.

## Data Flow

Live Codex message with images:

1. User selects images in `AgentInput`.
2. `sync.sendMessage` uploads encrypted images through existing attachment APIs.
3. The app enqueues one `file` event per uploaded image before the text message.
4. The app locally normalizes those `file` events so the chat immediately shows image bubbles.
5. `ApiSessionClient` routes fetched or socket-delivered `file` events to `runCodex.ts`.
6. `runCodex.ts` downloads and decrypts each blob, then claims the current bucket when the next text message arrives.
7. The Codex queue batches text and images together.
8. Before `client.sendTurnAndWait`, the runner writes decrypted bytes to the local Codex image cache.
9. The turn starts with a text input item plus one `localImage` input item per valid image.
10. The cache files remain after the turn so provider-history `localImage.path` records can be read later during same-machine fork or resume.

Image-only Codex messages are valid. If a user sends images with no text, the runner should still send a Codex turn containing the image input items. It should not drop the turn just because `message.content.text` is empty.

## Local Image Cache

Use a per-Codex-session local cache directory for plaintext images handed to Codex as `localImage`. File names must be generated and must not be derived from user-supplied attachment names. The extension is chosen from detected image bytes. If the bytes do not match a supported image type, the image is skipped instead of writing a fallback file.

The cache directory must be readable by the Codex app-server process. Prefer a path already allowed by Happy's sandbox configuration, such as the current workspace/session path or an explicit allowed write root. The default sandbox settings include `/tmp` as an extra write path, but the implementation must not assume every user configuration allows an arbitrary OS temp directory.

Cache files are not removed after each turn. This feature does not implement cache pruning; session deletion, stale-cache maintenance, and user-initiated local state clearing are future cleanup points. This is the privacy tradeoff that makes Codex provider-history image paths recoverable, and it matches the fact that provider transcripts can persist local multimodal inputs.

The CLI should validate image bytes before writing or sending them. At minimum, detect PNG, JPEG, GIF, and WebP magic bytes. Unsupported formats are skipped with a debug log. This matches the defensive Claude path and avoids provider-side validation failures for misleading MIME types such as HEIC reported as a generic image.

## History, Resume, And Fork

Happy history is authoritative for images that were sent through Happy. Because the app stores `file` events before text, reopening the same Happy session should render images from those stored encrypted refs without relying on Codex provider history.

Codex thread backfill should continue to restore text, agent messages, reasoning, and tools from provider history. It should also restore provider `localImage` inputs when the local cached file still exists and the target Happy session does not already contain the matching image event.

If a Codex thread item contains provider image input during a provider-history backfill:

- If Happy already has a matching `file` event in the session stream, prefer that stored event.
- If no matching Happy `file` event exists, the provider item is `localImage`, and the file still exists locally, backfill uploads it through the normal encrypted attachment path and emits a `file` event.
- If the provider item is an image URL or missing local path, do not create a fake `file` event. Preserve the text part and log the skipped image.

This gives good behavior for Happy-originated sessions while avoiding false history records when provider-local files have disappeared.

Fork backfill is required because the current Codex fork flow creates a new Happy session from provider thread history. Direct `happy codex --resume <threadId>` provider-history image backfill is allowed but not required for the first implementation unless the implementation already extends that path to read provider turns. Existing Happy-session reopen and reconnect flows must continue to use stored Happy `file` events.

## App Changes

Update the attachment support gate in `sync.sendMessage` so Codex is supported:

- supported: no flavor, Claude, Codex
- unsupported: Gemini, OpenClaw, unknown explicit non-supported flavors

When attachments are rejected for an unsupported flavor, the app should send text only if `text.trim()` is non-empty. If the user attempted an image-only send to an unsupported agent, show the not-supported alert and enqueue no empty text message.

Keep the existing image picker, paste, drag-and-drop, preview strip, max-count, max-size, encrypted upload, and upload-failure handling.

Update user-facing image upload copy that says Claude-only so it names the supported agents or uses agent-neutral wording.

## CLI Changes

`runCodex.ts` should register `session.onFileEvent` using the same pattern as `runClaude.ts`. The callback should download, decrypt, log failures, and call `session.trackAttachmentDownload`.

`session.onUserMessage` should call `await session.drainAttachmentsForUserMessage()` before enqueueing. Special commands such as `/clear` should carry any attachments consistently with normal messages, although Codex clear handling should still prioritize the clear semantics.

The main Codex processing loop should pass queued attachments into the turn input builder. It should also display the text message in the Ink UI as today; image display names can be logged at debug level but do not need a new terminal UI surface.

`CodexAppServerClient.sendTurn` and `sendTurnAndWait` should accept image input items without changing existing callers. Existing behavior with no attachments must remain byte-for-byte equivalent at the JSON-RPC boundary except for harmless object property ordering.

The Codex thread mapper should learn to detect image input items in `userMessage.content`. It should keep text mapping behavior as-is and add image backfill only through a helper that has access to the target `ApiSessionClient`, because uploading an image requires the target session's blob key and attachment upload route. The pure mapper should not grow network or filesystem side effects.

## Error Handling

Attachment upload failures in the app continue to show the existing upload-failed alert and send any successfully uploaded images.

Unsupported agent flavors continue to show the not-supported alert and send text only when text is present. Unsupported image-only sends enqueue nothing.

Download or decrypt failures in the CLI skip only the failed image. The text message still reaches Codex.

Unsupported image formats are skipped after byte detection. The text message still reaches Codex.

If all images are skipped and text is present, the turn is sent as text-only. If all images are skipped and text is empty, send a session event explaining that no supported images were available and do not start an empty Codex turn.

If cache file creation fails, skip affected images, log the failure, and send text plus any remaining valid images.

If Codex rejects multimodal input, surface the existing Codex error path and keep the session alive. Do not retry with plaintext image descriptions or unencrypted uploads.

## Security And Privacy

The server never receives plaintext attachment bytes.

Decrypted bytes exist in the app during upload and in the local CLI environment for Codex delivery and same-machine provider-history recovery.

Cached plaintext image files are local to the machine running the CLI. They are not uploaded to Happy server, are not referenced from Happy server metadata, and do not include original user file names.

Logs must not include image bytes, base64 payloads, local cache paths, or presigned URLs. Logs may include generated image count, attachment display name, size, and MIME detection result.

## Testing

Add focused coverage for:

- app `sendMessage` treats Codex as attachment-supported and still rejects Gemini/OpenClaw
- Codex runner file-event handling downloads, decrypts, and attaches images to the next user message
- attachment ownership remains per-message and does not leak late downloads into the wrong Codex turn
- image-only Codex messages produce a turn with image input items instead of being dropped
- unsupported image-only sends for Gemini/OpenClaw show the unsupported alert and do not enqueue an empty text message
- `CodexAppServerClient.sendTurn` sends text-only input exactly as before when no attachments are supplied
- `CodexAppServerClient.sendTurn` includes `localImage` items when supplied
- unsupported image bytes are skipped without blocking text delivery
- local image cache uses generated file names, byte-detected extensions, and a sandbox-readable directory
- Codex fork backfill uploads existing local-image cache files into the new Happy session and degrades safely when provider-local image paths are unavailable

Verification should include the targeted unit tests plus the relevant package typecheck.

## Rollout

This feature is naturally guarded by the existing image upload feature setting. No new feature flag is required.

If a user has the image upload feature disabled, Codex behavior remains unchanged.

If the installed Codex app-server lacks image input support, the turn should fail through the normal Codex error handling path. The implementation should log enough protocol context to diagnose version mismatch without exposing secrets or image bytes.
