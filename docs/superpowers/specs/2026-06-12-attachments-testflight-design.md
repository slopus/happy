# Design: Attachment Extensions (Camera + Files) + Local TestFlight Build

Date: 2026-06-12
Status: Approved (rev 2 — architecture corrected after codebase audit)

## Goal

1. Extend the Happy app's existing image-attachment pipeline to the full scope of issue #1319 (camera capture, arbitrary files/PDFs), and fix the silent-drop of HEIC images. Covers issues #1270, #919, #70.
2. Ship a personal iOS build to TestFlight via local headless xcodebuild (App Store Connect API key signing — Seneca/SoundSpotter pattern), incorporating our open PRs #1372 (Fable 5) and #1373 (per-model effort + Opus 4.8[1m]) without waiting for upstream merge.

## What upstream main already has (do NOT rebuild)

The audit found a complete, working image pipeline behind the `expImageUpload` settings flag:

- App: `useImagePicker` hook (gallery, max 20 images, 10 MB cap), `AgentInputAttachmentStrip`, web paste/drag, picker button in `AgentInput`.
- Server: encrypted blob storage — `POST /v1/sessions/:id/attachments/request-upload` / `request-download`, presigned PUT (local) / POST (S3), 10 MB cap.
- E2E encryption: app encrypts with session blob key (`deriveKey(key, 'Happy Blobs', …)`), CLI decrypts via `decryptBlob` (tweetnacl secretbox).
- Protocol: `t:'file'` session events (schema in `happy-wire/src/sessionProtocol.ts:46-59`).
- CLI: `runClaude.ts:448` `onFileEvent` → `downloadAndDecryptAttachment` → `trackAttachmentDownload`; `drainAttachmentsForUserMessage` claims attachments per user message; `MessageQueue2` carries them; `claudeRemoteLauncher.ts:344-378` converts to SDK `image` content blocks via magic-byte `detectClaudeImageMime` (JPEG/PNG/GIF/WebP).

PR #554's writeFile-RPC architecture is obsolete — upstream chose the server-blob route.

## Gaps this design closes

| # | Gap | Where |
|---|-----|-------|
| 1 | **HEIC silently dropped** — iOS gallery/camera HEIC fails magic-byte detection at `claudeRemoteLauncher.ts:358` and is skipped with only a debug log | App-side normalize before upload |
| 2 | **No camera capture** — picker goes straight to gallery | App |
| 3 | **No file/PDF attachment** — `expo-document-picker` installed (~55.0.0) but unused; CLI converts only images | App + CLI |
| 4 | **Oversized images** — originals uploaded at `quality: 1` with no downscale; >5 MB images exceed the Claude API per-image limit | App-side normalize |

## Branch strategy

```
upstream/main
 ├─ feat/fable-5-model        (PR #1372, exists — needs rebase, upstream moved)
 ├─ feat/claude-model-effort  (PR #1373, exists, stacked on fable-5 — needs rebase)
 ├─ feat/attachments          (THIS — clean off main; app + cli changes; PR upstream)
 └─ local/testflight          (integration: main + all 3 feature branches
                               + one local-only commit: bundle ID, build script.
                               Never PRed.)
```

happy-cli changes run from local dist via the existing daemon setup; the CLI is not part of the TestFlight artifact.

## Feature design (feat/attachments)

### App: attachment source action sheet

`AgentInput`'s existing picker button (`onPickImages`) becomes "add attachment": opens a chooser — **Photo Library / Take Photo / Choose File** — via the app's `Modal.alert` button pattern (cross-platform; web keeps direct file behavior plus existing paste/drag).

- Camera: `ImagePicker.launchCameraAsync` + `requestCameraPermissionsAsync`; `NSCameraUsageDescription` added to `app.config.js` `ios.infoPlist` (generic string, upstreamable).
- Files: `DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true })`; result flows through the same `AttachmentPreview` → upload → `t:'file'` event path (width/height 0, no thumbhash, `mimeType` from picker).
- Existing caps stay: max 20 attachments per message, 10 MB per file (server-enforced too).

