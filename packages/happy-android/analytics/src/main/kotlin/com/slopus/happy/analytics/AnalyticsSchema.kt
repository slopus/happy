package com.slopus.happy.analytics

/**
 * The send boundary's allowlist (`docs/analytics-catalog.json`, Android's
 * events): what each event may carry and which values each property takes.
 * [check] drops an event this table doesn't list, drops properties it
 * doesn't list, and drops the whole event when a listed one holds anything
 * else, so a mistake in a typed event never sends a value the catalog
 * doesn't allow. `AnalyticsCatalogTest` holds this table to the JSON.
 */
object AnalyticsSchema {
    sealed interface Rule {
        data class OneOf(val values: Set<String>) : Rule
        data object Count : Rule
        data object Bool : Rule
        data object Version : Rule
        data object OsVersion : Rule
    }

    data class Field(val rule: Rule, val nullable: Boolean = false, val optional: Boolean = false)

    private inline fun <reified E> oneOf(nullable: Boolean = false, optional: Boolean = false): Field where E : Enum<E>, E : Wire =
        Field(Rule.OneOf(enumValues<E>().map { it.wire }.toSet()), nullable, optional)

    private fun values(vararg wire: String) = Field(Rule.OneOf(wire.toSet()))
    private val bool = Field(Rule.Bool)

    /** On every event; desktop's `arch` is not Android's. */
    val common: Map<String, Field> = mapOf(
        "client" to values("desktop", "ios", "android"),
        "app_version" to Field(Rule.Version),
        "os" to values("mac", "win", "linux", "ios", "android"),
        "os_version" to Field(Rule.OsVersion, nullable = true),
        "device_class" to values("desktop", "phone", "tablet"),
        "agent_location" to Field(Rule.OneOf(setOf("local", "remote", "relay")), nullable = true),
        "agent_os" to Field(Rule.OneOf(setOf("mac", "win", "linux", "other")), nullable = true),
        "happy_agent_version" to Field(Rule.Version, nullable = true),
        "flavor" to values("standard", "nightly", "preview", "development"),
    )

    private val product = oneOf<PurchaseProduct>()
    private val pairing = mapOf("method" to oneOf<PairingMethod>(), "start" to oneOf<PairingStart>(optional = true))
    private val created = mapOf("result" to values("ok", "failed"), "error_code" to oneOf<CreateError>(optional = true))
    private val model = oneOf<ModelFamily>(nullable = true)
    private val providerKind = oneOf<ProviderKind>(nullable = true)
    private val effort = oneOf<Effort>(nullable = true)

