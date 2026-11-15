# Codex account model isolation implementation plan

Goal: stop managed ChatGPT sessions from inheriting gateway model defaults and catalogs, while preserving native Magpie sessions and unrelated user capabilities.

Approved scope: the user accepted the diagnosis and requested the Paws repair. Keep the official account provider and credential isolation; do not reroute bound accounts to Magpie. Implement in this sibling worktree without production deployment.

Architecture: create private, parsed TOML snapshots for managed account configuration, stripping model/provider defaults (including selected profiles). Preserve Skills/MCP and leave source files untouched. Validate explicit managed-session model choices against the account catalog before model inference requests. Native launches keep their original configuration behavior.

- [x] Add failing managed-launch regressions for gateway defaults, profiles, source immutability and retained MCP/Skills.
- [x] Add a TOML parser dependency already present in the workspace lock; sanitize only account-bound homes, preserving ordinary/native paths.
- [x] Add model-selection regressions for gateway aliases, account catalog membership, null/default and native gateway use; enforce at execution boundaries.
- [x] Run targeted account, config, thread and launch tests plus CLI typecheck/build.
- [x] Obtain independent code review; address findings and report implementation/deployment separately.

Review focus: flat and legacy profiles; config symlinks and source mutation; model-specific instruction/context settings; stale UI choices; missing account catalog. No new UI, polling, Android runtime changes, global authentication writes or service restarts.

Ruling: validate at the turn/start boundary, including inherited thread defaults. Local history RPCs remain usable without model authentication. The existing server-validated application binding remains authoritative.

Build prerequisite: baseline attachment BlobPart and axios mock params require two narrow type fixes with the current TypeScript declarations. No behavior change intended.


Verification: 10 targeted suites / 143 tests passed. Regression failures were observed before both config isolation and inference-boundary fixes. CLI typecheck passed; native Codex 0.166.0 accepted a sanitized fixture configuration, exposed the official provider and 12 models without the gateway alias. No model inference or production operations were sent. Independent review passed after adding review/compact/goal/sample guards and authoritative model-state updates. Full CLI bundling is verified separately before commit.

CI follow-up: the first PR run passed 13 jobs but failed workspace typecheck on existing unknown worker errors. A no-bail local workspace typecheck also identified typed-array fixture/upload incompatibilities. Narrow error/byte handling corrections are isolated in a follow-up commit; recursive workspace typecheck now passes and paws-share has 46 passing tests.