### App: image normalization before upload (quality-preserving)

In the picker/camera result path, before building `AttachmentPreview`:

- If format is not JPEG/PNG/GIF/WebP (e.g. HEIC), convert → JPEG quality 0.9 via `expo-image-manipulator`.
- If long edge > 1568 px (Claude vision API ceiling — the API downscales beyond this itself), downscale to 1568 px long edge. Also keeps payloads under the API's 5 MB per-image limit.
- Otherwise leave bytes untouched (no recompression of already-valid formats at acceptable size).
- Web `fileToAttachmentPreview` path gets the same rules via Canvas.

### CLI: non-image attachment conversion

Extend the conversion in `claudeRemoteLauncher.ts` (currently image-only):

- `%PDF-` magic → SDK `document` content block (`source: { type: 'base64', media_type: 'application/pdf' }`).
- Declared `text/*` mimeType (or extension fallback) that decodes as valid UTF-8 → `text` content block: fenced, prefixed with the filename.
- Anything else → skip, and (unlike today) emit a visible notice in the text block sent to the agent ("[attachment <name> was not a supported type]") so failures aren't silent.

`PendingAttachment` already carries `{ data, mimeType, name }` — no protocol change.

### i18n

New keys under the existing `imageUpload` section of `text/_default.ts` (chooser labels, camera permission, unsupported-type) mirrored into all 10 translation files (`ca, en, es, it, ja, pl, pt, ru, zh-Hans, zh-Hant`).

### Settings flag

Feature stays behind the existing `expImageUpload` flag (Settings → Features). Label copy updated from "images" to "attachments". Flag flipped on in our local build; upstream default untouched.

### Testing

- CLI (vitest, colocated `*.test.ts`): content-block conversion — PDF magic → document block, UTF-8 text → text block, unknown bytes → notice; HEIC bytes still skipped at CLI (defense in depth).
- App (vitest, pattern: `settings.spec.ts`): normalization decision logic (format/size → convert/downscale/passthrough) extracted as a pure function and tested; document-picker → `AttachmentPreview` mapping.

## TestFlight build (local/testflight only)

### One-time manual prereqs (public ASC API cannot create app records)

1. Register bundle ID `ca.lixfeld.happy` in the Apple Developer portal.
2. Create the ASC app record against it (name e.g. "Happy JL"). TestFlight-only; never App Store.

### `scripts/build-ios-testflight.sh`

```
fetch APPLE_ASC_KEY_ID / APPLE_ASC_ISSUER_ID (Infisical)
verify ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8 exists — fail fast
APP_ENV=production expo prebuild   (regenerates ios/)
xcodebuild archive   -allowProvisioningUpdates -authenticationKeyPath/-KeyID/-KeyIssuerID
xcodebuild -exportArchive  (app-store method) + same three auth flags
xcrun altool --upload-app --apiKey/--apiIssuer
```

Both `archive` and `-exportArchive` carry the three `-authenticationKey*` flags — without them, headless automatic signing fails (`error: No Accounts`) or produces a generic profile missing entitlements.

### Local-only commit contents

- `app.config.js`: production bundle ID → `ca.lixfeld.happy` (today `com.ex3ndr.happy`), display-name tweak.
- `scripts/build-ios-testflight.sh`.
- Timestamp-based build-number auto-increment.
- `expImageUpload` default flip (local convenience).

### Known limitation

Push notifications do not work in the fork build: happy-server sends APNs pushes with slopus' credentials, tied to their bundle ID. Pairing and E2E sync against api.happy-servers.com are unaffected.

## Out of scope

- Server changes of any kind (10 MB cap stays).
- Android build/distribution.
- App Store (non-TestFlight) release.
- Restoring push notifications in the fork build.
- Chunked upload (server cap is 10 MB; presigned upload path already handles that size).
