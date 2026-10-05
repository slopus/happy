# 实施决策记录

按作出顺序保留。前期六项决策的影响分别为：另行发布、保留独立分支、额外基线合并、依赖 Ego、增加受限授权、只调整计划标题格式。其他条目包含代价。

1. Ruling: Treat plan approval as implementation authorization; package publication/production changes remain later reviewable steps, per plan T11. Continue all reversible implementation first.

2. Ruling: Preserve Paws clean root and all MISS dirty work. No product changes in root or running release.

3. Ruling: T0 must merge deployed advisor commit into isolated branch if main lacks it; no copying old build artifacts.

4. Ruling: Browser screenshots for A11 are authorized by approved plan; Ego only.

5. Ruling: First-party platform service receives scoped application authority, never user root credentials; old protocols unchanged.

6. Ruling: Plan uses T headings; copied execution plan uses Task headings solely for SDD tooling compatibility.

7. Ruling: Existing Codex createGrant selects the machine default; bound service execution must mint credentials from its authorized immutable service binding instead. T4 may add an internal scoped grant issuance path in codexAccountStore, with ownership/revocation checks, never mutate machine default or accept arbitrary profile IDs from app clients. Cost: additional integration tests; necessary for A2/A3.

8. Ruling: Historical plan line “当前只制定计划” records planning-turn status, superseded by current user approval to implement. Updated dispatch constraints accordingly; production and publish remain distinct T11 steps.

9. Ruling: v1 scopes are chat/images only; grants authorize explicit (machine,engine,account) tuples, not independent allowlists that form unintended Cartesian combinations. Runtime-default model stays nullable request, actual stays null until observed.

10. Ruling: GrantReceipt.messageKey is a recipient-side receipt shape, not permission to move personal message keys through application backend. T4/T5 must preserve existing browser-to-machine sealed-envelope exchange.

11. Ruling: Capability discovery accepts ServiceTarget before ExecutionBinding exists; use a separate trusted discovery credential context, not an execution authorization. T2 needs live models before creating a binding, so requiring a prior binding is circular. T4 wires exact-profile authorized probes and bound execution separately. Cost: one additional internal credential path and boundary tests.

12. Ruling: Retain credential-bearing job roots with ambiguous legacy process markers; never infer safe recovery from a dead stale discovery PID. New process-generation evidence has no legacy fallback. Old/shared markers lack a trustworthy discriminator. Cost: some retained jobs may need explicit process/credential recovery instead of automatic cleanup; normal legacy execution remains supported.

13. Ruling: T4 must remove live daemon I/O from T2 database transactions. Current verifyIdentity/readTrustedCatalog run while holding Machine/Profile/service locks; real probe grant redemption or refresh writes can block on those locks (or PGlite transaction serialization). Preflight authority, obtain authenticated observation outside transaction, then atomically revalidate authority/identity/revision and persist binding or accept turn. Cost: store refactor and explicit callback/revocation/default-change race tests; needed for real integration.

14. Ruling: T4 adds owner-only authenticated daemon observation of native Claude identity for initial service setup. Target-only discovery requires identityId beforehand, so cannot bootstrap it. Reuse T3 stable identity derivation; no app-grant access, inferred identity, auth JSON or tokens returned. Cost: extra owner route/probe and ownership tests; necessary for T7 setup.

15. Ruling: T5 adds durable optional appConversationId binding creation/lookup with exact-input idempotency, scoped to grant+app, plus additive schema/migration. T4 only protected turns; SDK lost creation responses and T8 migration cannot rely on memory maps. Cost: small server extension and concurrency/HTTP tests; existing callers preserved.

16. Ruling: Platform bridge must require host login and per-conversation ownership checks; app-wide grant alone cannot prove website-user ownership. Cost: explicit host hook supplied by T8 existing auth/DB, no new SSO.

17. Ruling: Retain HTTPS-or-localhost for new SDK transports; do not add a generic allowHttp flag solely for the existing documented public-IP HTTP server. T8 remains legacy by default and can validate on localhost; T11 must identify/configure HTTPS before production switching. Cost: production integration may need an HTTPS ingress endpoint; no production configuration is changed now.

