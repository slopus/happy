# Local session folder write approval (source candidate)

macOS and namespace-capable Linux Desktop-owned standalone daemons advertise sessionWriteScope.version=1 to newly marked protected Codex and Claude remote sessions. This source candidate is not a published CLI or Desktop pin. Mandatory shared machines, Claude local, legacy/external/cloud/Windows/checkpoint/credential-staged sessions are unsupported. Linux packaging and remote host approval are separate acceptance work.

## Authority and lifecycle

Desktop main keeps an incarnation-specific Ed25519 private key in memory; only public bootstrap reaches the daemon. The daemon owns immutable requests/digests. Human decisions bind account/machine/session/incarnation/request/digest. The shared loopback bearer never proves approval.

session_write_scope exposes request/list/cancel, without approve or command execution. Requests contain a short secret-free description and narrow absolute folder. Canonical existing parent, dev/ino, protected floor, previous roots and expiry are rechecked before replacement. Home/root/protected grants are refused; existing sandbox deny/read/network/mandatory policy remains. Children inherit it.

Approval consumption is journaled before async work. One replacement preserves original config/encryption/cursor and uses the existing authenticated launch drain: freeze input, finish provider EOF/output, confirm storage and acknowledge the final frozen cursor at the daemon. It then awaits actual owned ChildProcess exit without using a best-effort SIGTERM as preservation proof. Live-child resume no-op cannot acknowledge application. Roots/expiry are validated immediately before spawn. Real sandbox/app-server initialization must post a token/digest/session/PID receipt for profileApplied.

Marked launches report with an independent launch secret on inherited FD 3. The parent consumes/closes it before providers/MCP. The same private pipe separately carries the authenticated drain bootstrap, without giving that credential to provider environments. Signed whole body/kind/session/PID/expiry/increasing sequence prevents shared-bearer forgery. Exit revokes report authority; restored marked sessions without launch authority fail closed. This is not descendant termination evidence.

Marked parents do not expose privileged bash_stream/script automations/raw browser tools. Checkpoint sessions remain unmarked to preserve their existing writer contract.

## State and recovery

pending → applying → applied | failed | cleanup-unresolved, with cancelled/project-local/expired alternatives. profileApplied confirms the replacement; grantActive describes memory roots. Root exit/command completion never proves full revocation. Stop/receipt uncertainty stays cleanup-unresolved. Reviewed revoke removes future reuse and resumes baseline/remaining roots; installed files are preserved.

session-write-scope.json holds bounded owner-only public evidence using private temporary file/fsync/atomic rename/directory fsync. No key/permit/grant is restored. Restart expires pending, preserves uncertain application and resets grantActive. ACK loss is reconciled by list, without automatic reapplication.

Broker/journal initialization failure disables approval support while allowing ordinary daemon startup. It never grants write access or falls back to an unprotected launch.

## Validation and release

Related unit tests cover signatures/replay/expiry/intent failure, paths/replacement/lineage/report authority/control/Codex/MCP admission. Actual macOS tests verify approved and inherited child writes, denied siblings/symlinks/credentials and revoked new profile. Native Codex tests use isolated homes and initialize/EOF without model turns.

HAPPY_SCOPE_NATIVE_CODEX=1 pnpm exec vitest run --project unit src/daemon/sessionWriteScopeRuntime.test.ts exercises actual control server/authenticated owned parent/native sandboxed provider/receipt for allow/replay/forgery/revoke. Preserve/resume/storage callbacks assert fixture identity/cursor, not real server encrypted-transcript reconnect. Provider EOF, authenticated drain release, owned root exit and protected profile receipt are actual native paths. That smoke and published artifact install/rollback plus Desktop pin acceptance remain release work. Source validation does not publish/change pins/replace a running user daemon.

## Claude and Linux source extension

Claude consumes the report/drain pipe and takes confirmation material before any provider/MCP transport. One immutable outer OS boundary covers every SDK generation. It performs native SDK control initialization without a model turn, closes the probe input, verifies actual exit, then acknowledges the prepared profile. Subsequent generations use the same protected spawn; switching to local is refused. The existing authenticated Claude drain additionally requires the frozen cursor daemon ACK for these launches.