    val events: Map<String, Map<String, Field>> = mapOf(
        "chat_failure_shown" to mapOf(
            "kind" to oneOf<FailureKind>(),
            "provider_kind" to providerKind,
            "target" to oneOf<ChatTarget>(),
            "session_client" to oneOf<SessionClient>(),
            "is_pool" to bool,
        ),
        "chat_failure_action_clicked" to mapOf(
            "kind" to oneOf<FailureKind>(),
            "action" to oneOf<FailureAction>(),
        ),
        "agent_connection_lost" to mapOf(
            "transport" to oneOf<LinkTransport>(),
            "code" to oneOf<ConnectionCode>(),
            "outcome" to oneOf<ConnectionOutcome>(),
            "duration" to oneOf<DurationBucket>(),
            "is_recovery_screen_shown" to bool,
        ),
        "error_shown" to mapOf(
            "area" to oneOf<ErrorArea>(),
            "code" to oneOf<ErrorCode>(),
        ),
        "app_crashed" to mapOf(
            "process" to oneOf<CrashProcess>(),
            "reason" to oneOf<CrashReason>(),
            "crashed_version" to Field(Rule.Version, nullable = true),
        ),
        "mobile_pairing_completed" to pairing,
        "mobile_pairing_failed" to pairing + ("error_code" to oneOf<PairingError>()),
        "mobile_pairing_cancelled" to pairing,
        "sign_in_failed" to mapOf(
            "method" to oneOf<SignInMethod>(),
            "error_code" to oneOf<SignInError>(),
        ),
        "voice_session_error" to mapOf(
            "error_code" to oneOf<VoiceError>(),
            "duration" to oneOf<DurationBucket>(nullable = true),
        ),
        "paywall_error" to mapOf("product" to product, "error_code" to oneOf<PurchaseError>()),
        "app_opened" to mapOf(
            "notifications" to oneOf<Notifications>(optional = true),
            "agents_connected" to oneOf<Bucket>(optional = true),
            "is_cold_start" to bool,
        ),
        "message_sent" to mapOf(
            "source" to oneOf<MessageSource>(),
            "target" to oneOf<ChatTarget>(nullable = true),
            "session_client" to oneOf<SessionClient>(nullable = true),
            "model_family" to model,
            "model_provider_kind" to providerKind,
            "effort" to effort,
            "bot_system_key" to Field(Rule.OneOf(setOf("chief_of_staff")), nullable = true),
            "task_depth" to Field(Rule.Count, nullable = true),
            "has_attachment" to bool,
            "is_steering" to bool,
        ),
        "conversation_created" to mapOf(
            // Desktop's sources and the phone's one.
            "source" to values("workspace", "command_palette", "shortcut", "voice", "home"),
            "model_family" to model,
            "model_provider_kind" to providerKind,
            "effort" to effort,
        ),
        "bot_created" to mapOf("source" to values("sidebar", "voice", "home")) + created,
        "task_created" to created,
        "team_server_signed_in" to emptyMap(),
        "voice_session_stopped" to mapOf("duration" to oneOf<DurationBucket>()),
        "paywall_presented" to mapOf("product" to product),
        "paywall_purchased" to mapOf("product" to product),
        "paywall_restored" to mapOf("product" to product),
        "paywall_cancelled" to mapOf("product" to product),
    )

    private val version = Regex("^[0-9]+(\\.[0-9]+){0,3}$")
    private val osVersion = Regex("^[0-9]+(\\.[0-9]+)?$")

    /**
     * [properties] of event [name] as they may go: unknown properties left
     * out; null when the event isn't listed, a required property is
     * missing, or a value isn't allowed. [common] is checked the same way.
     */
    fun check(name: String, properties: Map<String, Any?>): Map<String, Any?>? {
        val fields = events[name] ?: return null
        return checked(fields, properties)
    }

    fun checkCommon(properties: Map<String, Any?>): Map<String, Any?>? = checked(common, properties)

    /** Whether [value] is a version string the catalog takes. */
    fun isVersion(value: String): Boolean = allows(Rule.Version, value)

    /** A version as it may go: numbers only, anything from the first `-` or `+` cut; null when that still isn't one. */
    fun version(value: String?): String? = value?.substringBefore('-')?.substringBefore('+')?.takeIf(::isVersion)

    private fun checked(fields: Map<String, Field>, properties: Map<String, Any?>): Map<String, Any?>? {
        val out = LinkedHashMap<String, Any?>()
        for ((key, field) in fields) {
            if (key !in properties) {
                if (field.optional) continue
                if (field.nullable) {
                    out[key] = null
                    continue
                }
                return null
            }
            val value = properties[key]
            if (value == null) {
                if (!field.nullable) return null
                out[key] = null
                continue
            }
            if (!allows(field.rule, value)) return null
            out[key] = value
        }
        return out
    }

    private fun allows(rule: Rule, value: Any): Boolean = when (rule) {
        is Rule.OneOf -> value is String && value in rule.values
        Rule.Count -> value.asWhole()?.let { it in 0..1_000_000 } == true
        Rule.Bool -> value is Boolean
        Rule.Version -> value is String && value.length <= 32 && version.matches(value)
        Rule.OsVersion -> value is String && osVersion.matches(value)
    }

    private fun Any.asWhole(): Long? = when (this) {
        is Int -> toLong()
        is Long -> this
        else -> null
    }
}
