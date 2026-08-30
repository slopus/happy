# Public Session Sharing Design

## Summary

Paws will let an authenticated user publish one revocable, read-only snapshot of a session. The creation and management entry point is the ellipsis menu in the PC session header. Anyone with the high-entropy URL can view the snapshot without signing in. The public page is a standalone single-column transcript: it never renders the workspace navigation, capability panel, composer, runtime controls, or any mutation affordance.

The snapshot includes the complete message history, rendered tool activity, images, audio, video, documents, and other attachments that the owner can currently decrypt. Publishing is an explicit privacy boundary: the owner confirms that Paws will create a publicly readable copy before the client uploads any plaintext snapshot data.

The same change removes the narrow-screen session header's redundant **New session** button. New-session creation remains available from the navigation drawer.

## Goals

- Add **Share session** to the PC session ellipsis panel.
- Publish a complete, immutable-at-a-point-in-time snapshot rather than a live session.
- Allow the owner to copy the link, open it, replace the snapshot at the same URL, and revoke it.
- Include all supported attachments and make them viewable or downloadable from the public page.
- Let unauthenticated visitors open the URL on desktop or mobile.
- Keep the public route structurally isolated from authenticated session sync and write capabilities.
- Make publication atomic: visitors see either the previous complete snapshot or the new complete snapshot, never a partial upload.

## Non-goals

- Multiple concurrent public links for one session.
- Live updates when the private session changes.
- Public comments, reactions, forks, prompts, or continuation of the session.
- Per-viewer ACLs, passwords, expiry dates, discovery, or search indexing in the first version.
- Native mobile controls for creating or managing a share in the first version.
- Exposing machine names, working directories, session IDs, permission settings, access tokens, or internal attachment references.

## User Experience

### First publication

On PC Web, the existing session-header ellipsis opens the session information panel. A **Share session** row appears in its management section. Selecting it opens a confirmation dialog explaining that the current conversation and every attachment will be copied into a public snapshot and that anyone with the link can read it.

After confirmation, the dialog shows determinate progress across history preparation and attachment uploads. The public URL is not enabled until every required object and the snapshot manifest are committed. On success, Paws copies the URL to the clipboard and offers **Open shared page**.

### Existing share

For a session with an active share, the panel row becomes **Manage sharing**. The management dialog provides:

- **Copy link**
- **Open shared page**
- **Update snapshot**, which atomically replaces the contents while preserving the public URL
- **Revoke sharing**, behind destructive confirmation

After revocation, both the page and its attachment URLs immediately return the same generic not-found response. Republishing the session generates a new public ID so a revoked URL can never become valid again.

### Public page

`/share/:publicId` renders without authentication. It uses a centered, width-constrained transcript with the session title and snapshot timestamp, followed by messages and displayable tool activity in chronological order. Images render inline; audio and video use read-only media controls; documents and other files expose a safe download action.

The production reverse proxy treats `/share/*` as a Web SPA route rather than an API route and attaches `no-store`, `noindex`, CSP, nosniff, and no-referrer response headers before any JavaScript executes. Deployment verification fails if the route returns JSON, misses HTML, or lacks any required header.

The route does not mount authenticated sync, the left session sidebar, right capability panel, agent status, runtime metadata, model or permission controls, composer, keyboard actions, or session mutation code. It includes no "continue this conversation" affordance. A minimal Paws attribution may appear in the transcript header, but it is not an application navigation element.

The page is responsive so recipients can read it on a phone even though share creation and management are PC-only in the first release.

## Snapshot Contract

The client converts decrypted private messages into a versioned, display-only schema rather than uploading storage records verbatim:

```ts
type PublicSessionSnapshotV1 = {
    version: 1;
    title: string;
    sharedAt: number;
    messages: PublicSessionMessageV1[];
};

type PublicSessionMessageV1 = {
    id: string;
    role: 'user' | 'assistant' | 'system';
    createdAt: number;
    blocks: PublicSessionBlockV1[];
};

type PublicSessionBlockV1 =
    | { type: 'text'; markdown: string }
    | { type: 'tool'; name: string; status: 'running' | 'completed' | 'failed'; title?: string; body?: string }
    | { type: 'attachment'; attachmentId: string; kind: 'image' | 'audio' | 'video' | 'document' | 'file'; name: string; mimeType: string; size: number };
```

The snapshot builder accepts only visible content. It removes provider/session identifiers, machine and path metadata, encrypted blob references, permission details, hidden model state, and client-only callbacks. Attachment references are replaced with share-scoped opaque IDs.

Markdown remains untrusted input. The public renderer uses the same safe Markdown/code presentation primitives as the authenticated transcript and never evaluates raw HTML or scriptable attachment content.

## Data Model

`PublicSessionShare` stores one current share per private session:

- `id`: internal database ID
- `publicId`: high-entropy URL-safe identifier with a unique index
- `accountId`: owning account
- `sessionId`: source session, unique to enforce one current share
- `snapshot`: versioned JSON manifest
- `assetGeneration`: opaque generation prefix used by the current manifest
- `publishedAt`, `createdAt`, and `updatedAt`
- `revokedAt`: nullable tombstone timestamp

The account and session relations authorize owner operations. Revocation rotates away from the public identifier before any future republish. Public handlers query only non-revoked records.

