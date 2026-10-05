# Agent Browser execution machine (H): install and operate

Saydo `specs/agent-browser-deploy` D11 (stream S6). These scripts turn a clean Linux machine
with systemd and Docker into execution machine H: Happy daemon as `agent`, Claude as
`agent-sbx` inside the S1 sandbox, the CONNECT proxy as `abp-proxy`, and the Browser Runtime
plus one browser per profile in Docker. Everything is root-only. The feature stays off until
the Saycode server flag is on (S7); nothing here changes the server or Desktop.

| File | Role |
|---|---|
| `abp-install` | install, update (idempotent re-run) and `check`; `--dry-run` prints every action |
| `abp-stack.mjs` (installed as `/usr/local/sbin/abp-stack`) | `up`, `down`, `status`, `upgrade`, `rollback`, `rotate-keys`, `set-principal`, `migrate-legacy-profile`, `delete-profile-volume`, `load`, `build`, `run` (systemd only) |
| `abp-uninstall` | remove services; keeps volumes, config and secrets unless `--purge` |
| `abp-firewall` | owner firewall rules (`apply`, `check`, `remove`), run by `abp-firewall.service` |
| `abp-plan.mjs`, `lib/abpPlan.mjs` | every generated file, table and container argument (unit-tested) |
| `images/` | production Runtime and browser images; `seccomp/` Chromium seccomp base |
| `claude-sbx-launch`, `abp-firewall-read.c` | from the sandbox stream (S1); required next to `abp-install` |

## What gets installed

| Item | Owner, mode | Notes |
|---|---|---|
| users `agent`, `agent-sbx`, `abp-proxy`; `abp-runtime` (uid 10870), `abp-browser` (uid 10871) | | container ids are reserved on the host so no login user shares them |
| groups `abp-session` (only `agent`), `abp-work` | | `agent` ∈ abp-session, abp-work, agent-sbx and **not** docker; `agent-sbx` ∈ agent-sbx, abp-work only |
| `/etc/abp` | root 0700 | `install.json` (options, 0600), `runtime.json` (0600), `happy-daemon.env`, `firewall.rules{4,6}`, `seccomp-chromium.json` |
| `/var/lib/abp` | root:abp-session 0710 | `daemon-token` (agent 0400), `secrets/runtime/vnc-password` (abp-runtime:root 0440), `secrets/browser/vnc-password` (abp-browser 0400), `stack-state.json` (digests, 0600) |
| `/run/abp`, `/run/abp-mcp` (tmpfiles.d) | root:abp-session 0750; agent:agent-sbx 0710 | broker socket 0660 root:abp-session and admin socket 0600 root are created by the Runtime |
| `/home/agent`, `/home/agent-sbx`, `/work` | owner 0700; agent:abp-work 2770 | workspaces must be under `/work` (S1) |
| `/work/agent-workspace`, `/home/agent/workspace` → it | agent:abp-work 2770 + default ACL `g:abp-work:rwX`; symlink owned by agent | see "Agent workspace" below |
| `/usr/local/libexec/abp/` | root 0755 | `claude-sbx-launch` 0755, `abp-firewall-read` root:abp-session **4750**, `abp-firewall`, `abp-stack.mjs` |
| `/etc/sudoers.d/abp-agent-sbx` | root 0440, `visudo -c` | `agent ALL=(agent-sbx) NOPASSWD: /usr/local/libexec/abp/claude-sbx-launch 0` |
| `/etc/aplus/sandbox-policy.json` | root 0644 | `{"mode":"mandatory"}`; `claude-sandbox.json` only with `--egress-domain` |
| `/opt/abp/happy` (`--happy-prefix`) | root, not group/world writable | Happy package; `/usr/local/bin/happy` links to it |
| systemd | | `abp-firewall` (oneshot, before everything: owner rules + fence chain) → `abp-egress` (oneshot after and PartOf Docker: browser egress rules) → `abp-egress-proxy` (User=abp-proxy), `abp-stack` (Requires firewall + egress, `flock -n -F` so node gets SIGTERM, Restart=always), `abp-happy-daemon` (User=agent, `happy daemon start-sync`/`stop`, KillMode=process) |
| Docker | label `ai.saycode.abp=stack` | per profile: network `abp-net-<profile>` on bridge `br-abp-<8 hex>` with the i-th /24 of `--browser-subnet-pool` (default 10.249.240.0/20; gateway .1, browser .2, Runtime .3), only that browser + Runtime; volumes `abp-state` (journal, agent key, flock) and one browser volume per profile **and owner**, `abp-profile-<profile>-<16 hex of sha256(owner)>` (labels `role=profile`, `profile`, `principal`) |
| locks | | `/run/abp-stack.lock` (one `abp-stack run`), `/run/abp-stack-ops.lock` (one of abp-install, upgrade, rollback, rotate-keys, set-principal, up/down at a time) |

