# Mandatory browser sandbox — S1 rework and fix2

The SDK spawn hook runs `/usr/bin/sudo -n -u agent-sbx
/usr/local/libexec/abp/claude-sbx-launch 0`. The launcher is installed **outside**
the Happy package, root-owned 0755 with root-owned, non-writable ancestors.
Owner-choice sessions retain their existing path. No runtime seccomp program or
socat relay is used by this mandatory path.

The one argv descriptor is stdin (fd 0): a JSON metadata field followed by NUL,
then exactly `argc` NUL-terminated arguments, then ordinary SDK stdin. The
metadata contains version 1, argc, cwd, env, denyRead, denyWrite and
networkBlocked. Total prefix limit: 4 MiB; argument limit: 65536. Sudo keeps only
stdio, so no closefrom override or temporary argv path is needed. The launcher
validates and consumes the same stream, reapplies its environment allowlist,
and passes argv to bwrap without a shell. Partial headers time out after 10 s;
truncated/malformed frames fail with exit 125. No tokens are put in logs or
sudo command-line arguments.

Bwrap creates user/PID/IPC/UTS namespaces, fresh proc/dev and private tmp, drops
capabilities, uses `--new-session` and `--die-with-parent`, mounts the root
read-only, and permits writes to the workspace and `/home/agent-sbx` only.
The supervisor kills bwrap on cancellation or loss of its sudo parent; death
of the PID namespace init kills detached/setsid descendants as well. UID
permissions are the security boundary; mounts reduce exposure in addition.
Read restrictions are normalized to outermost masks before any path inspection,
so private Happy descendants do not require inaccessible source binds. Covered
write binds are removed; write ancestors precede every read mask. Empty directory
masks are read-only as well, preserving write denial when both lists overlap.
Uncovered permission errors still refuse launch rather than being ignored.

Host `/run` is replaced with a private read-only mount. Only `/run/abp-mcp` is
bound back, read-only; explicit read restrictions are applied afterward and can narrow it.
Resolver, system/private D-Bus, nscd, broker, admin and Docker sockets under
`/run` (including the standard `/var/run` symlink) are absent. Persistent nscd
and SSSD directories are masked too. No host resolver socket is needed by Claude:
it connects to the numeric loopback HTTPS proxy, which resolves CONNECT targets.

Claude keeps authentication, refreshed credentials and transcripts in
`/home/agent-sbx/.claude`. Provision it as that user (S6 login procedure); Happy
does not seed credentials from the agent user's home. The Happy parent uses SDK
session events rather than reading or waiting on this private transcript, and
does not pass its inaccessible hook settings file to Claude. The normal SDK
stream still forwards remote output; host transcript scanners/local transitions
are not a supported source of sandbox session state.

## S6 installation interface and explicit additions to D1

1. Create `agent`, `agent-sbx`, `abp-proxy`, `abp-session`, `abp-work`. Only agent
   belongs to abp-session; agent-sbx may belong only to agent-sbx and abp-work.
   Agent also needs supplementary agent-sbx membership to chgrp its MCP sockets.
   `/home/agent` and `/home/agent-sbx`: respective owner, 0700. Workspaces must
   be `/work` or beneath it, shared abp-work group, setgid. This fixed workspace
   prefix is a conservative **additional restriction** beyond D1.
2. Install Node at `/usr/bin/node`, bwrap at `/usr/bin/bwrap`, sudo at
   `/usr/bin/sudo`, and the fixed launcher. All executable targets/ancestors must
   be root-owned and not group/world writable. Install the Happy package in a
   root-owned, readable location outside the private agent home and `/tmp`.
3. Sudoers (validate with visudo):

   ```sudoers
   Defaults:agent env_reset,!use_pty
   agent ALL=(agent-sbx) NOPASSWD: /usr/local/libexec/abp/claude-sbx-launch 0
   ```