18. Ruling: T6 default option says follow service defaults; do not substitute capability catalog native default for the service configured default. Current app API exposes safe refs/catalog, not full current ServiceRevision. Exact requested configuration comes from the immutable binding and actual from turn observation; owner editing remains T7. Cost: pre-conversation panel will not display an unavailable exact configured model value; a future safe config-summary API may be needed for that detail.

19. Ruling: T9/T10 packaged consumers and delivery reproduction must not depend on ignored SDD/temp probe paths. Preserve durable artifacts or reproducible hash-checked packing in the checkout before final scratch cleanup. Cost: explicit artifact storage/setup work; required so the reviewed integration survives cleanup.

20. Ruling: Legacy advisor mode/model alone is not trusted account provenance. Keep old chats readable, unbound and untransmitted until explicit platform service selection and carryHistory consent. POST /api/conversations/:id/service-binding may accept consent:true,carryHistory:true and validated model/reasoning overrides; exact service target comes from private operator configuration. Declining history creates a separate fresh conversation, leaving old ID/history unchanged. Preserve original messages and idempotent binding retries. Cost: a one-time migration choice for unproven old chats; necessary to avoid inventing the previous account or silently sending history to another service.

21. Ruling: The approved shared-service plan supersedes historical advisor DESIGN.md statements that prohibit an input-area source indicator and say the old Paws SDK has no catalog/subscription. T9 keeps the existing preferences entry and adds the approved platform/personal source indicator with advanced settings collapsed. Use the reviewed SDK active-turn observation only, not idle/model polling. Update DESIGN.md to describe the final behavior and retain other appearance/accessibility rules. Cost: a visible source indicator changes the earlier visual convention; it makes the explicitly approved source choice and immutable conversation source clear.

22. Ruling: Add optional caller-generated UUID appConversationId to advisor application conversation creation. Persist and retry the same ID and canonical creation input, with verified owner checks; omission stays compatible. Without this, a lost app response loses the local history ID even though SDK binding creation is durable. Cost: browser pending-create state and host idempotency tests; needed for end-to-end no-duplicate recovery.

23. Ruling: For a fresh advisor platform request, validate effective image permission and use SDK conversations.find(appConversationId) to compare the authorized binding with the persisted binding before reserving local messages/turn. The SDK has no separate dry-run binding validator; this reuses its trusted checks without copying scope rules. Never create or rebind as a fallback; existing pending attempts retain uncertainty behavior. Cost: one extra read per new turn and preflight failure if binding is unavailable; prevents known local SDK rejection from leaving permanent capacity occupancy.

24. Ruling: T9 new personal history may use a browser-scoped content-free binding/turn locator index because the reviewed SDK has no personal conversation-list API; no new cross-device listing promise is added. Preserve legacy encrypted history/sharing. Keep subject/source-separated non-secret locators apart from clearable connection secrets so logout/forget can leave locked history visible without deleting remote ciphertext. Encrypt pending personal input locally; never upload it or keys to platform history APIs. A fresh grant cannot be claimed to recover old keys or replay old input on a new binding. Cost: new personal history discovery is limited to its browser index and old-key availability; cross-device recovery/listing remains a separate capability.

25. Ruling: Add explicit local-only removal for new personal history entries. Confirmation states that only this browser index entry and app recovery record are removed; remote ciphertext and authorization remain. Scope to the verified subject and selected entry; keep other records and shared SDK material; block active or uncertain turns. No new remote delete/share API. Cost: local removal cannot fulfill remote erasure or restore removed locators; exact wording prevents confusing it with server deletion.

26. Ruling: T10 may add a separate server-package test harness using actual aiServiceRoutes over isolated local storage plus synthetic worker. The second application itself still imports only installed public tarballs and contains business glue. The three example files alone cannot establish genuine app isolation; the test harness must not be mislabeled as app business code or native provider evidence. Cost: additional scoped harness/tests; avoids validating only a fake SDK facade.

