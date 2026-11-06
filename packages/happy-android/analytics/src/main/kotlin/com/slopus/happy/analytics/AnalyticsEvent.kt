package com.slopus.happy.analytics

/**
 * The events this phone may send, typed (`docs/analytics-catalog.json`,
 * the contract shared with Happy Desktop and happy-ios). Every value is a
 * closed set, a count, a bucket or a boolean; nothing a person wrote, no
 * id, name, path, model id or message has a field here. [AnalyticsSchema] checks the
 * same again at the send boundary, and `AnalyticsCatalogTest` checks both
 * against the shared JSON.
 */
sealed interface AnalyticsEvent {
    val name: String

    /** The event's own properties as they are sent: strings, numbers, booleans or null. */
    val properties: Map<String, Any?>

    /** An event with nothing but its name. */
    sealed class Bare(override val name: String) : AnalyticsEvent {
        override val properties get() = emptyMap<String, Any?>()
    }

    // Errors

    data class ChatFailureShown(
        val kind: FailureKind,
        val providerKind: ProviderKind?,
        val isPool: Boolean,
        val target: ChatTarget,
        val sessionClient: SessionClient,
    ) : AnalyticsEvent {
        override val name get() = "chat_failure_shown"
        override val properties get() = mapOf(
            "kind" to kind.wire,
            "provider_kind" to providerKind?.wire,
            "target" to target.wire,
            "session_client" to sessionClient.wire,
            "is_pool" to isPool,
        )
    }

    data class ChatFailureActionClicked(val kind: FailureKind, val action: FailureAction) : AnalyticsEvent {
        override val name get() = "chat_failure_action_clicked"
        override val properties get() = mapOf("kind" to kind.wire, "action" to action.wire)
    }

    data class AgentConnectionLost(
        val transport: LinkTransport,
        val code: ConnectionCode,
        val outcome: ConnectionOutcome,
        val duration: DurationBucket,
    ) : AnalyticsEvent {
        override val name get() = "agent_connection_lost"
        override val properties get() = mapOf(
            "transport" to transport.wire,
            "code" to code.wire,
            "outcome" to outcome.wire,
            "duration" to duration.wire,
            // The phone has no full-window recovery screen; desktop's does.
            "is_recovery_screen_shown" to false,
        )
    }

    data class ErrorShown(val area: ErrorArea, val code: ErrorCode) : AnalyticsEvent {
        override val name get() = "error_shown"
        override val properties get() = mapOf("area" to area.wire, "code" to code.wire)
    }

    data class AppCrashed(val process: CrashProcess, val reason: CrashReason, val crashedVersion: String?) : AnalyticsEvent {
        override val name get() = "app_crashed"
        override val properties get() = mapOf("process" to process.wire, "reason" to reason.wire, "crashed_version" to crashedVersion)
    }

    /** How a phone pairing ended: linked, failed with a reason, or left. */
    sealed class MobilePairing(override val name: String) : AnalyticsEvent {
        abstract val method: PairingMethod
        abstract val start: PairingStart

        override val properties: Map<String, Any?> get() = mapOf("method" to method.wire, "start" to start.wire)
    }

    data class MobilePairingCompleted(override val method: PairingMethod, override val start: PairingStart) : MobilePairing("mobile_pairing_completed")

    data class MobilePairingCancelled(override val method: PairingMethod, override val start: PairingStart) : MobilePairing("mobile_pairing_cancelled")

    data class MobilePairingFailed(override val method: PairingMethod, override val start: PairingStart, val errorCode: PairingError) :
        MobilePairing("mobile_pairing_failed") {
        override val properties get() = super.properties + ("error_code" to errorCode.wire)
    }

    data class SignInFailed(val method: SignInMethod, val errorCode: SignInError) : AnalyticsEvent {
        override val name get() = "sign_in_failed"
        override val properties get() = mapOf("method" to method.wire, "error_code" to errorCode.wire)
    }

    /** A voice session that failed to start ([duration] null) or dropped. */
    data class VoiceSessionError(val errorCode: VoiceError, val duration: DurationBucket?) : AnalyticsEvent {
        override val name get() = "voice_session_error"
        override val properties get() = mapOf("error_code" to errorCode.wire, "duration" to duration?.wire)
    }

    data class PaywallError(val product: PurchaseProduct, val errorCode: PurchaseError) : AnalyticsEvent {
        override val name get() = "paywall_error"
        override val properties get() = mapOf("product" to product.wire, "error_code" to errorCode.wire)
    }

    // Use