4. **Contract addition:** live iptables reads need privilege not available to
   either unprivileged UID. Compile `scripts/agent-browser/abp-firewall-read.c`
   and install as `/usr/local/libexec/abp/abp-firewall-read`, root:abp-session
   **4750**. This small native reader takes no arguments, uses fixed absolute
   iptables-save/ip6tables-save executables with a clean environment, and only
   dumps the filter tables. It cannot mutate rules or execute caller-supplied
   commands. Do not authorize general sudo, grant CAP_NET_ADMIN to Node, or
   substitute a stale rules snapshot. This additional privileged component
   needs S6/security review before deployment.
5. Install the ordered OUTPUT prefix emitted by `firewallRules(4|6, sbxUid,
   proxyUid)` in `sandboxPreflight.ts`, **before every other OUTPUT rule**.
   Preflight compares the live prefix, so missing, reordered or shadowed rules
   refuse a session. IPv4 agent-sbx can originate TCP only to 127.0.0.1:3128;
   IPv6 agent-sbx is entirely rejected. Proxy can originate public TCP 443 only.
   **Necessary clarification:** proxy replies from loopback source port 3128
   to established loopback clients are allowed. These are responses to the
   listener, not a Runtime/API exception. Private/loopback/CGNAT/link-local,
   documentation, multicast and translation prefixes are denied before public
   allow rules; IPv6 permits only native 2000::/3 minus reserved ranges.
6. Run `node <package>/dist/sandbox/egressProxyMain.mjs` as **abp-proxy** under
   systemd, restart on failure. The entry refuses other users. It listens only
   on 127.0.0.1:3128. No Happy environment or credentials are needed. Its optional
   root-owned `/etc/aplus/claude-sandbox.json` holds exact `allowedDomains`; defaults
   are api.anthropic.com, claude.ai, platform.claude.com. Only CONNECT port 443 is
   accepted. Every resolved address must be public; the connection uses the
   validated numeric address without another DNS lookup. No HTTP forwarding,
   SOCKS, redirects or wildcard domains.
7. **Proxy-only resolver prerequisite:** public-443-only owner rules deliberately
   disallow direct DNS. Configure the **abp-proxy service's** glibc NSS resolver
   to use systemd-resolved's Unix interface (or root-managed static hosts).
   `dns.lookup` in the proxy uses that OS resolver before validating all answers
   and dialing a numeric address. Do not expose resolved, the system/private bus,
   nscd sockets or caches to `agent-sbx`, and do not add a DNS firewall exception
   for that UID. Claude uses HTTPS_PROXY; it needs no hostname resolver inside
   bwrap. Network-blocked sessions retain the same filesystem masks and also
   unshare the network namespace. The Linux harness runs real resolved, D-Bus
   and nscd against synthetic DNS; S6 still must validate the installed service.
8. `/run/abp-mcp`: agent:agent-sbx 0710. Happy creates per-session directories
   with the same owner/group/mode, and socket 0660. MCP uses a random session
   token and the stdio bridge connects directly over Unix HTTP. The bridge gets
   only SAYCODE_MCP_SOCKET and SAYCODE_MCP_TOKEN, no Happy credential variables.
   Registered tools remain change_title + the twelve browser_task tools;
   guessed shell/automation/legacy/lesson calls are rejected.
9. Mandatory Happy and AI credential staging uses passwd-home `.happy-staging`
   0700, and private per-spawn directories/0600 keys; TMPDIR cannot move it.
   Insecure or symlinked staging roots are refused. Agent home permissions
   protect credentials created after sandbox preparation. Non-mandatory staging
   keeps its existing location. Custom Happy homes outside the passwd home must
   themselves be private. Broker/admin/docker/stack permissions remain S6 duties.

Network-blocked sessions additionally use bwrap `--unshare-net`. A session
requesting custom/denied domains is refused rather than silently ignoring its
restriction: domain policy must be installed on the separate proxy. No writable
extra path can widen the `/work` boundary. Proxy unreachability, missing sudo,
bwrap, rule reader, identities, MCP permissions or firewall rules fail closed
with MandatorySandboxError before SDK query.

## Reproduction and evidence (2026-09-25)

From `packages/happy-cli`:

