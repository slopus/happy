# Desktop management of CLI authentication

These commands manage the current OS user's CLI root selected by `HAPPY_HOME_DIR`
(normally `~/.happy`). They do not represent the Agent's selected local user,
team, or account. Desktop should label this as the separate existing CLI login.
No command selects an Agent user directory, scans team credentials, or exports
tokens, public keys, private keys, or recovery keys.

## Read status

Run `happy auth desktop --status-json`. Standard output contains one JSON object:

```ts
{
  version: 1,
  ok: true,
  status: {
    cliVersion: string,
    scope: 'cli-root',
    auth: 'missing' | 'v2' | 'legacy' | 'invalid',
    accountKeyFingerprint: string | null, // SHA-256 of the account public key
    serverUrl: string, // normalized; no userinfo, query, or fragment
    machineId: string | null,
    identityGuard: string, // opaque revision; never display, log, or copy
    daemon: {
      state: 'stopped' | 'online' | 'offline' | 'unavailable'
        | 'identity-mismatch' | 'version-mismatch',
      connection: { machineId: string, cliVersion: string,
        serverUrl: string, connected: boolean } | null
    },
    resetPreview: {
      credentialFile: string, // exact absolute CLI-owned file
      settingsFile: string,
      settingsFields: ['machineId', 'machineIdConfirmedByServer'],
      registration: { machineId: string, serverUrl: string,
        accountKeyFingerprint: string } | null,
      stopsDaemon: true
    }
  }
}
```

Status reads pairing files without following symlinks, validates ownership and
size, and probes the local daemon's `/status`. It does not authenticate against
the remote server, repair pairing files, or start/stop the daemon. Daemon online
means the daemon reports its cloud/RPC connection ready; an HTTP listener alone
does not mean ready. Legacy and V2 key fingerprints are tied to their respective
key formats and are not evidence that a CLI login matches an Agent user.

## Confirmed reset

Show the exact preview and preserve its guard while confirmation is open. Offer
local-only logout separately from removing that login's computer registration.
Run `happy auth desktop --reset-json` with this JSON on standard input after
explicit UI confirmation:

```ts
{ version: 1, expectedGuard: string, confirmed: true, removeRegistration: boolean }
```

The payload is strict, at most 8 KiB, and must complete within five seconds.
Do not put it in command arguments or use an interactive `yes` wrapper. The guard
is a revision, not authorization; it binds the CLI root paths, credential bytes,
server, machine ID and registration confirmation state shown in the preview.

The CLI takes its shared auth lock and existing settings lock, revalidates the
guard, stops only a verified matching daemon via HTTP, and optionally deletes
`/v1/machines/:id` using only that CLI login's token. The server enforces ownership.
A 404 means this registration is absent from that account. On deletion failure,
local authentication and machine settings stay intact; the daemon may already
be stopped. A lost response can leave the server-side outcome unknown; the
registration flag means confirmed removal. There is no force-kill fallback or
automatic deletion retry.

Only the root `access.key` and the two named settings fields are removed. Agent
databases/credentials, session history, logs, recovery keys (`restore.key`), and
unrelated settings remain. Local-only reset may clear an invalid credential file
after confirming its exact revision; remote removal requires valid credentials
and a machine ID. A live unverifiable or mismatched daemon blocks reset.

Success and error responses report completed steps, including partial failure:

```ts
{ version: 1, ok: true, result: {
  localAuthCleared: boolean, registrationRemoved: boolean, daemonStopped: boolean
} }

{ version: 1, ok: false, error: {
  code: 'credential_missing' | 'credential_invalid' | 'account_mismatch'
    | 'server_mismatch' | 'identity_changed' | 'daemon_unavailable'
    | 'daemon_not_ready' | 'unsupported' | 'read_failed' | 'reset_failed'
    | 'machine_delete_failed' | 'invalid_request' | 'auth_busy',
  message: string, // fixed safe message; never arbitrary transport/file stderr
  localAuthCleared: boolean, registrationRemoved: boolean, daemonStopped: boolean
} }
```

Errors exit nonzero but still return the envelope on stdout. Native must parse
the bounded typed stdout even on nonzero exit, reject unexpected shapes, and
never project raw stderr into UI. A CLI without these commands is management
unavailable; status must not automatically install or replace it.

CLI credential writers, desktop import, logout and machine registration share
the auth lock. Settings locking remains in place and is kept fresh during async
operations. No process may bypass the locks by editing root credential files
directly. A changed guard requires a new preview and confirmation.

## Agent account handoff boundary

The older `happy auth desktop` importer reads the legacy shared
`agent/happy` pairing. It does not resolve a current scoped Agent user. Reusing
`agent/users/<id>/happy` needs an authoritative Agent-owned current-user handoff
API and cannot be implemented by accepting renderer-provided IDs or paths. That
handoff remains separate pending work. These status/reset capabilities do not
add a new connect operation or claim to solve that account-selection boundary.