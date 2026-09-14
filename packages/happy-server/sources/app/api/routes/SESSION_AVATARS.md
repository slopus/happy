# Session avatars

Session responses (v1 list/create-or-load and v2 lists) and `new-session` events
include optional, nullable `avatar: { ref, preview, version }`. Old servers may omit
it. `update-session` events include it only on change; `null` explicitly clears it.
The existing account event sequence orders changes, including removals.

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