Only the Runtime API is published, on `127.0.0.1:38700`. Admin (unix socket), CDP, x11vnc and
noVNC are never published. The Runtime starts as root with only SETUID/SETGID
(`--cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges`), reads
the root-only config, binds the sockets and drops to uid 10870; a second Runtime on the same
state volume exits 75 (writer flock). Browsers run with `--cap-drop ALL`, no-new-privileges,
read-only root and **Chromium's own sandbox on** (no `--no-sandbox`) under
`/etc/abp/seccomp-chromium.json` = Docker's default profile (vendored, see `seccomp/NOTICE.md`)
plus `chroot` and `clone`/`unshare` **for user, PID and network namespaces only** (mount, UTS,
IPC and cgroup namespace flags stay denied; `setns` stays denied). Docker's default allows
namespace creation only with CAP_SYS_ADMIN; without it Chromium stops with "No usable sandbox".

**Browser egress** (`/etc/abp/egress.rules{4,6}`, applied by `abp-firewall apply-egress`):
`DOCKER-USER` jumps `-i br-abp+` to `ABP-EGRESS` first. Per profile: the Runtime may reach only
its browser; the browser may answer the Runtime, send DNS to the resolvers Docker forwards to
(`--browser-dns`, detected from the host's resolv.conf by default), and reach anything **not** in
the ipset `abp-deny4` (the S1 private/special list — 0/8, 10/8, 100.64/10, 127/8, 169.254/16
incl. metadata, 172.16/12, 192.168/16, documentation, benchmarking, multicast — plus
`--deny-cidr` deployment ranges); everything else from a browser bridge is rejected. `INPUT`
jumps `-i br-abp+` to `ABP-INPUT` (replies only), so host addresses are unreachable. IPv6 from
browser bridges is rejected entirely (the networks are IPv4-only). Chains and sets are rebuilt
under new names and swapped in, so rules are never absent. `abp-stack` refuses to start
containers without them, re-checks every 10 s (re-applies; stops the browsers if that fails),
and `abp-egress.service` re-runs whenever Docker restarts.

## Prerequisites

Debian 12 / Ubuntu 22.04+ (arm64 tested), systemd, Docker Engine, Node 20+ at `/usr/bin/node`
(root-owned; NodeSource or distro package), npm for `--happy-tarball`. `--install-packages`
apt-gets the rest: bubblewrap, sudo, iptables, ipset, acl, gcc, g++, make (node-pty compiles where it has
no prebuild, e.g. linux-arm64), libc6-dev, libnss-resolve and, where it is a package of its own (Debian 12,
Ubuntu 22.10+; Ubuntu 22.04 ships it inside systemd), systemd-resolved (the kernel needs `xt_set`/`ip_set_hash_net`, standard in Debian/Ubuntu kernels). The proxy resolves through systemd-resolved's socket (`hosts: … resolve …` in
`/etc/nsswitch.conf`, set by the installer); the firewall gives it no DNS port. Installing
systemd-resolved switches `/etc/resolv.conf` to its stub.

## Build the images (build machine or H)

```sh
cd packages/happy-cli && pnpm install
node scripts/agent-browser/abp-stack.mjs build --source . --out /tmp/abp-images --tag 2026-09-25   # as root
# → /tmp/abp-images/images.tar + manifest.json {runtime:{id}, browser:{id}}
npm pack   # → buzzni-happy-cli-<version>.tgz
```

Base images are pinned by digest (`ARG` in `images/*.Dockerfile`); apt packages (Chromium,
noVNC 1.3.0) are fixed at build time, so the **image digest** is what H pins. Rebuilding gives
new digests, which reach H only through `abp-stack upgrade`.

## Install

Copy `scripts/agent-browser/` (with the S1 files), the tarball, the images directory, the
Saycode server's capability public key (Ed25519 PEM) and the site policy to H, then:

```sh
sudo ./abp-install --dry-run install …same flags…   # review every action first
sudo ./abp-install install \
  --happy-tarball ./buzzni-happy-cli-X.tgz --images /tmp/abp-images --install-packages \
  --workspace-id <studio workspace> --profile main=<studio userId of the assigned user> \
  --issuer <kid>=/path/saycode-capability-public.pem --sites /path/sites.json
sudo -iu agent happy auth login          # the Happy account of H; creates machineId
sudo ./abp-install                       # re-run: resolves machineId, writes runtime.json, starts stack + daemon
```

Unattended (one run, no interactive login; the Studio one-line install uses this): put the machine
options in one JSON file in `install.json`'s shape and pass the machine registration claim response
(`token`, `secret`, `machineId`) as the agent's credentials. The credentials file is deleted after use and
never printed; `--agent-credentials` needs a `serverUrl`.

```sh
sudo ./abp-install install --happy-tarball ./buzzni-happy-cli-X.tgz --images /tmp/abp-images \
  --config ./install-config.json --agent-credentials ./agent-credentials.json
```

