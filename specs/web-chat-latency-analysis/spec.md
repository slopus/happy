# Codex MCP preparation latency

User authorized continued implementation and measurement after Luna/low recovered on ethan-desktop. In the Web observations, seven pre-reload followups had a 6119.300ms median first-text observation and 4424.012ms median per-request recovery+status preparation. These are recovery observations, not a qualified controlled baseline.

Scope this increment to duplicate inventory queries: normal `recoverBeforeTurn` inspects `mcpServerStatus/list`, then `reportMcpStatuses` immediately queries it again. Reuse only the final successful inventory of that same recovery operation for pre-turn metadata reporting.

- Do not cache across turns, threads, configuration changes or manual status requests.
- After resume, use its new inspection. If inventory or resume failed, preserve fresh reporting fallback; never imply unavailable/starting/needs-auth evidence is connected.
- Keep config failure precedence, connector qualification, recovery cooldown/in-flight behavior and existing retry/auth/authorization semantics.
- Retain existing APIs for callers that do not request reporting data. No timeout races, parallel turn startup or tool removal.
- Acceptance: normal inventory queries two to one, exact metadata preservation, failure/regression tests, type/lint/build, and paired repeatable real app-server preparation measurements. Local/no-provider preparation latency is not Web/SDK model response or paint latency.
- Do not publish locally or consume an unreleased vendor pointer. Release is a later explicit action.

Full prior Web measurements remain in the platform repository's `specs/web-chat-latency-analysis/`.

## Recovery cost decomposition

After the .284 Web followup observations, instrument the initial inventory RPC, reconnect RPC, existing retry backoff and verification RPC independently using the opt-in turn recorder. Preserve retry/auth/cooldown, same-operation inventory reuse and in-flight ownership. Diagnostic failures must neither skip nor repeat operations or replace their results. No recovery timeout change. Fixed stage names only; no server/thread/config/error data. Parent and child spans overlap and must not be summed. Web must accept these names before the new CLI is used for measurement.
