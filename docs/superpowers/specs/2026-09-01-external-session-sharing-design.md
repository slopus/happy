# External Session Sharing Design

## Summary

Paws Share will let Codex CLI and Claude Code users publish a complete,
read-only conversation snapshot without installing the Paws App or creating a
Paws account. A lightweight Node CLI converts the provider's local transcript
into the existing public-session snapshot contract, uploads every resolved
attachment through the existing atomic draft pipeline, and prints a public URL.

Anonymous ownership is capability based. The CLI generates a 256-bit management
token locally, sends it only over HTTPS to management endpoints, and stores it
with mode `0600` in the user's Paws Share home. The public URL never contains the
management token. Possession of the token authorizes status checks, renewal,
replacement, and revocation; losing it is intentionally unrecoverable.

The public page continues to use the same read-only conversation renderer. It
does not render authenticated navigation, capability panels, a composer, or any
session mutation. Existing account-owned Paws sharing remains compatible.

## Goals

- Publish Codex and Claude Code local sessions without a Paws account.
- Provide both a terminal CLI and a portable Agent Skill that invokes it.
- Preserve text, thinking, tool calls, tool results, and structured attachments.
- Reuse the current atomic draft, attachment, public read, and renderer paths.
- Make anonymous shares revocable and renewable using a local management token.
- Detect likely secrets and unresolved attachments before plaintext leaves the
  machine.
- Deliver a packed CLI artifact and a recorded isolated E2E covering publish,
  anonymous viewing, attachment playback/download, and revocation.

## Non-goals

- A Web-only transcript importer in the first release.
- Paws account registration, OAuth, billing, team ACLs, or viewer identities.
- Live synchronization after publication.
- Continuing, forking, commenting on, or editing a public conversation.
- Guessing arbitrary file paths from prose and uploading them automatically.
- Supporting every historical Codex or Claude transcript variant in v1.
- Publishing the npm package or deploying server changes without the repository's
  normal release and merge gates.

## User Experience

### Direct CLI

The package is `@wangjs-jacky/paws-share` and its binary is `paws-share`.

```text
npx @wangjs-jacky/paws-share share --current
paws-share share --source codex --session <id-or-path>
paws-share share --source claude-code --session <id-or-path>
paws-share list
paws-share revoke <public-id>
paws-share renew <public-id>
paws-share install-skill --target all
```

`share --current` examines recent Codex and Claude Code transcripts for the
current working directory. It publishes automatically only when one candidate
is unambiguous. Ambiguity fails closed with a compact candidate list; it never
silently shares the newest unrelated conversation.

Before upload, the CLI prints the selected provider, title, message count,
attachment count and bytes, unresolved attachment count, secret-scan result,
and expiry. Interactive use requires confirmation. Agent use passes `--json`
and `--yes` only after the agent has shown the same disclosure and received an
explicit public-sharing instruction. High-confidence secrets and unresolved
attachments remain blocking even with `--yes`; overriding them requires the
separate `--allow-sensitive` or `--exclude-attachment` choices.

Successful JSON output contains `publicUrl`, `publicId`, `expiresAt`, source,
counts, and a local record ID. It never prints the management token. Human
output prints the public URL and the local location used for future management.

### Agent Skill

The packed package includes one provider-neutral `SKILL.md`. `install-skill`
copies it into detected Codex and/or Claude Code skill roots. The skill:

1. identifies the current provider and working directory;
2. invokes `paws-share inspect --current --json`;
3. reports the disclosure and any blockers;
4. after the user says to share, invokes `paws-share share --current --yes --json`;
5. returns only the public URL and expiry.

The skill does not parse transcripts, read tokens, upload bytes, or implement a
second protocol. All security-sensitive behavior remains inside the CLI.

### Management

The CLI stores records in `${PAWS_SHARE_HOME:-~/.paws-share}/shares.json` using
an atomic write and file mode `0600`. Each record contains server URL, public ID,
management token, source, title, timestamps, and expiry. `list` redacts the
token. `revoke` is idempotent. `renew` extends the expiry by another 90 days.

## Approaches Considered

### Chosen: capability API plus standalone CLI

This gives non-Paws users the least friction, keeps account credentials out of
the flow, and makes adapters independently testable. The existing public page
and storage pipeline remain the system of record.

### Rejected: create hidden Paws accounts and sessions

Synthetic accounts avoid a schema change but corrupt domain ownership, weaken
quotas, and make capability revocation dependent on fake session records.

