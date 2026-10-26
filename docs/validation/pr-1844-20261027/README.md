# PR #1844 live takeover validation — 2026-10-27 (UTC+8)

The live provider/Happy relay takeover passed for both an `opus` alias and an explicit `claude-opus-5-5[1m]` selection. Each case ran one native local turn and two remote turns in the same Claude session. Both remote prompts omitted `meta.model`.

Tested source: `5b1c917a5e232093aec0ee443ae93a333d0e6574`, with additional observation scripts and unit regressions only. Production code was unchanged.

Environment: macOS arm64, Node 26.11.1, Claude Code 2.1.310, Happy source package 1.2.5, Agent SDK **0.3.295**, installed from the current PR's frozen lockfile. SDK 0.3.283 from the older discussion was not the SDK tested in this run.

| Case | Native model usage | Remote init | Both remote assistant models | Final currentModelCode | Remote reported contextWindow |
| --- | --- | --- | --- | --- | --- |
| `opus` | `claude-opus-5-5` | `claude-opus-5-5` | `claude-opus-5-5` | `claude-opus-5-5` | 1,000,000 |
| `claude-opus-5-5[1m]` | `claude-opus-5-5[1m]` | `claude-opus-5-5[1m]` | `claude-opus-5-5` | `claude-opus-5-5[1m]` | 1,000,000 |

The assistant model's base ID in the second row agrees with the SDK's `canonicalModel`; the SDK result usage keys and published selection retain `[1m]`. No older Opus model appeared in either successful case. An independent user-scoped socket decrypted the server's published model catalog and active selection. The catalog contained Default, Opus 5.5, Fable 5.1 `[1m]`, Sonnet 5.5, and Haiku 5.5; the explicit Opus `[1m]` selection was retained as an additional selectable row in that case.

## Evidence and reproduction

- [Alias case](opus.evidence.json): started `2026-10-26T17:07:11.421Z`, finished `17:07:47.178Z`.
- [Explicit 1M case](opus-1m.evidence.json): preserves the suffix across local execution, takeover, and the subsequent remote turn.
- [Native catalog](native-catalog.json): actual initialize/control response, with unrelated commands and account data removed; no user/inference message was sent by this catalog probe.
- [Unit results](unit-results.txt): 7 files, **73 tests passed**, including the CLI's `tsc --noEmit` and package build from global setup. Three added cases cover the current SDK query catalog, catalog failure, and explicit `[1m]` handoff to the next queued turn.
- [Runnable smoke](../../../packages/happy-cli/scripts/validate-remote-model.md): commands, observations, cleanup, and output files.

Live execution uses the native CLI in local print/stream mode, the real Happy local launcher and takeover queue, the real Happy service, and the SDK's real provider process. App transport is headless; it uses encrypted HTTP messages and an independent user-scoped socket. The observations do not replace or stub the provider, SDK, queue, or relay.

Still untested here: rendered iOS/Android model-picker behavior, interactive native terminal takeover, near-capacity long-context workloads, and the historical SDK 0.3.283 combination. The 1,000,000 figure is the runtime-reported context window, not a million-token load test.

Initial runner setup attempts were corrected before these two passing cases: missing wire build, duplicate Node/Axios proxy handling, print mode with TTY stdin, an incorrect message POST payload, and observing converted log messages instead of raw SDK messages. Those attempts are not counted as passing validations. The final runner observes the SDK-to-log converter input and forwards it unchanged.