Linux capability requires an actual user/pid/network namespace probe with /usr/bin/bwrap; each provider independently verifies execution through its exact profile. Failure disables support. Mandatory machine policy keeps its existing UID/managed enforcement path. Actual isolated Linux tests cover native Claude initialization, pre-grant denial, allowed/inherited writes, denied sibling/symlink writes, unchanged host credentials/unreadable original contents, and revoked new profile denial. Linux read-denied directories are private tmpfs, so shadow writes can succeed without changing the host credential; errno alone is insufficient evidence. Native Linux Codex initialization and EOF exit 0 passed for baseline/allow/revoke profiles. The capable test container supplied namespaces explicitly; an ordinary container confirmed support=false. Neither path is a product fallback or deployment.

Native tests can be selected with HAPPY_SCOPE_NATIVE_CLAUDE=1 and HAPPY_SCOPE_NATIVE_CODEX=1; Linux additionally needs HAPPY_SCOPE_NATIVE_LINUX=1 and actually working namespace prerequisites. Runtime/control preserve/resume/storage remain fixture callbacks. Windows support remains disabled. The approved Desktop AppContainer+Job fixture prototype failed native acceptance: an inheritable SID ACE propagated through a hardlink to the fixture credential inode; Codex initialization and descendant/loopback acceptance were also incomplete. No Windows product backend or v2 DTO was integrated. Native evidence does not prove published artifact installation or server transcript reconnect.


## PR integration verification (2026-10-03)

The source work was committed as 8850cfa97 and integrated with current origin/main bccc390c7. Conflicts in scope MCP registration, launch bootstrap and daemon imports preserve both scope enforcement and the new bounded Codex host recall. Related tests after integration passed: 22 files/844 tests including native Codex/Claude and OS/control receipt paths; five drain/producer direct-consumer files/59 tests. Vitest global setup completed TypeScript and pkgroll builds. No global install, tag, publish, provider model turn, production server transcript smoke or Desktop scope release pin was performed. Untracked dependency symlinks are not committed.