### Deferred: Web upload portal

A browser cannot reliably resolve local transcript-relative attachments, active
session files, or provider stores. It would need a desktop bridge or accept
lossy exported archives, so it does not replace the CLI in v1.

## Shared Snapshot Contract

The snapshot schema moves to `happy-wire` so the App, server, and CLI validate
the same contract. Version 1 gains optional display-safe source metadata:

```ts
type PublicSessionSnapshotV1 = {
    version: 1;
    title: string;
    sharedAt: number;
    source?: { provider: 'paws' | 'codex' | 'claude-code' };
    presentation?: { groupToolCalls: boolean };
    messages: PublicSessionMessageV1[];
};
```

No raw provider session ID, working directory, hostname, username, absolute
path, environment value, or credential enters the snapshot. The public header
may display only the provider label and snapshot time.

## Provider Adapters

Both adapters implement one interface:

```ts
interface TranscriptAdapter {
    discover(input: DiscoveryInput): Promise<TranscriptCandidate[]>;
    inspect(candidate: TranscriptCandidate): Promise<TranscriptInspection>;
    convert(candidate: TranscriptCandidate): Promise<ConvertedSnapshot>;
}
```

### Codex

The Codex adapter reads JSONL under the configured `CODEX_HOME` session stores.
It recognizes session metadata, user/assistant messages, reasoning summaries,
function calls, function outputs, and structured image/file references. It
ignores token accounting and provider control events. It selects the newest
complete view of a resumed thread and removes duplicate response items by
stable provider IDs.

### Claude Code

The Claude Code adapter reads local project JSONL stores. It recognizes user and
assistant content blocks, thinking blocks, tool use, tool results, summaries,
and structured file/image references. Resumed files that already contain full
history are treated as complete snapshots; parent copies are not concatenated.
UUID ancestry orders messages and suppresses duplicated resumed history.

### Attachments

Adapters resolve only structured attachment blocks and explicit `--attach`
arguments. Paths must resolve to regular files, remain within an adapter-declared
allowed root or an explicitly approved path, and pass size/type checks. Missing
or unreadable referenced attachments block publishing. The CLI never scrapes
arbitrary Markdown or shell output for path-looking strings.

## Capability-Owned Data Model

`PublicSessionShare` becomes ownership-neutral:

- `accountId` and `sessionId` become nullable for capability-owned shares;
- `managementTokenHash` is nullable and unique;
- `createRequestId` is nullable and unique for anonymous idempotency;
- `sourceProvider` records `paws`, `codex`, or `claude-code`;
- `expiresAt` is nullable for account shares and required for anonymous shares.

Exactly one ownership mode is valid:

1. account share: `accountId + sessionId`, no management hash; or
2. capability share: management hash, no account/session.

The service validates this invariant on every write. Existing rows remain
account-owned and non-expiring. Draft and asset models remain shared, preserving
atomic publication and cleanup behavior.

The Prisma schema change is prepared with generated client types. Applying a
production migration remains part of the normal server deployment process; no
developer command mutates the production database.

## Capability API

All management requests use:

```text
Authorization: PawsShare <256-bit-token>
```

The server stores only `SHA-256(token)` and compares fixed-size hashes with a
constant-time primitive. Request and error logs never contain the header,
snapshot body, public URL, or transcript text.

Endpoints:

- `POST /v1/external/session-shares/drafts`
- `POST /v1/external/session-shares/:shareId/drafts`
- `GET /v1/external/session-shares/:shareId`
- `POST /v1/external/session-shares/:shareId/drafts/:generation/assets`
- `PUT /v1/external/session-shares/:shareId/drafts/:generation/assets/:assetId`
- `PUT /v1/external/session-shares/:shareId/drafts/:generation/publish`
- `POST /v1/external/session-shares/:shareId/renew`
- `DELETE /v1/external/session-shares/:shareId`

Creation requires an `Idempotency-Key` UUID. The CLI generates the management
token and request ID before the first request, so a lost response can be retried
with the same credentials. Preparing and uploading an identical asset is
idempotent when its size and hash match. Publishing the same generation and
snapshot digest returns the prior result. Revoke remains idempotent.

Public read endpoints and URLs do not change. Expired capability shares resolve
through the same generic not-found path as revoked and unknown links.

## Limits and Abuse Controls

Anonymous v1 limits are deliberately lower than authenticated Paws shares:

