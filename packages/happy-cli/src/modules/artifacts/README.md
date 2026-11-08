# Artifact versions (protocol 1)

The authenticated machine RPC owns versions; the relay never receives plaintext.
Session RPC exposes the same methods restricted to the session directory. A caller
must explicitly register an HTML/Markdown entry and its owned static resources.
Registration creates a baseline. No repository discovery or automatic registration
is performed. Limits and request/response schemas live in `happy-wire/artifacts.ts`.

History is private local data under `happyHomeDir/artifact-workspaces`. An account
scope is derived from server origin, stable account encryption identity and machine
ID. A machine-wide catalog and filesystem lock prevent two account/session services
from managing overlapping real paths. Immutable SHA-256 objects hold exact bytes;
the atomic catalog holds identities, manifests, operation results and journals.
Local disk encryption is not supplied by this feature.

Supported automatic runner: upgraded Paws Codex with a worker-owned spawned app-server on macOS/Linux. Shared app-servers and attached native threads are refused in managed scopes. It must await
`ApiSessionClient.withArtifactTurn` before dispatching a real turn and after its
terminal result. This leases the whole registered workspace, including unbound
runs whose declared cwd overlaps it. Unchanged successful turns add no version.
Cancelled/failed turns retain their baseline and leave modifications dirty. Original
Task 2 file-reference hashes are checked before execution. Arbitrary external shells
and undeclared writes are noncooperating writers; stop them before restoring.

Claude, Gemini and OpenClaw do not yet support automatic version capture. Their
upgraded entry points refuse registered scopes and durably mark their unregistered
scope while their process lives. Daemon inventory also rejects unknown/legacy
workers, including idle workers. No existing worker is stopped or upgraded here.
Other execution engines must implement the lease protocol before advertising it.
Windows execution hosts report unavailable.

`artifactRead` freezes a consistent working read without creating history. Resources
are read only through its immutable version/read reference. Dirty references expire
in 15 minutes and their reference metadata is trimmed on subsequent reads; historical
versions and content objects are never automatically deleted. Active writers and
pending journals return the last complete version. Explicit history reads do not
read current working dependencies.

Save, restore and same-directory rename persist objects and journal intent before
replacing any owned working file. The complete version, current pointer and operation
result are committed together in one atomic catalog replacement. Restore appends a
new version and preserves unrecorded preimages as external checkpoints. Rename
preserves artifact ID; moving an entry between directories or changing its format
requires a separate resource migration and is refused.

Multi-file writes are recoverable, not globally atomic for arbitrary external
programs. On partial failure inspect `artifactOperation` once by operation ID. A
user can resume or roll back with `artifactResolveOperation` and the observed
revision. Unknown third-party bytes block both actions; there is no force option.
If terminal capture itself fails, the ended lease becomes a durable capture-recovery operation. It offers a safe capture retry or explicit rollback to the last complete baseline. Startup leaves this decision to the user.
Service startup resumes only known journal pre/postimages with verified inventory
and no live writer. Locks verify PID plus process-start identity, never lease TTL. Writer leases also retain the native child process identity; an orphaned live child continues to block restoration.
An interrupted lock-reclaim guard fails closed for operator verification.

`fs.watch` observes atomic catalog replacements and emits bounded encrypted daemon
state invalidations; no business polling is added. Consumers refresh on a new event
and perform one read on reconnect/re-entry. Events can coalesce or be lost: RPC is
always authoritative. Task 4 supplies the history panel and version-preview UI.

Terminal results are handed off through owner-bound, immutable private receipts
before waiting for the machine lock. Waiting follows filesystem events with one
bounded timeout, without status polling. After a timeout, `artifactOperation` can
query the run ID; the next current read, mutation, operation query or startup
settles the receipt. A capture failure links to its own `pendingOperationId`.
Selected history, resource reads and history/catalog lists do not drain receipts.
Unmanaged turns retain concurrent execution and ordinary prompt sizes; their live
markers only prevent a new registration from racing an existing turn.

Capture recovery freezes the confirmed rollback preimages before recording a
resolution. Later external bytes are rejected rather than adopted into the
journal. A failed capture retry that has not started a rollback journal can be
replaced with a new resolution ID, including records from the earlier protocol-1
implementation. Missing legacy write targets are resolved through existing parent
directories before workspace ownership checks, and fallback uses that resolved
path so an alias cannot redirect the write after routing.