    /** A cold start or a return after half an hour, with the phone's setup as it is then. */
    data class AppOpened(val isColdStart: Boolean, val configuration: Configuration = Configuration()) : AnalyticsEvent {
        /** What is known of the setup; what isn't is left out. */
        data class Configuration(
            val notifications: Notifications? = null,
            val agentsConnected: Bucket? = null,
        )

        override val name get() = "app_opened"
        override val properties: Map<String, Any?> get() = buildMap {
            put("is_cold_start", isColdStart)
            configuration.notifications?.let { put("notifications", it.wire) }
            configuration.agentsConnected?.let { put("agents_connected", it.wire) }
        }
    }

    data class MessageSent(
        val source: MessageSource,
        val target: ChatTarget?,
        val sessionClient: SessionClient?,
        /** The model id as the computer names it; only its [ModelFamily] is sent. */
        val model: String?,
        val modelProviderKind: ProviderKind?,
        val effort: Effort?,
        val chiefOfStaff: Boolean = false,
        val taskDepth: Int?,
        val hasAttachment: Boolean,
        /** Sent while the agent was still working. */
        val isSteering: Boolean,
    ) : AnalyticsEvent {
        override val name get() = "message_sent"
        override val properties get() = mapOf(
            "source" to source.wire,
            "target" to target?.wire,
            "session_client" to sessionClient?.wire,
            "model_family" to model?.let { ModelFamily.of(it).wire },
            "model_provider_kind" to modelProviderKind?.wire,
            "effort" to effort?.wire,
            "bot_system_key" to if (chiefOfStaff) "chief_of_staff" else null,
            "task_depth" to taskDepth,
            "has_attachment" to hasAttachment,
            "is_steering" to isSteering,
        )
    }

    /** A new conversation's first message went; the phone starts every one from home. */
    data class ConversationCreated(val model: String?, val modelProviderKind: ProviderKind?, val effort: Effort?) : AnalyticsEvent {
        override val name get() = "conversation_created"
        override val properties get() = mapOf(
            "source" to "home",
            "model_family" to model?.let { ModelFamily.of(it).wire },
            "model_provider_kind" to modelProviderKind?.wire,
            "effort" to effort?.wire,
        )
    }

    /** A bot made from home, as the attempt ended; [errorCode] only when it failed. */
    data class BotCreated(val errorCode: CreateError?) : AnalyticsEvent {
        override val name get() = "bot_created"
        override val properties: Map<String, Any?> get() = buildMap {
            put("source", "home")
            put("result", if (errorCode == null) "ok" else "failed")
            errorCode?.let { put("error_code", it.wire) }
        }
    }

    data class TaskCreated(val errorCode: CreateError?) : AnalyticsEvent {
        override val name get() = "task_created"
        override val properties: Map<String, Any?> get() = buildMap {
            put("result", if (errorCode == null) "ok" else "failed")
            errorCode?.let { put("error_code", it.wire) }
        }
    }

    data object TeamServerSignedIn : Bare("team_server_signed_in")

    data class VoiceSessionStopped(val duration: DurationBucket) : AnalyticsEvent {
        override val name get() = "voice_session_stopped"
        override val properties get() = mapOf("duration" to duration.wire)
    }

    /** The paywall's steps for [product]: presented, purchased, restored, cancelled. */
    data class Paywall(val step: PaywallStep, val product: PurchaseProduct) : AnalyticsEvent {
        override val name get() = step.event
        override val properties get() = mapOf("product" to product.wire)
    }

}

/** A value of one of the catalog's closed sets, as it is sent. */
interface Wire {
    val wire: String
}

enum class FailureKind(override val wire: String) : Wire {
    SigninMissing("signin_missing"),
    UsageLimit("usage_limit"),
    NoAccountAvailable("no_account_available"),
    RateLimited("rate_limited"),
    ProviderUnavailable("provider_unavailable"),
    Network("network"),
    ContextTooLong("context_too_long"),
    ProviderDisabled("provider_disabled"),
    Internal("internal"),
    /** A kind this build doesn't know. */
    Other("other"),
    /** An error with no typed failure: an older daemon. */
    Untyped("untyped");

    companion object {
        /** The failure's wire `kind`; null when the message carried no typed failure. */
        fun of(kind: String?): FailureKind = when (kind) {
            null -> Untyped
            else -> entries.firstOrNull { it.wire == kind && it != Other && it != Untyped } ?: Other
        }
    }
}

