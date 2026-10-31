# Media on this phone

Chat media (pictures, recordings, files, artifact files) is read into a
permanent per-account store once and never again, shows Telegram's
download ring and size badge while it isn't here, and streams from the
store while it arrives. Telegram-iOS's `MediaBox` is the reference
(GPL-2.0: the approach is reimplemented, never copied).

## Store

`MediaStore` (`Sources/HappyCore/Media/`) keeps one account's files:

| Account kind | Folder |
| --- | --- |
| Agent connection | `Application Support/Agents/<account>/media/`, beside the offline snapshot; removed with the connection (`OfflineFile.remove`). |
| Legacy (relay) account | `Application Support/Happy/accounts/<id>/media/`, beside `files/`; removed with the account's directory. |

- The folder is excluded from iCloud backup: everything in it can be read
  again from where it came from.
- A file's name is the first 16 bytes of SHA-256 of its ID, hex. IDs are
  the content's own, so a file is never read twice:
  - a tool call's media: `tool/<agentId>/<toolCallId>/<index>`;
  - an artifact version's file: `artifact/<artifactId>/<version>/<path>`
    (a numbered version never changes);
  - a legacy attachment: its `ref` (`sessions/<sid>/attachments/<uuid>.enc`).
- A complete file sits under its name. One still arriving is
  `<name>.part` (bytes at their own offsets, holes where nothing came) and
  `<name>.part.meta` (JSON: the ranges held and the whole length once an
  answer said it). The data is written before the record, so the record
  never names bytes that aren't there; a record naming bytes past the
  data's end, or one that doesn't parse, starts the file over. A new length
  means the file changed: what was kept goes.
- Nothing is evicted on its own (Steve: "forever"). Settings › Data and
  Storage shows the size and has Clear Media.
- A file the person sent is kept from the moment it uploads, under the ref
  the server gave it, so the sender never downloads their own file.

## Downloads

`MediaDownloads` is one actor per account (`MediaLibrary`):

- One reader per file. A whole-file read (`download`) goes on from where
  the last range ended, 1 MiB a request; a player's read (`read`) is
  served first, 256 KiB at a time from the first hole in what it asked.
- `pause` stops a whole-file read and keeps what came; `toggle` is the
  ring's tap. A relaunch resumes from the `.part` file.
- Automatic downloads run at utility priority, at most two at a time; a tap
  or a player lifts one past the queue. Three failed fetches in a row mark
  the file failed until the next tap; a 4xx (other than 408/429) fails at
  once.
- Progress goes to `DownloadBoard` under `<namespace>|<id>`. Screens drain
  it at most once a frame (`DownloadRings`), the way `UploadRings` drains
  `UploadProgressBoard`.

Sources, `MediaSource`:

- Agent connection: `GET /v0/agents/:id/tool-calls/:tcid/media/:index`
  and `GET /v0/artifacts/:id/versions/:n/files/*` with `Range`, over the
  paired transport. The daemon already answers `206`.