- 20,000 messages and 10 MiB serialized snapshot;
- 50 attachments;
- 50 MiB per attachment and 200 MiB total;
- 90-day lifetime, renewable with the management token;
- bounded pending drafts and bytes per capability;
- strict create/write rate limits by normalized client IP and capability hash;
- public-read rate limits and existing `no-store`/`noindex` headers.

Creation rate limiting happens before database or object allocation. Expired,
superseded, failed, and revoked generations use the existing durable cleanup
worker. A scheduled pass marks expired shares unavailable before removing
objects.

## Secret Scanning

The CLI scans snapshot text, tool bodies, attachment names, and small textual
attachments for high-confidence credentials: private key blocks, common vendor
token prefixes, bearer tokens, credential assignments, and `.env`-style secret
values. It also warns about absolute home paths, hostnames, email addresses, and
IP addresses without blocking them.

The scanner returns structured findings with message/block locations and never
prints the full secret. High-confidence findings block by default. The explicit
`--allow-sensitive` flag records only that an override occurred; it does not
upload scanner diagnostics.

## Error Handling and Recovery

- Transcript ambiguity, an actively changing file, secret findings, and missing
  attachments fail before draft creation.
- The adapter records the source file size and mtime before and after conversion;
  a change retries once, then asks the caller to retry after the turn settles.
- Network failures retry idempotent requests with bounded exponential backoff.
- A failed upload leaves a private expiring draft and keeps the local token so a
  later invocation can resume or replace it.
- A failed update never replaces the prior active generation.
- A lost local management token has no server-side recovery path.
- Revoked, expired, malformed, and unknown public IDs are indistinguishable.

## Package and Release Boundaries

`packages/paws-share` is a Node 20/24 TypeScript package with no dependency on
the full Paws CLI or daemon. It uses built-in fetch, crypto, filesystem APIs,
Commander, and the shared wire schema. Importing its library entry has no I/O or
CLI side effects.

The packed artifact contains `dist`, `bin`, the provider-neutral skill, and
package metadata. Verification installs the tarball into a clean temporary
project, runs help/version, parses both provider fixtures, publishes to an
isolated server, and checks that no management token appears in stdout logs.

Registry publication is a separate release operation. This feature delivers a
release-ready tarball and checksum but does not claim npm availability until the
exact registry version is independently installed and verified.

## Testing and E2E Acceptance

Unit tests cover provider discovery, current-session ambiguity, transcript
conversion, resumed history deduplication, tool pairing, attachment resolution,
secret scanning, atomic key-store writes, permission modes, API retries, and
token redaction.

Server tests cover ownership invariants, token hashing and constant-time auth,
idempotent creation/upload/publish/revoke, anonymous quotas, expiry, public
not-found equivalence, and unchanged account-owned routes.

The recorded isolated E2E:

1. creates a temporary Codex fixture and Claude Code fixture with a generated
   media attachment;
2. installs the exact packed CLI artifact into a clean temporary project;
3. publishes both fixtures without an account;
4. opens each public URL in an anonymous 1280x720 browser;
5. verifies the shared renderer, source label, tool grouping, attachment bytes,
   and absence of left/right panels and composer;
6. revokes one share using only the local management record;
7. verifies the page and attachment become unavailable;
8. removes the isolated environment and retains the MP4, screenshots, CLI log,
   tarball checksum, and Playwright trace.

## Delivery Sequence

1. centralize the shared snapshot schema;
2. generalize server ownership and capability authentication;
3. implement Codex and Claude Code adapters;
4. implement inspect/share/list/renew/revoke and local storage;
5. package and install the portable Agent Skill;
6. complete unit, server, package, and recorded E2E verification;
7. perform independent security and product review;
8. push the branch and create a PR with stable evidence.

## Acceptance Criteria

- A machine without a Paws account can publish Codex and Claude Code fixtures.
- The public URL renders through the existing read-only transcript and supports
  the fixture attachment.
- No account token or management token appears in the public URL, snapshot,
  command output, Web page, or ordinary logs.
- The local management record can query, renew, replace, and revoke its share.
- Missing attachments and high-confidence secrets cannot be silently published.
- Existing authenticated Paws sharing behavior and links remain green.
- The exact packed CLI artifact passes clean-install verification.
- The requested E2E MP4 is valid, maps to the automated Case, and is delivered
  with the PR and final handoff.