Attachments live under a generation-scoped private object prefix such as `private/session-shares/<internalShareId>/<generation>/<opaqueAssetId>`. The snapshot manifest never exposes the storage path. A public attachment handler resolves `publicId + attachmentId` against the active manifest and streams the matching object with sanitized headers; it never returns a reusable object-store URL.

## API and Publication Flow

Authenticated owner endpoints:

- `GET /v1/sessions/:sessionId/share` returns the active share state and public URL metadata.
- `POST /v1/sessions/:sessionId/share/drafts` creates a draft generation and returns upload descriptors.
- `POST /v1/sessions/:sessionId/share/drafts/:draftId/assets` prepares share-scoped attachment uploads.
- `PUT /v1/sessions/:sessionId/share/drafts/:draftId/publish` validates the complete manifest and atomically activates the generation. The first publish allocates a public ID; updates retain it.
- `DELETE /v1/sessions/:sessionId/share` revokes the share and invalidates its public ID.

Unauthenticated endpoints:

- `GET /v1/public/session-shares/:publicId` returns the sanitized snapshot.
- `GET /v1/public/session-shares/:publicId/attachments/:attachmentId` returns or redirects to the validated shared asset.

Publication is a two-phase operation:

1. The client loads the full paginated history and builds the sanitized snapshot.
2. The server creates a non-public draft generation.
3. The client decrypts each referenced attachment and uploads the plaintext copy to the draft.
4. The client submits the final manifest with the expected asset IDs, sizes, MIME types, and hashes.
5. The server validates ownership, limits, object completeness, and manifest references, then switches the active generation in a transaction.
6. Obsolete generation objects are removed asynchronously only after activation succeeds.

If any step before activation fails, the current public snapshot remains untouched. Drafts are never reachable from public endpoints and can be garbage-collected after a bounded lifetime.

## Security and Privacy

- Public IDs use at least 192 bits of cryptographically secure randomness and are never sequential.
- Owner endpoints use existing authentication and verify that the session belongs to `request.userId`.
- Public responses use `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow, noarchive`, and a restrictive content security policy for the Web document.
- Attachment names are basename-normalized. MIME types are allowlisted for inline media; unknown, HTML, SVG, and other script-capable types download as `application/octet-stream` with `Content-Disposition: attachment`.
- The server enforces per-file, snapshot, file-count, account-storage, and request-rate limits before accepting a draft. Draft and asset reservations run in retryable Serializable transactions so concurrent requests cannot step around quotas.
- A scheduled cleanup worker retries expired, superseded, and revoked generations. Storage is deleted before its database manifest, preserving a durable retry record whenever object deletion fails.
- Public errors do not reveal whether a link was revoked, malformed, expired during a draft, or never existed.
- Application logs do not include snapshot bodies, attachment plaintext, or full public URLs.
- Revocation makes database resolution fail immediately; object deletion is defense-in-depth and may complete asynchronously.

## Client Architecture

- A dedicated snapshot builder converts loaded session messages into `PublicSessionSnapshotV1` and enumerates attachment jobs.
- A share API module owns draft, upload, publish, state, and revoke calls.
- A `usePublicSessionShare` hook coordinates preparation and progress using the existing happy-action error surface.
- The existing session information dropdown receives the PC-only share/manage row.
- The public Web entry uses a persistence-free theme, translation, and same-origin API graph; it does not evaluate MMKV-backed app preferences or custom server configuration.
- A focused share-management modal presents confirmation, progress, copy/open/update/revoke actions.
- A top-level public route fetches only the public snapshot API and renders through stateless public transcript components.
- Public transcript components depend on the snapshot contract, theme tokens, and safe renderers only. They never import authenticated storage, sync, session operations, or the message composer.

## Narrow-screen Header Cleanup

The current phone session header renders a prominent **New session** button while the navigation drawer already provides the same action. Remove this header control and its component from `SessionView`; retain the drawer entry and all desktop creation affordances outside this specific narrow-screen header.

## Error Handling

- History preparation must reach the oldest page before snapshot publication starts.
- One failed attachment fails the draft; the UI reports failure through the standard action surface and offers retry.
- A failed update preserves the previous active generation and link.
- A revoked or unknown public ID produces one generic not-found screen.
- A valid snapshot with a missing asset still renders the transcript and shows a non-interactive unavailable attachment placeholder; the server logs the integrity failure without leaking storage details.
- Duplicate publish and revoke requests are idempotent.

## Testing and Verification

Server tests cover owner authorization, one-share-per-session behavior, high-entropy ID allocation, draft invisibility, manifest validation, atomic update, idempotent revoke, public not-found equivalence, attachment lookup, and safe response headers.

Client unit tests cover complete pagination, visible-content sanitization, attachment enumeration, failed-upload rollback, share-management state, and removal of the phone header button. Public-page component tests assert that messages and all attachment kinds render while workspace panels, composer, session operations, and runtime metadata are absent.

Verification runs package type checks and focused Vitest suites. No development server, simulator, emulator, OTA publication, or real-device validation is started without separate permission. Because this is visible PC Web work, the PR includes the repository-required per-case before/after evidence, including a non-default dark theme state. The change is merged only after CI and independent PR review pass; production Web and OTA workflows are then checked against the merge commit.

## Rollout

The database migration and server endpoints deploy before or together with the Web client. The new UI treats an unavailable share API as a failed action and does not expose a broken public URL. Existing sessions require no migration beyond the nullable relation. There is no backward-compatibility format: the first public contract is explicitly version `1`, and unsupported versions return not found rather than attempting a lossy render.