- Legacy: `POST /v1/sessions/:sid/attachments/request-download` gives a
  link (a 15-minute presigned S3 GET, or the server's own route with the
  account's token); ranges are `GET`s on it. `AttachmentLinks` keeps a link
  for 10 minutes and asks again on a 400/403. S3 answers `Range` with
  `206`. A server keeping files itself (`attachmentRoutes.ts`, local
  storage mode) ignores `Range` and answers the whole file with `200`,
  which `MediaPiece.http` takes as the whole file; nothing in the server
  needed changing.

## Legacy encryption and streaming

happy-app's `encryptBlob` is NaCl secretbox: `nonce(24) || MAC(16) ||
ciphertext`, XSalsa20 with a Poly1305 MAC over the whole ciphertext.

- XSalsa20 is a stream cipher: any plaintext range `[a, b)` is ciphertext
  `[a + 40, b + 40)` XORed with the keystream from byte `32 + a` (secretbox
  keeps the first 32 keystream bytes for the Poly1305 key). So ranges
  decrypt on their own (`BlobCipher.decrypt(range:nonce:key:offset:)`),
  given the nonce, which is the first 24 bytes.
- The MAC covers the whole file, so a range is unauthenticated until the
  file is complete. Options considered:
  1. Decrypt-to-disk progressively, stream from the plaintext prefix:
     still unauthenticated until the end, and it forces reads in order, so
     a seek waits for everything before it.
  2. Range-decrypt from the sealed partial file (chosen): seeks fetch only
     their range; the player gets plaintext straight from the sealed
     `.part`; once complete, the whole file is opened and its MAC checked,
     and only then is plaintext kept as the complete file. A MAC that
     doesn't check throws the file away (`MediaError.notAuthentic`) and the
     ring shows failed.
  3. Change the format to chunked AEAD (per-chunk MACs): would authenticate
     every range, but needs happy-app, the CLI and every client to agree.
     Not done; worth it if streaming unauthenticated bytes to the decoder is
     judged too risky.
- What option 2 means: until a file is complete, AVFoundation decodes bytes
  that could have been altered in transit or on the server. TLS covers
  transit; the server is the remaining party. Pictures are never shown
  before the MAC checks (they are read whole); only video streams early.

## The ring (`MediaRingView`)

One component for uploads and downloads, after Telegram's
`RadialStatusNode`:

| State | Drawn | Used for |
| --- | --- | --- |
| `.waiting` | short turning arc, cross | upload queued, or download of unknown size |
| `.progress(share)` | arc to `share`, turning, cross | upload or download going |
| `.failed` | retry arrow | either failed |
| `.download` | download arrow | not here, or paused |
| `.play` | play glyph | a video, ready to play |
| `.playing(share?)` | play glyph inside the arc | a video downloading |
| `.starting` | small turning arc | a video tapped, until its first range is here |
| `.done` | fades and shrinks away | finished |

`MediaRingView.Colors` is `.overMedia` (dark glass, white ink) on a tile
and `.onCard` (accent disc) on a file card's chip.
`MediaRingView.state(_ phase: DownloadPhase?, video:, starting:)` maps a download.
Layout is `UploadRingLayout` (disc, arc, cross) and `MediaStatusLayout`
(badge, arrow, play glyph), with exact-frame tests.

Where it shows:

- `ChatMediaView` (agent chat tiles, artifact galleries): the upload ring
  when `ChatMedia.upload` is set, otherwise the download ring and the badge
  (`MediaBadgeView`: a video's length, then the size or "1.2 / 8.4 MB").
  A tap on the ring sends `.toggleDownload(key)`; a video's badge does
  that, and the play button plays.
- The session profile's shared media (`SharedMediaCell`): the same
  `ChatMediaView`, filling its square (`fills`), reading from the
  profile's own `MediaLoader`. A tap on a picture not here yet reads it;
  anything else opens.
- `ChatFileStatusView` (file cards): the ring on the chip, the size or
  progress after the kind.
- `ChatAttachmentView` (legacy pictures and recordings): the ring and the
  size badge; a recording's first frame under the play button, its length
  in the badge.

## Playing a video

Telegram's way: a tap on the play button plays at once from what is on
the phone plus range fetches, never after the whole file.

- `MediaStream` is the `AVAssetResourceLoaderDelegate` behind a private
  `happy-media://` URL. Each loading request is answered from
  `MediaDownloads`: what is held goes at once, in pieces of up to 512 KiB;
  what isn't is a `read`, fetched first (256 KiB ahead of the hole). A seek
  is just a request at another offset, so it fetches only its own range.
  A legacy file is opened range by range on the way (above).
- `VideoOpening` runs the tap: it makes the player (which also starts the
  whole-file read at user priority, so a played video is kept), turns the
  tile's play glyph into a small spinner (`DownloadRings.setStarting`,
  ring state `.starting`) until the item is `readyToPlay`, which for a
  fast-start MP4 is its first range, then brings up `AVPlayerViewController`
  playing. A second tap while it spins gives up; a failure shows "file
  unavailable". It is used by the agent chat, the session's shared media
  and the legacy chat. Artifact videos play in the picture viewer's
  `VideoPage` from the same stream.
- The first frame and length are read through the same stream
  (`AVAssetImageGenerator`, `load(.duration)`): a few ranges, kept for when
  it plays. A player's reads alone don't count as downloading on the
  board, so the tile keeps its play button until a whole-file read runs.
- A legacy recording is told by the file event's `mimeType` when it has a
  video or picture type, else by its name (`mp4`, `m4v`, `mov`, `3gp`):
  happy-app sends recordings with neither a type nor a picture's shape.
  Its tile hits `.playAttachment` (the play button) and `.toggleDownload`
  (the badge).

## Automatic download

`MediaAutoDownload` (per device, `UserDefaults`): Photos on up to 10 MB,
Files on up to 1 MB, Videos off. One setting for every network; Telegram
splits Wi-Fi and cellular, which is not done here. Settings › Data and
Storage edits it.

When the computer answers again after a gap (the store's or home's
snapshot turns `live`), `MediaLoader.retryFailed` starts again the
automatic downloads that gave up while it was away and asks every tile
still without its picture to read it again, and `Images.retryFailed` does
the same for row, profile and story pictures (`MarkPicture`), so nothing
is left on its thumbhash or placeholder for good.