enum class ProviderKind(override val wire: String) : Wire {
    Claude("claude"), Codex("codex"), Grok("grok"), Bedrock("bedrock"), Anthropic("anthropic"),
    Gemini("gemini"), Glm("glm"), Kimi("kimi"), OpenAi("openai"), Other("other");

    companion object {
        /** A provider's configured `type`; null when there is none. */
        fun of(type: String?): ProviderKind? = type?.takeIf { it.isNotEmpty() }?.let { value -> entries.firstOrNull { it.wire == value } ?: Other }
    }
}

enum class ChatTarget(override val wire: String) : Wire { ChiefOfStaff("chief_of_staff"), Bot("bot"), Session("session") }

enum class SessionClient(override val wire: String) : Wire { HappyAgent("happy_agent"), Cli("cli") }

enum class FailureAction(override val wire: String) : Wire {
    Retry("retry"), SwitchModel("switch_model"), NewChat("new_chat"), AskChief("ask_chief"),
    SignIn("sign_in"), CopyCommand("copy_command"), OpenSettings("open_settings"),
}

enum class LinkTransport(override val wire: String) : Wire { Local("local"), Remote("remote"), Direct("direct"), Relay("relay") }

enum class ConnectionCode(override val wire: String) : Wire {
    Unreachable("unreachable"), Timeout("timeout"), AuthExpired("auth_expired"), Revoked("revoked"),
    VersionMismatch("version_mismatch"), EdgeBlocked("edge_blocked"), ServerError("server_error"), Unknown("unknown"),
}

enum class ConnectionOutcome(override val wire: String) : Wire {
    Recovered("recovered"), Restarted("restarted"), GaveUp("gave_up"), Backgrounded("backgrounded"), Closed("closed"),
}

enum class DurationBucket(override val wire: String, private val belowMillis: Long) : Wire {
    Under10s("under_10s", 10_000),
    From10sTo30s("10s_to_30s", 30_000),
    From30sTo2m("30s_to_2m", 120_000),
    From2mTo5m("2m_to_5m", 300_000),
    From5mTo15m("5m_to_15m", 900_000),
    From15mTo1h("15m_to_1h", 3_600_000),
    Over1h("over_1h", Long.MAX_VALUE);

    companion object {
        fun of(millis: Long): DurationBucket = entries.first { millis < it.belowMillis }
    }
}

enum class ErrorArea(override val wire: String) : Wire {
    ConversationLoad("conversation_load"), MessageSend("message_send"), AttachmentUpload("attachment_upload"),
    FileLoad("file_load"), DiffLoad("diff_load"), ArtifactLoad("artifact_load"), BrowserLoad("browser_load"),
    Terminal("terminal"), Voice("voice"), ModelList("model_list"), SettingsSave("settings_save"),
    PushSetup("push_setup"), Update("update"), UiRender("ui_render"),
}

enum class ErrorCode(override val wire: String) : Wire {
    Offline("offline"), Timeout("timeout"), Unauthorized("unauthorized"), Forbidden("forbidden"), NotFound("not_found"),
    Conflict("conflict"), TooLarge("too_large"), RateLimited("rate_limited"), ServerError("server_error"), Refused("refused"),
    VersionMismatch("version_mismatch"), InvalidResponse("invalid_response"), Unsupported("unsupported"), Unknown("unknown");

    companion object {
        /** An HTTP status's class. */
        fun ofStatus(status: Int): ErrorCode = when (status) {
            401 -> Unauthorized
            403 -> Forbidden
            404, 410 -> NotFound
            409, 412 -> Conflict
            413 -> TooLarge
            429 -> RateLimited
            408, 504 -> Timeout
            in 500..599 -> ServerError
            in 400..499 -> Refused
            else -> Unknown
        }
    }
}

enum class CrashProcess(override val wire: String) : Wire { Main("main"), Renderer("renderer"), App("app"), Extension("extension") }

enum class CrashReason(override val wire: String) : Wire {
    Crash("crash"), NativeCrash("native_crash"), Oom("oom"), Hang("hang"), Killed("killed"),
    LaunchFailed("launch_failed"), Integrity("integrity"), Unknown("unknown"),
}

enum class PairingMethod(override val wire: String) : Wire { Relay("relay"), Direct("direct") }

/** How the code reached the phone. */
enum class PairingStart(override val wire: String) : Wire { Scan("scan"), PasteLink("paste_link"), OpenedLink("opened_link") }