```sh
pnpm typecheck
pnpm exec vitest run --project unit src/sandbox src/claude/utils/mandatoryMcp.test.ts src/claude/utils/startHappyServer.test.ts src/claude/utils/path.test.ts src/claude/utils/claudeCheckSession.test.ts src/claude/claudeRemote.test.ts src/claude/claudeRemoteLauncher.test.ts src/claude/claudeRemoteManagedBoundary.test.ts src/claude/sdk/query.test.ts src/daemon/stageUserCredentials.test.ts src/daemon/stagedCredentialRoot.test.ts src/daemon/aiCredentialRuntime.test.ts --cache=false
BUILDX_CONFIG="$PWD/.s1-buildx" docker build -f scripts/sandbox-linux-smoke.Dockerfile -t abp-s1-fix2-test .
docker run --rm --privileged --name abp-s1-fix2-test --mount "type=bind,src=$PWD/../..,dst=/w,readonly" abp-s1-fix2-test
```

Verified: pnpm typecheck passed; the standard unit command passed **392 tests
across 23 files**, with one existing platform skip. The build passed with its
existing bin/chunk warnings. The ARM64 container integration exited 0 with all
assertions above passing (run after the unit build, not concurrently with it).
git diff --check passed.

Vitest's normal global setup builds the package. The disposable container uses
OrbStack ARM64, three distinct UIDs, sudoers, owner rules in its **own** network
namespace, bwrap and a read-only source mount. It does not mount the Docker socket,
use the user's daemons, make production deployments, or use real credentials.
Buildx state is kept local to this worktree.

Fix2 first reproduced six failing Linux cases on `01d323e8`: the complete
`buildSandboxRuntimeConfig(..., 'mandatory')` deny lists forwarded exactly like
`claudeRemote`, three read/write overlap shapes, and resolved access in both
network modes. The production `/bin/true` probe now passes with `/home/agent`
0700 under real `agent`/`agent-sbx` UIDs, while original and staged credentials
remain unreadable. Directory canaries cover identical paths, read-parent and
write-parent overlaps; explicit MCP read denial and uncovered EACCES also have
regressions. All nine targeted regression cases pass.

Resolver tests first prove host resolution succeeds via getaddrinfo, direct
Varlink and D-Bus. Inside both production-configured `allowed` and `blocked`
sandboxes, direct Varlink, system/private bus, nscd (including `/var/run`),
`busctl ResolveHostname`, `resolvectl query` and getaddrinfo of the unapproved
fixture hostname fail. Resolved, system D-Bus and nscd are real services; the
systemd-private socket is a world-connectable canary because this container
does not boot systemd PID 1. The normal proxy refresh and MCP tests still pass.
The harness-only Debian resolver packages introduce no application dependency.

The integration also asserts eight genuinely concurrent launches, malformed/truncated
argv refusal, late credential staging despite TMPDIR=/work, private/loopback and
direct public TCP denial, allowlisted hostname resolving to 127.0.0.1 rejection,
authenticated MCP with exactly 13 tools, the packaged happy-mcp stdio bridge,
raw `socket(0x100000001, ...)`, cross-UID ptrace denial, and cancellation of
setsid descendants (host PIDs gone/zombie plus stopped heartbeat). A second raw
syscall/credential/ptrace check runs **without bwrap or seccomp**, demonstrating
permission denials rather than inferring them from masked paths. Deleting a live
IPv6 rule causes application preflight to refuse startup.

Synthetic refresh is an actual HTTPS POST to the pinned CLI refresh path
`https://platform.claude.com/v1/oauth/token` through CONNECT, against a TLS fixture
bound to a public-address alias inside the disposable netns. The fixture accepts
an old synthetic refresh token, returns rotated synthetic tokens, and the dummy
provider atomically writes state that the next spawn reads. This does **not**
claim an authenticated Claude OAuth refresh or real model turn. x86_64 and a
systemd-installed execution machine have not been exercised here. GD1/GD6 and
the broader S9 acceptance gates remain deployment-stream work.

Fix2 remains uncommitted at the user's instruction (base `01d323e8`). Changes
are limited to the launcher, sandbox unit tests/docs, and Linux harness scripts.
No protocol or authoritative contract change is needed. Private runtime mounts
and read-only empty masks strengthen D1. No new npm dependency was added; host
NSS support is required only for the proxy service, not for agent-sbx.
