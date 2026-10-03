# Native Codex memory MCP ownership

## Problem and evidence

Happy marks the Codex app-server environment when host recall is prepared. A
stdio MCP server has its own environment forwarding configuration. The installed
CML 2.4.10 snapshot reader works when explicitly marked, but a newly observed
native connection can return context while source expansion fails during
writable SQLite initialization. Disk package version alone does not establish
the version or environment of an already running MCP process.

## Implementation plan

1. Verify environment filtering with an actual Codex app-server and a synthetic
   metadata-only stdio MCP, without a provider turn or user-config replacement.
2. Read effective Codex configuration for the thread cwd and forward ownership
   explicitly to existing native CML stdio entries, including server aliases.
   Preserve unrelated servers, credentials, disabled entries, and sandbox policy.
3. Apply the configuration consistently to start, resume, and fork. Re-evaluate
   on reconnect; do not persist host ownership into user configuration.
4. Test unsupported/managed/shared hosts and config-read errors, plus preservation
   of native settings and runtime MCP overrides. Independently review the change.
5. Verify installed CML context and source expansion in a constrained fresh
   process and verify the actual connected sub-agent separately. Report stale
   session limits rather than equating an SDK smoke test with deployed success.

## Acceptance

- Actual MCP child observes the intended flag through explicit server configuration.
- Only host-prepared, unmanaged, owner-choice sessions receive ownership.
- Canonical memory/model files are not written by constrained reads.
- Other MCP settings and current user configuration are preserved.
- Regression tests, typecheck, and package build pass.
- External Happy release follows the repository's explicit approval policy.

## Verified design decisions

- Codex 0.160.0: an app-server parent marker alone is filtered from the MCP
  child. Explicit `env` or an `env_vars` whitelist forwards it correctly.
- Copying normalized `config/read` entries into thread config is rejected when
  they contain null fields. A nested env-only server entry also fails because
  its transport command is not preserved by that form of override.
- Without a runtime MCP map, dotted leaf thread-config overrides preserve the
  native command and environment for simple aliases. Quoted dotted aliases are
  split by Codex and rejected, so other aliases use the full-map form below.
- A top-level runtime MCP map replaces the entire native table. A sparse runtime
  map plus native ownership leaf fails with an invalid transport. When a runtime
  map is supplied, merge all native and runtime entries before marking CML.
  Omit normalized null fields, which TOML overrides cannot represent. Actual
  native siblings, runtime additions, and prior environment values are preserved.
- Configuration discovery is bounded to three seconds. A discovery failure
  warns without exposing response/error content or changing sandbox policy;
  known runtime CML entries can still be marked, but undiscovered native entries
  may remain unavailable until discovery succeeds.

## Validation and rollout status

- Three regression suites passed: 148 tests (116 app-server, 22 ownership
  mapping, 10 MCP config synchronization). Their setup built the package and ran
  TypeScript checks successfully. Independent review found no remaining defect;
  the `__proto__` alias omission was corrected and covered by regression.
- Actual Codex 0.160.0 metadata-only probes verified parent-only filtering,
  explicit forwarding, full-map null handling, simple/exotic aliases, sparse
  runtime replacement, native sibling preservation, and new runtime additions.
  No provider turn ran and user configuration remained unchanged.
- Installed CML 2.4.10, explicitly host-marked in a fresh process with OS file
  writes/network denied, passed live context retrieval, source expansion,
  mutation rejection, and snapshot cleanup (10 exposed tools, zero leaks).
- The existing connected sub-agent still returns context but fails source
  expansion with `readonly_runtime`; the root's retained connection still fails
  during model-cache initialization. These connections are not evidence of the
  new Happy implementation being deployed. Do not claim deployed recovery until
  the fix is merged/installed and a new session passes both direct reads.
- `node`/`npx` wrapper commands are conservatively not identified as CML; direct
  `claude-memory-layer-mcp` executables and Windows cmd/exe variants are supported.