enum class PairingError(override val wire: String) : Wire {
    InvalidCode("invalid_code"), Expired("expired"), Rejected("rejected"), EmojiMismatch("emoji_mismatch"),
    InvalidProof("invalid_proof"), InvalidResponse("invalid_response"), Unavailable("unavailable"), Revoked("revoked"),
    Disabled("disabled"), UpdateRequired("update_required"), ProfileRequired("profile_required"),
    SignInRequired("sign_in_required"), Unknown("unknown"),
}

enum class SignInMethod(override val wire: String) : Wire { RelayCreate("relay_create"), RelayRestore("relay_restore"), TeamServer("team_server") }

enum class SignInError(override val wire: String) : Wire {
    InvalidAddress("invalid_address"), NoSignIn("no_sign_in"), EdgeBlocked("edge_blocked"), Unreachable("unreachable"),
    Denied("denied"), Expired("expired"), InvalidToken("invalid_token"), Rejected("rejected"),
    ProfileRequired("profile_required"), WrongServer("wrong_server"), Unknown("unknown"),
}

enum class VoiceError(override val wire: String) : Wire {
    MicDenied("mic_denied"), ConnectFailed("connect_failed"), Dropped("dropped"), QuotaExhausted("quota_exhausted"), Unknown("unknown"),
}

enum class PurchaseProduct(override val wire: String) : Wire { Pro("pro"), Support("support"), Voice("voice"), Other("other") }

enum class PaywallStep(val event: String) {
    Presented("paywall_presented"), Purchased("paywall_purchased"), Restored("paywall_restored"), Cancelled("paywall_cancelled"),
}

enum class PurchaseError(override val wire: String) : Wire {
    StoreUnavailable("store_unavailable"), PaymentInvalid("payment_invalid"), NotAllowed("not_allowed"),
    Network("network"), VerificationFailed("verification_failed"), NothingToRestore("nothing_to_restore"), Pending("pending"),
    Unknown("unknown"),
}

/** A failed create's reason, as desktop's create events have it. */
enum class CreateError(override val wire: String) : Wire { Refused("refused"), Offline("offline"), Unknown("unknown") }

enum class MessageSource(override val wire: String) : Wire {
    Chat("chat"), NewSession("new_session"), Voice("voice"), NotificationReply("notification_reply"), Share("share"),
}

enum class Effort(override val wire: String) : Wire {
    Off("off"), On("on"), Minimal("minimal"), Low("low"), Medium("medium"), High("high"), XHigh("xhigh"), Max("max"), Ultra("ultra");

    companion object {
        fun of(value: String?): Effort? = entries.firstOrNull { it.wire == value }
    }
}

/** `0 | 1 | 2 | 3+`. */
enum class Bucket(override val wire: String) : Wire {
    Zero("0"), One("1"), Two("2"), ThreeOrMore("3+");

    companion object {
        fun of(count: Int): Bucket = entries[count.coerceIn(0, 3)]
    }
}

enum class Notifications(override val wire: String) : Wire { Granted("granted"), Denied("denied"), NotAsked("not_asked") }

/**
 * The catalog's `model_family_rule`: a model id's family by the first
 * prefix it starts with, a `providerId:` prefix stripped first; anything
 * else, every custom or self-hosted model included, is [Other]. The id
 * itself never leaves the phone.
 */
enum class ModelFamily(override val wire: String) : Wire {
    ClaudeOpus("claude_opus"), ClaudeSonnet("claude_sonnet"), ClaudeHaiku("claude_haiku"), ClaudeFable("claude_fable"),
    Gpt("gpt"), Grok("grok"), Gemini("gemini"), Glm("glm"), Kimi("kimi"), Other("other");

    companion object {
        /** In the catalog's order. */
        val rules: List<Pair<String, ModelFamily>> = listOf(
            "anthropic/opus" to ClaudeOpus,
            "anthropic/claude-opus" to ClaudeOpus,
            "anthropic/sonnet" to ClaudeSonnet,
            "anthropic/claude-sonnet" to ClaudeSonnet,
            "anthropic/haiku" to ClaudeHaiku,
            "anthropic/claude-haiku" to ClaudeHaiku,
            "anthropic/fable" to ClaudeFable,
            "openai/gpt" to Gpt,
            "xai/grok" to Grok,
            "google/gemini" to Gemini,
            "zai/glm" to Glm,
            "moonshotai/kimi" to Kimi,
        )

        fun of(modelId: String): ModelFamily {
            val bare = modelId.substringAfter(':')
            return rules.firstOrNull { (prefix, _) -> bare.startsWith(prefix) }?.second ?: Other
        }
    }
}
