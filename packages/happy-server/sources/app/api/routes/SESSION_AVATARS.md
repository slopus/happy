# Session avatars

Session responses (v1 list/create-or-load and v2 lists) and `new-session` events
include optional, nullable `avatar: { ref, preview, version }`. Old servers may omit
it. `update-session` events include it only on change; `null` explicitly clears it.
The existing account event sequence orders events. Snapshots and avatar-change events also
carry optional `avatarVersion`, the per-session revision even when `avatar` is null. Clients
compare this revision across REST snapshots and events so a delayed update cannot resurrect
a removed picture. With an image it matches `avatar.version`; it starts at zero without one.

Under `/v1/sessions/:sessionId/avatar`:

- `POST /request-upload`, `{ size }`: returns `{ ref, uploadUrl, method, formFields? }`.
  Upload opaque bytes using the returned instruction, then activate them.
- `PATCH`, `{ ref, preview }`: activates an existing session-owned upload and returns
  `{ avatar }`. Identical activation is a no-op.
- `POST /request-download`: returns `{ ref, downloadUrl }` for the active picture;
  missing pictures return 404. Clients must match the returned ref to their descriptor.
- `DELETE`: returns `{ avatar: null }`; repeated removal is a no-op.

All routes require the session owner's authentication. Local storage uses authenticated
PUT/GET routes at `/avatar/:avatarFile`; S3 uses a bounded POST policy and expiring GET
URL. Never send the Happy bearer token to a different upload/download origin. Encrypted
images are limited to 10 MB, encrypted previews to 4 KB, upload grants to 60 per minute
per account per process. Old/incomplete uploads are retained until session deletion,
when avatar storage is cleaned alongside attachments. Removal does not delete a prefix
that a concurrent upload might still be using.

The server never decrypts images or previews. Clients encrypt preview JSON containing
`thumbhash` and `mimeType` with the session payload key, and image bytes with the existing
session blob encryption (including the legacy account-key form). Optional private preview
fields are tolerated. No key material is sent in the descriptor.

The additive database migration adds `Session.avatarRef`, `avatarPreview`, and
`avatarVersion`; existing sessions default to no picture. Project sessions do not need a
session avatar. Mobile chooses session artwork, then project artwork, then its fallback.
Bot producers publish the bot's picture here without creating a synthetic project.

## Why sessions

An avatar belongs to the conversation being displayed, not necessarily to its project.
The session-level field also leaves room for distinct conversation pictures later, without
requiring independently editable avatars in Happy Agent's direct API today.

We considered a relay-only project for each bot to reuse project avatar storage. Older
clients would treat those records as normal projects and offer invalid new-session/worktree
actions. Avoiding that would require capability filtering. File viewers can already use the
bot's dedicated workspace without a fake project; tracking changes needs its own baseline.
A future direct Agent API client can consume the existing bot image directly.

The transport follows project avatars. Small resource checks and error strings remain local
so failures clearly identify a session picture rather than a project picture; encryption is
shared. The complete route set is not a trivial copy: session events, immutable local uploads,
rate-limit lifetime and deletion races have their own ownership here. We intentionally avoid
introducing a generic callback-based route framework in this change.

The descriptor, avatar revision and account sequence commit together. This deliberately
accepts Serializable transaction contention (with bounded retries) to preserve atomic event
ordering. Public-file protection in this change covers new session avatars only; it does not
change the existing project-avatar or attachment transport policy.