- `--machine-id` defaults to `auto` (the agent's `~/.happy/settings.json` machineId), which the
  Runtime uses as capability `aud`. Options are saved in `/etc/abp/install.json`; a re-run
  without flags keeps them, flags override single fields.
- **Release 1: exactly one profile, `main`** (`--profile main=<studio userId>`); the Desktop
  requests profile `main`, and any other id or a second profile is refused. The generators and
  the stack support several profiles for later releases.
- `--sites` is the Runtime `sites` array (`[{ "origin": "https://…", "actions": […], "loginCompleteWhen": … }]`).
  `{ "origin": "*" }` admits every http(s) site (the Studio one-line install's "all sites" choice); exact origins keep
  their own rules and win over it. Navigation and links stay automatic; submits and clicks without a rule still need
  approval, and the browser egress firewall still blocks private networks. Wildcards inside an origin are refused.
- Other options: `--runtime-port` (38700), `--max-agent-windows` (4),
  `--retention-days` (7), `--viewer-origin <tunnel origin>` (needs the viewer stream, S4),
  `--egress-domain` (replaces the proxy's default Claude domains), `--happy-prefix`,
  `--build-from <happy-cli>` instead of `--images`, `--no-start`.
- `--server-url <https origin>` points the agent's Happy at another Studio server (dev, staging): written to
  `/home/agent/.happy/settings.json` as `serverUrl`/`webappUrl` before `happy auth login`. Without it Happy
  uses its built-in server. A machine already registered with another server is refused (`happy auth logout` first).
  Its origin (without the flag, Happy's built-in server `https://saycode.ai`) becomes the Runtime's
  `consoleHostOrigins`: Studio web opens the console through its preview relay in a new window and hands it
  the capability as `window.opener`.
- Secrets are created once: daemon token (hash in `runtime.json`), VNC password (same value in
  the Runtime and browser copies). The Runtime creates its agent key inside `abp-state`; it
  never leaves the volume.
- Claude login for the sandbox user (once, outside the sandbox, through the proxy):

  ```sh
  sudo ./abp-install claude-login        # then /login in Claude, follow the prompts, /exit
  ```

  It runs the Claude Agent SDK's native binary for this machine's architecture (x86_64 → `x64`,
  aarch64 → `arm64`) from the Happy package, i.e. the verified command:
  `sudo -u agent-sbx env HOME=/home/agent-sbx CLAUDE_CONFIG_DIR=/home/agent-sbx/.claude
  HTTPS_PROXY=http://127.0.0.1:3128 <happy prefix>/lib/node_modules/@buzzni/happy-cli/node_modules/@anthropic-ai/claude-agent-sdk-linux-<arch>/claude`.

## Verify

```sh
sudo abp-install check     # accounts, every path's owner/mode, sudoers, firewall prefix, services,
                           # proxy refusal + resolver, negative access as agent-sbx (token, runtime.json,
                           # broker, docker, Runtime API) and as agent (docker, admin), abp-stack status
sudo abp-stack status      # service, pinned digests, only 127.0.0.1:38700 published, /v1/ready,
                           # Chromium sandbox (renderers in a nested PID namespace, no --no-sandbox)
```

## Agent workspace (Desktop chats)

The Saycode server makes the daemon create chat workspaces under
`/home/agent/workspace/aplus-dev-studio-workspace/<context>/chats/<id>`, which cannot be changed
here, while the sandbox launcher accepts only working directories whose realpath is under
`/work`. Without the steps below every Desktop-started session exits at once (code 1).
`abp-install` therefore:

1. creates `/work/agent-workspace` (agent:abp-work 2770) **as agent**;
2. makes `/home/agent/workspace` a symlink to it, as agent. An existing directory is first opened to
   `abp-work` (recursive ACL while it is still inside the private home, so `agent-sbx` cannot
   interfere), then its entries (dotfiles too) are moved in; nothing moves if a name already exists
   in `/work/agent-workspace`. The daemon is stopped for the move and started again at the end.
   A symlink pointing anywhere else, or a regular file, stops the installer.
3. sets default POSIX ACLs `g:abp-work:rwX,m::rwx` on `/work` and `/work/agent-workspace` (single
   paths, `-P`; the workspace's as agent). The daemon runs with `UMask=0077`; with a default ACL the
   umask does not apply, so everything it creates later stays readable and writable for `agent-sbx`.
   No recursive ACL walk runs over the live `/work` tree: `agent-sbx` can write there, and a symlink
   swapped in during a root walk could redirect the grant.
4. roots the daemon's machine RPCs (file reads, a project's document list, bash and terminal cwd) at the
   link `/home/agent/workspace` (`HAPPY_WORKSPACE_ROOT` in `/etc/abp/happy-daemon.env`; the daemon default
   is its home). The server addresses projects and chats through the link, so keep this machine's
   workspace root in Studio in that form (`/home/agent/workspace/...`): a real path under `/work` is
   outside the root and refused.

The filesystem must support POSIX ACLs (ext4, xfs, btrfs); otherwise the installer stops with a
message. `abp-install check` verifies that the link resolves to `/work/agent-workspace`, that both
directories carry the default ACL, and that `agent-sbx` can read and create files in a directory
`agent` created with umask 077. Uninstall keeps both (with the other data) unless `--purge`.

After the Happy daemon restarts (install, key rotation), the first Desktop-started chat may fail
with `MCP caller grant rejected (invalid-envelope)` until the server refreshes the daemon key;
retry after about a minute (existing Happy behaviour, not specific to this installer).

## Operate

| Task | Command |
|---|---|
| start / stop | `abp-stack up` (waits for ready) / `abp-stack down` (Runtime first; running tasks recover paused) |
| logs | `journalctl -u abp-stack -u abp-happy-daemon -u abp-egress-proxy`; `docker logs abp-runtime` |
| metrics | `curl --unix-socket /run/abp/admin.sock http://admin/admin/metrics` (root) |
| reassign the machine | After changing the dedicated user in Studio, run `abp-stack set-principal main <studio userId>` on H. Stops the whole stack, switches config and browser volume, verifies the actual mount, labels, Runtime applied assignment and readiness over the root admin socket before opening admission. Failure restores the previous owner with a **fresh execution generation**. `abp-install --profile` refuses owner changes. |
| previous owners' logins | Retained indefinitely; site session expiry still applies. No automatic prune or retention-days setting. `abp-stack delete-profile-volume <volume> --confirm <volume>` removes one inactive, detached volume after checking exact labels. Unmapped volumes are retained and shown in status. Plain uninstall preserves logins; explicit `--purge` deletes them. |
| upgrading from before per-owner volumes | Unknown-owner `abp-profile-main` is quarantined; startup/upgrade refuses it. Confirm its actual owner and run `abp-stack migrate-legacy-profile main --owner <studio userId> --owner-verified`. Never infer the owner from the current config. The target must not exist. The stopped source is copied read-only and a path/type/mode/size/hash/symlink manifest verified; source is retained. |
| config change | re-run `abp-install` with the flags; each service restarts only when its inputs changed (the message names the input): stack ← runtime.json, VNC secret, egress rules, seccomp, its unit; daemon ← env, token, unit, **Happy package digest**; egress proxy ← unit, egress policy, **Happy package digest**. The firewall units are re-applied with `reload-or-restart` (a restart would restart everything that `Requires=` them) |
| new Happy package | `abp-install --happy-tarball <new.tgz>`: the content digest of the installed package (`/var/lib/abp/happy-package.sha256`) changes, so the daemon (sessions stay alive, KillMode=process) and the egress proxy restart onto the new code; the stack is untouched |

The stack survives reboots: `abp-firewall` applies the rules at boot before the proxy, the stack
and the daemon; tmpfiles recreates `/run/abp*`; `abp-stack.service` recreates the containers
from the pinned digests (volumes kept) and restarts exited ones with backoff (2 s → 60 s).

## Assignment recovery and compatibility

The browser volume identifies `(profile, principal)`; the 128-bit random `assignmentId`
identifies execution authority. A→B→A reuses A's login volume but never A's old agent
secret, grant, pending approval or runnable task. Start a new conversation after reassignment.
Ordinary same-assignment restart retains continuity. First schema-2 startup retires old
unversioned execution state; completed owner-protected history remains readable, and uncertain
writes are retained. No history lets the new owner read the previous owner's task data.

`stack-state.json` stores a durable transition journal and applied identities. Do not edit
owner/generation fields by hand. Pending transitions keep API and broker admission held across
reboots, suppress the supervisor, and block install/up/upgrade/rollback/rotate/delete operations.
Use `abp-stack set-principal --resume` to retry the journal target or `--abort` to restore its
original owner; both create a fresh generation. If restoration fails the service is stopped,
containers verified down, fence retained, and the journal stays blocked. Logs and `status`
explain the pending state. Same-owner no-op still verifies the applied assignment and mount.

An interrupted legacy copy keeps both volumes and blocks startup. Retry with the same owner
and `--owner-verified --resume`; only the journaled, never-admitted partial destination is
cleared and recopied. An unrelated/existing target is never overwritten. The source is never
automatically deleted, including after successful migration. Explicit single-volume deletion
is refused during any incomplete migration or assignment transition.

Install/runtime config schema 2, package `contract.json`, and image label
`ai.saycode.abp.contract=2` prevent supported downgrade paths. Previous incompatible image
pairs cannot be rolled back to; a failed upgrade with no compatible fallback stays stopped and
fenced. These guards do not constrain an operator who manually replaces the tools as root.
The installer disables/removes any former automatic-prune timer and `check` verifies the units are absent. Both staged and already-installed Happy packages must advertise contract 2 or later (images and packages of a shared machine: 3, whose runtime.json carries `tenancyMode`); reusing an old daemon that omits fork lineage is refused even when no tarball was supplied.
For an old-image/legacy-volume installation, use `abp-install --no-start` with the current package,
then `abp-stack upgrade --images <contract-2 images> --no-start`. This stages compatible images
without touching legacy data or admitting traffic. Confirm ownership and migrate next. Unknown
ownership deliberately keeps the service stopped; do not assign a guessed owner to regain service.

Autonomous service startup takes the same operations lock. An operation already holding that lock
(including the installer) delegates only held container creation through a root-owned startup request;
it then verifies and opens admission itself. A leftover request is recovered by `up` (or the pending
assignment/migration recovery command). Healthy `up` verifies the stack without restarting it; `up --restart` forces a restart to apply changed configuration, which the installer uses for changed inputs.
Deterministic config/identity/compatibility/legacy refusals exit 78 (`RestartPreventExitStatus`) to avoid retry storms; recover explicitly. Transient Docker, egress or readiness failures stop the stack and exit 1 so systemd retries.
Egress firewall checks continue even while startup, assignment or migration is held.

A crash after migration verification but before startup is recovered by `up`. A crash immediately
after recording the copy hold may leave the previous stack running; `--resume` stops and verifies it
before copying. A named, labelled copier left by a crash is stopped and removed before retry.
`--resume` for an assignment retries the **originally requested** owner even if automatic rollback
also failed; `--abort` restores the original owner. Both refresh the generation.

`abp-state` contains execution ledgers. Preserve it along with config on backup/restore; arbitrary
root restoration of old state is outside the supported downgrade contract. Browser cookies alone
are not an authority backup. Resumed/forked conversations with unverifiable lineage are refused;
use a new conversation.

## Shared machines (a browser profile per user)

`abp-install --tenancy shared` installs a machine several users of one company share (Saydo
`specs/agent-browser-shared-profiles/design.md`). It is not a security boundary between those users. The mode
is fixed at install; to change it, uninstall (volumes are kept) and install again. A shared machine starts
with no profile: each user gets `u-<16 hex of sha256(userId)>`, with its own browser, network slot (0-7)
and login volume.

```
abp-stack add-profile <studio userId>              # or automatically on the user's first use
abp-stack remove-profile <studio userId> [--block] # --block: only add-profile brings them back
abp-stack list-profiles [--json]
abp-stack recover-profiles                         # put the previous profiles back after a failed change
```

- First use: when a user's new chat (attested by Studio) asks for a grant, the broker records a request and the
  session waits (`PROFILE_PROVISIONING`, up to 45 s); the abp-stack service polls the admin socket every 3 s
  and adds one profile at a time when no other operation holds the lock. A request that cannot be served is
  refused for 10 minutes and the session is told why (`PROFILE_UNAVAILABLE`: capacity, memory, blocked, or a
  failed addition), so a persistent failure never restarts everyone's Runtime over and over.
- Adding or removing a profile fences the API, drains running tasks (up to 60 s, else nothing changes),
  handles that user's browser and network, and recreates the Runtime. The other browsers keep running
  with their pages and pending approvals; every user sees a few seconds of `RUNTIME_UNAVAILABLE` (retried).
- At most 8 profiles, and only while `MemTotal - memoryReserveMiB (4096) >= 1 GiB + 2 GiB x profiles` and
  3 GiB is available right now. Slots are not reclaimed automatically.
- Only the stack service's containers are changed: after `down` or `emergency-stop`, run `up` first.
- A change is journaled. A failure before the Runtime is touched removes only the new browser; an addition
  that fails later is rolled back; a removal that fails after its commit goes forward. A change left behind
  (crash, reboot) is settled by the next service start or `abp-stack up --restart`: before its commit the
  previous profiles, after it the new ones. A first-use addition that failed for good restarts the service
  itself, so its fence does not stay; supervision of the other browsers continues meanwhile. A user whose
  additions keep failing is refused for 10, 30, 90 minutes...; a drain that timed out postpones (2 min) up to three
  times, then the request is refused as busy. While a refusal lasts, newer chats of that user get its reason.
- A block stays through a later plain `remove-profile`; only `add-profile` lifts it.
- Verification after a change needs the Runtime and that profile's browser only: another user's broken browser
  holds neither changes nor start-up.
- Removal ends that user's sessions and tasks; their login volume is kept indefinitely (re-adding restores
  their logins, with a new assignment; the removal time is kept, so their old chats need a new chat). To cut a user off: remove them
  from the machine's access list in Studio first, then `remove-profile`.
- `set-principal` is refused on a shared machine.
- Images and the package of a shared machine must be contract 3 (its runtime.json carries `tenancyMode`).

## Upgrade and rollback

```sh
abp-stack upgrade --images /path/new-images [--ready-timeout 180]
abp-stack upgrade --runtime-image sha256:… --browser-image sha256:…   # already loaded
abp-stack rollback                                                    # back to compatible previous digests
abp-stack upgrade --images /path/v2-images --no-start                  # pin images while stopped, before legacy migration
```

Upgrade (and rollback, rotate-keys, set-principal): load and verify the digests → **fence**
(every host packet to the Runtime API port is reset by the `ABP-FENCE` chain, so no new task,
batch or request on a kept-alive connection gets in) and **verify** it: the rule is installed,
`OUTPUT` jumps to `ABP-FENCE`, and the API really stops answering → **drain**: admin metrics
must answer and reach 0 `running`/`recovering` tasks within 60 s. A fence that cannot be
verified, metrics that do not answer, or a drain timeout **abort** the operation: the fence is
lifted, nothing is stopped or changed, history records `aborted` with the reason (retry later,
or use `emergency-stop`). A Runtime that is not running (Docker reports it stopped, or "no such
object") is recorded as `runtime-not-running` and needs no fence; a state Docker cannot report
(daemon unreachable, permission, unexpected output) aborts the operation, and after a stop such
a container is not counted as stopped. Then, on a running stack, **only the containers whose image digest changes
are replaced** (a time-limited `/run/abp-stack-maintenance` flag keeps the supervisor from
restarting them meanwhile):

- Runtime-only upgrade: the Runtime is stopped (killed if needed), removed and recreated; the
  browsers keep running with their profile, open pages and the document a pending approval refers
  to (the Runtime restores such an approval after a Runtime-only restart when document and node
  are unchanged);
- browser upgrade: each browser is replaced at its fixed address (only behind a live egress
  firewall) while the Runtime keeps running and reconnects; tasks with open pages come back
  paused (`browser-replaced`);
- both: browsers first, then the Runtime.

The root admin socket verifies readiness, the applied assignment, labels and the exact browser mount
before admission and the public fence are opened; the Runtime **of the new digest** must then answer `/v1/ready`. Not ready, or any step fails (e.g. a container cannot be created) →
automatic rollback to the previous digests, replacing again only what differs, and exit 1. A stack
that is not running is simply started with the new digests. History records `replaced`. Volumes are never
touched. The history entry carries the fence and drain result (`quiesce`). The broker socket is
not fenced: registrations, grants and attention polls continue during the drain (they do not
admit work; grants stay valid on the new Runtime, same agent key).

`abp-stack emergency-stop` is the incident path: no lock, no drain, best-effort fence, service and
containers stopped at once and verified down; running tasks recover paused or uncertain.
`abp-stack up` starts again. A plain service stop (`abp-stack down`, reboot) cannot be refused,
so its fence and drain are best effort and logged. A journal written by a newer schema is refused by the
older Runtime on rollback (it stays not-ready: safe stop) — see `abp-stack status`.
History of every switch is in `/var/lib/abp/stack-state.json`.

## Rotate keys

```sh
abp-stack rotate-keys                   # both
abp-stack rotate-keys --daemon-token    # new token file, hash into runtime.json, Runtime restart, daemon restart
abp-stack rotate-keys --vnc-password    # both copies, x11vnc restarted inside the browsers, Runtime restart
```

The Runtime restart is fenced and drained like a stop; sessions keep their broker registrations
and the daemon restart leaves sessions running; Chromium is not restarted. Every step is
checked: Runtime ready again, broker accepts the new daemon token, x11vnc back in every
browser, daemon active. A failure is reported (exit 1, history `rotate-keys:failed`); run it
again to complete. Rotating the server capability key = re-run `abp-install` with the
new `--issuer` (both kids can be listed during the overlap).

## Uninstall

```sh
sudo ./abp-uninstall [--dry-run]        # services, containers, networks, rules, units, sudoers, tools
sudo ./abp-uninstall --purge            # also volumes (tasks, profiles), images, /etc/abp, /var/lib/abp, /opt/abp, policies
```

Order: (1) new sessions are fenced (sudoers drop-in removed, daemon stopped); (2) every process
of `agent-sbx` and `agent` gets SIGTERM, then SIGKILL, and none may survive — otherwise the
owner firewall rules are **kept** and the script exits 1; (3) stack, containers, networks,
browser egress rules; (4) owner firewall rules and the rest. Run it from a root or operator
session, not from a shell of `agent`. Without `--purge` a later `abp-install` brings back the
same tasks, profiles and secrets. Accounts and homes (Happy and Claude logins) are never deleted.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| status `chromium sandbox … sandboxed 0`, Chromium log "No usable sandbox" | the host blocks unprivileged user namespaces: Ubuntu 23.10+ `kernel.apparmor_restrict_unprivileged_userns=1` (set 0 or give Docker's profile `userns`), Debian `kernel.unprivileged_userns_clone=0`; or the seccomp profile was not applied |
| Runtime exits with status 75 | another Runtime holds the writer flock on `abp-state` (`docker ps -a`); never run a second stack |
| `/v1/ready` `revocations:false` | broker is replaying interrupted revocations; wait |
| `/v1/ready` `browsers:false` | browser container or Chromium down: `docker logs abp-browser-<p>`, `/tmp/chromium.log` inside |
| sessions refused with MandatorySandboxError | `abp-install check`; usually firewall prefix (another tool inserted OUTPUT rules → `systemctl restart abp-firewall`), proxy down, or sudoers |
| `systemd-resolved is masked` (warning) / `not installed` / `did not start` | abp-install unmasks a masked unit (OrbStack and some Debian images ship it masked); install `systemd-resolved libnss-resolve` (or `--install-packages`); `journalctl -u systemd-resolved` |
| Desktop-started sessions exit immediately (code 1) | the chat workspace is not under `/work`: `abp-install check` (workspace lines); re-run `abp-install` |
| `… already exists in /work/agent-workspace` / `… is a symlink to …, not /work/agent-workspace` | the installer will not merge or overwrite: move the conflicting entry (or the old link) aside, re-run |
| `does not support POSIX ACLs` / `missing: setfacl getfacl` | put `/work` on ext4/xfs/btrfs with ACLs; install `acl` (or `--install-packages`) |
| first Desktop chat after a daemon restart: `MCP caller grant rejected (invalid-envelope)` | the server has not refreshed the daemon key yet; retry after ~1 minute |
| `upgrade aborted: …` | fence not verifiable (`abp-firewall check`, then `systemctl restart abp-firewall`), admin metrics down (`docker logs abp-runtime`), or batches still running after 60 s (retry later); nothing was changed |
| proxy 502 / resolution fails | `sudo -u abp-proxy getent hosts api.anthropic.com`; nsswitch `resolve`, systemd-resolved active |
| `QUOTA_EXCEEDED` after a crash/reboot | registrations with a known Linux session owner self-heal at daemon startup and every 60 s: dead owners are revoked, paused tasks cancelled and spaces reclaimed. Surviving sessions and legacy registrations without an owner are kept. The admin `POST /admin/close-space` route remains the manual cleanup path. |
| broker 401 from the daemon | token and hash out of step (interrupted rotation) → `abp-stack rotate-keys --daemon-token` |
| browsers cannot load a site | `abp-firewall check-egress`; a site on a private or `--deny-cidr` address is blocked by design; DNS: `--browser-dns` must list the resolvers Docker forwards to |
| `another abp-stack operation (or abp-install) is running` | one mutating operation at a time (`/run/abp-stack-ops.lock`); wait for it |
| `image digest mismatch` on load | the loading Docker uses a different image store (classic vs containerd) than the builder; build on H with `--build-from` |

## Not covered

Installing Docker or Node; Saycode server flag and signing key (S7); the machine tunnel and
Desktop (S8); HA, zero-downtime upgrade (a browser image change still replaces the browsers); rotation of the Runtime
agent key (inside `abp-state`); IPv6 browsing (browser networks are IPv4-only); Docker
userns-remap; AppArmor profile for Chromium; log shipping and volume backups; x86_64 (only
arm64 exercised); the S9 acceptance runs (reboot ×3, A01–A12, GD gates).

## Deviations from contracts.md (recorded, not silent)

1. **Fence and drain are done by the stack, not the Runtime:** the Runtime has no admin
   drain/fence operation, so the fence is a host packet filter on the API port (`ABP-FENCE`,
   which also blocks requests on kept-alive connections and the tunnel) and the drain polls
   admin metrics until no task is `running`/`recovering` (60 s cap). Controlled operations abort
   unless both are verified; only service stop and `emergency-stop` proceed without them.
   A Runtime-side admission fence would additionally let the broker socket refuse grants.
2. **Browser image upgrades replace the browsers** (page state lost, profiles kept); Runtime-only
   upgrades keep them.
3. **Port:** the Runtime listens on 38700 inside the container (`runtimeHost` 0.0.0.0 there) and
   is published only on `127.0.0.1:38700`.
4. **Viewer:** `vncAddress` goes in `ABP_PROFILES` (runtime.json profiles carry identity only) and
   `viewerOrigins` only with `--viewer-origin`, so the file stays valid before and after S4.
5. **Seccomp:** Docker default plus `chroot`, and `clone`/`unshare` restricted to user/PID/net
   namespace flags (`chroot` cannot be restricted by argument).
6. **Browser uid 10871** (not 1000), reserved on the host as `abp-browser`.
7. **Firewall rules** are generated by `lib/abpPlan.mjs` (same lists as S1); a unit test compares
   them with `sandboxPreflight.firewallRules` once both streams are merged.
8. **Daemon unit** uses `KillMode=process` so sessions outlive a daemon restart, as with
   `happy daemon stop`; `abp-uninstall` therefore terminates the session users' processes itself.
9. **Issuer keys** are stored as canonical SPKI PEM; private keys are refused.

## Tests

```sh
pnpm exec vitest run --project unit scripts/agent-browser   # plan, stack (fake docker), install/uninstall dry-run, shellcheck if installed
```

Manual evidence (2026-09-25, OrbStack arm64, synthetic keys and tokens): a disposable
privileged systemd + Docker-in-Docker Debian 12 container ran the real `abp-install --images`:
`check` all passed and S1's `checkSandboxPrerequisites` passed; re-run kept secrets and config;
rotate-keys (new token 200, old 401, Chromium kept); upgrade, failed upgrade with automatic
rollback and explicit rollback kept the task and both volumes; restart of the container
(reboot) recovered everything; a killed Runtime was restarted by the supervisor; uninstall →
reinstall kept the token; `--purge` removed state.

Second round (after the astra S6 review, on the integration tree with S1/S4/S5): second install
changing issuer, sites and port restarted the stack and daemon and the new values took effect
(API only on the new port); browser egress: a private
container, the host via three addresses, 169.254.169.254, the Runtime API and IPv6 were
refused while public HTTPS and DNS worked, and a Chromium page's private `<img>`/`fetch`
subresources reached the private server 0 times; seccomp: user/PID/net unshare allowed,
mount/UTS/IPC/cgroup unshare and setns denied, Chromium still sandboxed; shutdown during a
running 25 s batch reset new API requests, drained ~20 s, then verified the containers down;
concurrent rotate-keys refused; rotation with all checks; egress rules restored after
`systemctl restart docker`, a reboot and a manual jump deletion; uninstall with a live
SIGTERM-ignoring agent-sbx process killed it before removing the rules; a symlinked config
path made the installer refuse.

Fifth round (2026-09-26, upgrade drill findings): stand-in `@buzzni/happy-cli` tarballs v1/v2
(real egress proxy bundle; `daemon start-sync` forks a long-lived "session" child). A no-change
re-run left the daemon, proxy, stack, Runtime and browser PIDs unchanged — **correction:** until
this round every re-run restarted all of them through `Requires=` propagation from the
unconditional firewall restarts (round 2 had judged "restarted nothing" from the installer's
messages, not PIDs). `--happy-tarball` v2 restarted only the daemon and the proxy ("changed:
/var/lib/abp/happy-package.sha256"), the proxy ran the v2 build, the v1 session child survived,
stack/Runtime/browser PIDs unchanged. Runtime-only upgrade: new Runtime container, same browser
container and Chromium process, the task kept its tab on https://example.com/ and stayed
`awaiting-agent`; history `replaced: ["runtime"]`, fence verified. Browser-changed upgrade: same
Runtime container, new browser container, task `browser-replaced`; history `replaced: ["browser"]`.
A pending approval could not be produced on example.com (its link click ran), so approval
survival across the Runtime-only path rests on the PoC's Runtime-only restart test.

Fourth round (2026-09-26, same kind of host, `acl` package missing at first): the installer
refused with "missing: setfacl getfacl"; with it, a fresh install created the link and ACLs and
`check` passed (including the workspace lines). A pre-fix layout (real `/home/agent/workspace`
with a umask-077 Desktop-style chat dir and a dotfile, daemon running) was migrated by a
re-run: link in place, daemon active again, `agent-sbx` read and wrote the migrated files, a new
chat dir created by `agent` with umask 077 through the link resolved under `/work` and was
readable/writable for `agent-sbx`; S1 preflight passed. The first attempt showed that a root-owned
recursive ACL walk under `/work` is refused by the installer's own path check (`/work` is
group-writable), which led to the as-agent, single-path design above.

Third round (2026-09-26, merged integration tree, clean Debian 12 systemd + DinD with
systemd-resolved **masked**): profile `ops` refused; the install unmasked and started
systemd-resolved; `check` all passed; S1 preflight passed; `claude-login` ran the resolved
`linux-arm64` binary (a stand-in) as agent-sbx with its home, config dir and the proxy. Upgrade
with the `OUTPUT → ABP-FENCE` jump removed aborted ("OUTPUT does not jump to ABP-FENCE"), and
upgrade with a 110 s batch running aborted after the 60 s drain ("drain timeout (1 running)");
both times the Runtime kept serving on v1 with the fence lifted and history recorded `aborted`.
Upgrade with a 20 s batch running and broker register/attention traffic in parallel: fence
verified, drained in 20.1 s, then switched and was ready on v2 (history `quiesce`); the broker
answered 200 throughout the drain and was refused only while the containers were swapped.
`emergency-stop` stopped the stack at once and `up` cleared its flag.

The firewall script was exercised in its own
network namespace (idempotent, foreign rules kept, shadowing repaired).

### Execution lineage boundary

The broker relies on the authenticated daemon and supported client flow to report fork lineage.
The current account holder can always put old text into a genuinely new conversation; transcript
content is not itself an execution credential. The provider fork RPC still accepts a client-supplied
parent, so stronger provenance for deliberately modified clients is a future hardening item.
Cross-user cookie access and previous grants/secrets remain refused independently of that lineage.
A daemon restart loses a pending in-memory bind retry; an unbound session then has no browser grant
and may need a new conversation. No registration is treated as successfully bound merely because
retry was scheduled.

### Login persistence limitation

Keeping a profile volume preserves on-disk browser data, not an unconditional login session.
Chromium does not reload non-persistent session cookies after a browser restart (for example,
`the-internet`'s `rack.session`). Such sites require login again after reassignment, even when
the same user returns. Persistent cookies (for example, an httpbin cookie with `Max-Age`)
survive A→B→A until the site expires or revokes them. `RestoreOnStartup` is not enabled: restoring
old tabs would interfere with the Runtime's assignment-scoped tab management.

Graceful container stop requests CDP `Browser.close` before waiting for Chromium to exit.
SIGTERM alone can lose freshly set persistent cookies before its delayed disk write.
If the local shutdown request fails, a warning precedes TERM/KILL fallback; recent changes
are not guaranteed to survive forced termination or a machine crash.

If `abp-uninstall --purge` fails, some volumes may already have been removed. Configuration
and stack metadata remain for recovery. Re-run the uninstall script from the installer bundle
after resolving the Docker error (installed tools are removed before purge).

### Profile assignment verification (2026-09-30, dev H)

The v2→v3 installation kept the existing per-user volume and `profileVolumes` mapping,
upgraded config to schema 2, removed the active pruning timer/service, and passed installer
checks. The legacy volume had already been deleted by v2; legacy migration was not exercised
on this machine.

After reproducing newly set persistent-cookie loss with TERM-only shutdown, the CDP close
path passed 10 immediate HTTP `Max-Age` cookie A→B→A rounds. B's Cookies DB contained no
`the-internet`/`httpbin` cookies. A's previous grant, secret, same-session rebind and resume
lineage stayed denied after A returned. An intentionally mislabelled test volume failed
startup and automatically restored A with a fresh assignment; readiness, mount and cookies
were verified after rollback.

Affected local regression: 38 files, 632 passed / 1 skipped (shellcheck unavailable),
including typecheck and production build. Repository-wide runs were not fully green: Mac
process/cache permissions and temporary-path assumptions, and dev H's mandatory sandbox
policy/root execution affected unrelated suites. These runs are not reported as passing.
Reboot/crash recovery and real legacy copying remain unexecuted E2E scenarios; unit coverage
is not a substitute for those deployment checks.