The subsequent origin/main 11f3126f1 integration preserves encrypted machine RPC admission, owner-only key material, and one-time reconnect data-key consumption alongside the scope launch bootstrap. Related API/RPC/persistence/reconnect/runner/scope tests passed: 330 tests (two opt-in native cases initially skipped). An explicit native-enabled follow-up passed all nine tests across OS enforcement, Codex/Claude initialization and owned runtime/control allow/revoke. TypeScript/pkgroll setup builds passed; existing bin/empty-chunk and asynchronous rejection-handling warnings remain. These counts include overlapping scope checks and are not a unique full-suite total. Review in [Happy PR #669](https://github.com/buzzni/happy/pull/669) and [Desktop PR #1334](https://github.com/buzzni/aplus-dev-studio-desktop/pull/1334); release and real-server acceptance remain incomplete.

## Self-review corrections (2026-10-03)

- Missing protected paths now resolve existing symlink ancestors while retaining the absent suffix. A future keyring beneath an approved directory is refused even before creation; dangling protected aliases fail closed. Regression tests reproduced the previous lexical fallback admitting that root.
- The broker rechecks its eight-root limit at approval application, including requests prepared before any grant, and only marks successfully applied grant records active. Cancelled/project-local requests at a later-granted root no longer acquire misleading active/revoke UI state.
- Mandatory/shared MCP endpoints no longer advertise the unsupported scope tool. Explicit Desktop-owned scope launches retain request/query/cancel despite their mandatory provider profile, while privileged parent tools remain absent; both boundaries have transport tests.
- The initial macOS CI run failed the mandatory tool contract and OS test's missing ripgrep prerequisite. The workflow now installs/verifies ripgrep before native sandbox unit tests; YAML/step validation and local native enforcement passed. Remote verification of the updated workflow is pending, not a local CI success claim.
- Relevant native-enabled broker/path/journal/restart/runtime/OS/provider tests: eight files/32 passed. MCP transport/registration: two files/27 passed. Setup TypeScript/pkgroll builds passed. No new UI layout, public DTO, release pin, deployment or real-server acceptance was added.

### Revocation review follow-up

Revocation previously re-canonicalized the granted path and revalidated the root being removed, so deleting/replacing that directory could prevent withdrawal; failure on a different retained root also left the withdrawn future grant reusable. Revocation now binds the exact saved in-memory grant descriptor, removes it before validating remaining roots, and never grants the path's current filesystem target. Grant admission still requires canonical identity/floor checks. An old revocation cannot remove a subsequently replaced grant record. Root exit and old descendants still do not establish full cleanup.

Regression cases reproduced missing/replaced-directory revocation failures and retained-root validation failure before the fix. The updated native-enabled broker/path/restart/OS/runtime set passed five files/31 tests, including actual macOS Codex/Claude allow/revoke receipt paths. A final broker run passed 15 tests after adding stale-revocation coverage; the source implementation was unchanged between those passes. TypeScript/pkgroll setup builds passed. This review adds no provider/platform/release support; updated remote CI remains separate evidence.


### Daemon bootstrap and journal admission review

`startDaemon()` now snapshots only `HAPPY_WRITE_SCOPE_HOST_*` before removing inherited session lineage. The runtime receives that private snapshot; spawned children still inherit an environment without the host bootstrap. The earlier native runtime tests constructed their own bootstrap and missed this daemon-start wiring failure. A new startup regression enters the real `startDaemon()` through runtime/control-server initialization, with authentication, system registration and transport startup mocked.

The 128-request admission limit now counts pending/applying work rather than daemon-lifetime history. Admission is serialized and publishes an entry only after its creation snapshot is durable. A failed creation leaves no visible/approvable phantom request or consumed slot. Snapshot writes are separately serialized and read current state at their turn, preventing concurrent cancellation from overwriting a newly admitted request.

Broker queries/admission and journal recovery/writes retain at most the newest 128 ordinary terminal records, reducing that history further to fit the 512-record budget. Pending/applying/applied, active grants and cleanup-unresolved evidence are not aged out. This follows the existing no-hidden-uncertainty contract; it is not a promise of unlimited approvals. If safety evidence alone reaches 512 records or the retained snapshot exceeds the recovery reader's 1 MiB limit, creation fails closed with `SCOPE_JOURNAL_SAFETY_LIMIT_REACHED`, without replacing the previous journal or publishing the new request. Deleting older unresolved evidence requires a separate explicit retention decision. No old grant or approval is restored from recovery.

Failing regressions reproduced the bootstrap scrub, lifetime admission cap, phantom request, stale concurrent snapshot, unpruned 512-record ordinary history and oversized unrecoverable write. Final native-enabled validation passed nine files/68 tests, including actual macOS Codex/Claude owned runtime/control allow/revoke receipts and OS enforcement, plus MCP consumers. Vitest setup TypeScript/pkgroll builds passed; existing bin/empty-chunk warnings remain. The previous Happy head's five smoke jobs passed and Desktop PR #1334 was merged after its verify check passed. The new Happy head's remote CI must be checked separately. Windows product support, real-server transcript/reconnect acceptance and release/pin activation remain incomplete.


### macOS merge-head CI recovery

The macOS job for head 3368e7f7b ran the PR merge with main 2b9f283d6. Its only failing test was the new daemon bootstrap fixture: the mocked authentication returned a token without `encryption`, while main's new machine-control startup reads `credentials.encryption.type` before scope runtime creation. Head-only local checks did not exercise that combined startup. Merging current main 3671f2ea4 locally reproduced the exact undefined-type failure.

The fixture now supplies a complete, never-escrowed dataKey credential and a null server key, statically checked against the authentication function's actual return type. It asserts the deliberately mocked control-server failure as the only fatal startup reason before checking bootstrap delivery and child-environment scrubbing. An unrelated early exit can no longer masquerade as the expected fixture stop. The real machine-control and scope startup paths remain enforced; no CI job or assertion was skipped.

Node 24 validation after main integration passed 11 CLI files/396 tests, then seven direct/native files/66 tests including actual macOS Codex/Claude receipt and OS boundaries. Wire and CLI TypeScript/pkgroll builds passed; existing bin/empty-chunk warnings remain. Updated remote CI is tracked separately from local validation. The journal safety-cap and source/release limitations above are unchanged.