27. Ruling: T11 preserves reviewed local 0.3.0/0.1.0 package metadata and exact tarballs; prepare an explicitly unpublished candidate manifest and Unreleased notes with read-only registry observations. Native acceptance and production/publication remain blocked, so choose final release versions only at authorized release, repack from the approved commit and rebuild/revalidate both consumers against new hashes then. Do not imply existing versions can be overwritten. Cost: one later scoped repack/revalidation step; avoids invalidating accepted artifacts merely to speculate on a future registry version.

28. Ruling: Keep true upstream A1/A3/A4/A5, real desktop/native-phone A6, full real legacy A9 and owner daily-use outcomes unexecuted until direct evidence exists; synthetic tests cannot close them. Cost: production and broader promotion remain blocked despite local implementation progress.

29. Ruling: Production TLS/server identity/live DB/backups/drain/restore and registry versions/publication/panel automation/Web-OTA ordering remain later authorized operations, including any main merge that triggers deployments. Cost: delivery remains isolated local branches and requires a separate controlled rollout.

30. Ruling: Retain the two preexisting high dependency audit warnings as unresolved maintenance/risk items; do not silently fix unrelated dependency trees or claim a security audit was performed. Cost: a dependency assessment and risk decision remain necessary before production.

31. Ruling: Keep Claude support restricted to identities and capabilities the current adapter can verify; unverified API-key identity, arbitrary CLI versions, images or unknown native defaults are not inferred. The spec's API-configuration option is not established by current verified-native-login support. Cost: API-key-only or unverified Claude configurations require additional trusted identity/capability work and cannot be advertised as accepted now.

32. Ruling: Retain ambiguous legacy credential jobs under the earlier process-evidence rule; no automatic deletion added during final fixes. Cost: manual verified recovery may still be needed for those jobs.

33. Ruling: Keep new personal history browser-index discovery and local-only removal boundaries; cross-device listing, remote deletion and new sharing are not added in final fixes. Cost: remote ciphertext/authorization remain after local removal and lost locators/keys are not automatically restored.

34. Ruling: Do not invent remote ciphertext reclamation or unlimited retention while a storage resource ceiling exists; leave explicit lifecycle work for later without silently deleting bindings/keys. Cost: a long-running service may eventually need operator-managed retention work before reaching that ceiling.

35. Ruling: Use reviewed source/public entries plus build and artifact hashes for generated/minified delivery validation, not a claim of a full third-party supply-chain audit. Cost: dependency-internal/supply-chain behavior remains outside this code review's assurance.

36. Ruling: Keep unrelated deployed auth/direct/Glass UI restyling, Tauri, billing/SSO and further production consumers outside this final fix wave; preserve their integration boundaries. Cost: those separate enhancements remain future work.

37. Ruling: Final I1/I2 use explicit submission certainty across trusted server/SDK/host results: default uncertain; not-submitted only for proven local validation or typed transactional admission refusal. Browser input cannot assert certainty, and a persisted prior submission keeps its original ambiguity. Cost: an additive SDK/error contract and package rebuild; conservative unknown failures may still require original-ID recovery.

38. Ruling: Final scoped review confirms new load-bearing N1: concurrent fresh starts plus accepted-response loss and another typed refusal can clear the actual advisor personal pending journal. Do not park it as shippable. Continue one focused reversible remediation and independent verification under the higher-priority instruction to complete authorized necessary work, overriding the skill's no-second-final-wave process cap. Cost: an additional focused review cycle; prevents delivering a known duplicate-execution/recovery defect. Final local completion remains unclaimed.

39. Ruling: N1 uses unchanged ServiceStorage API with atomic per-request owner and immutable outcome slot. Any additional POST contender must publish/read uncertain before POST; owner may publish rejected only by atomically winning the same slot after proven refusal. Rejected blocks every conforming contender; uncertain permanently prevents refusal certainty. Legacy outboxes remain uncertain; no lease expiry or automatic evidence reclamation. All clients submitting the same binding/requestId must share the same durable storage namespace; independent stores cannot coordinate. Mixed pre-fix SDK candidates cannot obey this gate and must be stopped/reloaded before enablement; feature remains unpublished/undeployed. Cost: one durable admission record per request and an explicit coordinated-client upgrade requirement; supporting mixed old clients would need a server-side rejection ledger.
