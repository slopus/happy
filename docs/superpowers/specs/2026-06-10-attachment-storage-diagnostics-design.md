# Attachment Storage Diagnostics Design

## Purpose

Image attachments currently work for some users and networks but fail for others. The suspected failure is not in the agent-specific image delivery path, but in the storage transfer path used by Happy attachments: the app asks Happy for an upload or download URL, then follows that URL to either Happy local storage or the S3-compatible storage host.

Because the failure is not reproducible on every network, the first fix should make the failing leg observable without exposing attachment data or secrets. This design adds sanitized diagnostics around attachment upload and download. It does not change the storage architecture in the first phase.

## Goals

- Identify whether attachment failures happen during `request-upload`, direct blob upload, `request-download`, direct blob download, or decrypt/render.
- Log enough sanitized context to diagnose network-specific and storage-host-specific failures.
- Preserve the current user behavior: successfully uploaded images are sent, failed images are skipped, and text messages are not lost.
- Keep logs safe: no bytes, base64, bearer tokens, presigned URL query strings, local paths, or secret-bearing refs.
- Use diagnostic evidence to decide whether a server-mediated storage fallback is needed.

## Non-Goals

- Do not replace the existing direct-to-storage upload path in phase 1.
- Do not add a new public UI surface unless diagnostics show that app console/logs are insufficient.
- Do not change attachment encryption, file event shape, Codex/Claude delivery, or local image cache behavior.
- Do not add support for non-image arbitrary file uploads.

## Current Flow

The app sends image attachments through the existing Happy attachment pipeline:

1. Read local image bytes from the selected attachment URI.
2. Encrypt bytes locally with the session blob key.
3. `POST /v1/sessions/:sessionId/attachments/request-upload` to Happy.
4. Upload the encrypted blob to the returned URL:
   - `PUT` to Happy server in local-storage mode.
   - `POST` multipart form to the S3-compatible storage endpoint in S3 mode.
5. Queue a session `file` event before the user text message.
6. Later, download uses `request-download`, then follows the returned URL and decrypts locally for inline rendering or CLI delivery.

The production deployment exposes both API and file storage behind Cloudflare. The file host returns S3-style XML responses. That makes network-specific failure on the direct storage leg plausible, especially if a carrier, corporate network, WAF, or bot-protection rule treats multipart POSTs to the storage host differently from normal Happy API calls.

## Phase 1: Diagnostic Layer

Add a small diagnostic model in the app attachment sync layer. The model should classify attachment failures by leg:

- `request-upload`
- `blob-upload`
- `request-download`
- `blob-download`
- `decrypt-render`

Each diagnostic record should include:

- `leg`
- `method`, when applicable
- sanitized `host`, not the full URL
- HTTP `status` and `statusText`, when available
- network error message, when fetch throws
- platform and Happy client version, if available from existing client helpers
- whether the transfer target was Happy API/local storage or external storage, inferred from host comparison

The diagnostic helper must strip URL paths and query strings. It must not include attachment refs, presigned policy data, authorization headers, encrypted bytes, decrypted bytes, base64 payloads, or local file paths.

`requestAttachmentUpload`, `uploadEncryptedBlob`, and `downloadEncryptedAttachment` should wrap thrown errors with this structured diagnostic context. Callers should continue to throw/fail in the same places as today; the diagnostic layer changes the information attached to the failure, not the control flow.

`uploadAttachmentsForSession` should log failed uploads with the diagnostic payload. `useAttachmentImage` should log failed downloads or decrypt/render failures with the same format. Successful transfers should not produce noisy logs.

## User Behavior

The existing user-facing behavior remains unchanged in phase 1:

- If one image fails but others upload, send the successful images.
- If image upload fails, show the existing upload failed alert.
- If text is present, send the text even when some or all images fail.
- If an image cannot be downloaded or decrypted later, keep rendering the existing fallback/error state.

The point of phase 1 is to give maintainers a clear answer to “which leg failed?” without changing product behavior.

## Phase 2: Server-Mediated Fallback Candidate

If diagnostics show failures concentrated on `blob-upload` or `blob-download` against the external storage host, design a second phase that routes storage traffic through Happy server as a fallback.

The likely fallback shape:

1. App first attempts the existing direct storage transfer.
2. On selected network failures or storage-host HTTP errors, app retries via a Happy API endpoint.
3. Happy server streams the encrypted blob to or from S3-compatible storage.
4. The server still never sees plaintext attachment bytes.

This fallback increases Happy server bandwidth and request load, so it should not be added silently without evidence. The fallback also needs explicit tests for size limits, auth, path/ref validation, and safe retry behavior.

## Error Handling

- `request-upload` failure: log `leg=request-upload`, API host, HTTP status or network error.
- `blob-upload` failure: log `leg=blob-upload`, upload method, storage or API host, HTTP status or network error.
- `request-download` failure: log `leg=request-download`, API host, HTTP status or network error.
- `blob-download` failure: log `leg=blob-download`, storage or API host, HTTP status or network error.
- decrypt/render failure: log `leg=decrypt-render`, session id only if already considered safe in existing logs, and a non-sensitive reason such as missing blob key, invalid blob key length, decrypt returned null, or unsupported bytes.

When a diagnostic wraps an existing error, preserve the original human-readable message so current alerts and debugging output remain understandable.

## Testing

Automated tests:

- Host sanitization removes path and query from API, local, and storage URLs.
- `request-upload` non-OK response produces a `request-upload` diagnostic.
- `blob-upload` fetch throw produces a `blob-upload` diagnostic with method and host.
- `blob-upload` non-OK response produces a `blob-upload` diagnostic with status.
- `request-download` non-OK response produces a `request-download` diagnostic.
- `blob-download` fetch throw and non-OK response produce `blob-download` diagnostics.
- Diagnostic serialization does not include known secret-bearing strings such as `X-Amz-Signature`, `policy`, bearer tokens, or full presigned URLs.

Manual web smoke test:

1. Send a small image attachment in the web or desktop app on a normal network.
2. Verify the message sends and no sensitive upload URL appears in logs.
3. Block or override `files.cluster-fluster.com` in browser tooling or host resolution.
4. Send another image and verify the log identifies `blob-upload` or `blob-download`, not a generic upload failed message only.
5. Block Happy API and verify the log identifies `request-upload` or `request-download`.

Manual native follow-up:

- If a user can reproduce the original issue on mobile, ask them for the classified diagnostic line rather than a screenshot of a generic alert.

## Rollout

Phase 1 can ship with the restored image upload feature toggle. It is low-risk because it does not alter attachment transfer behavior.

After collecting diagnostics, choose one of these outcomes:

- Failure is mostly `request-upload` or `request-download`: investigate Happy API reachability, auth, rate limiting, or proxy behavior.
- Failure is mostly `blob-upload` or `blob-download` to the storage host: design and implement the server-mediated fallback.
- Failure is mostly decrypt/render: investigate blob key, upload byte integrity, or attachment event ordering.

## Security And Privacy

The diagnostics must be safe to copy into an issue or chat. They must not reveal presigned URL paths or query strings, attachment refs, encrypted or decrypted bytes, base64 payloads, local file paths, tokens, or form fields.

The first phase keeps the existing zero-knowledge property: the server still stores only encrypted blobs and never receives plaintext attachment bytes.
