package io.elevenlabs

import io.elevenlabs.models.AudioFrame
import io.elevenlabs.models.AgentResponsePartType
import io.elevenlabs.models.ConversationEvent.ClientToolCall
import io.elevenlabs.models.ConversationMode
import io.elevenlabs.models.ConversationStatus
import io.elevenlabs.models.DisconnectionDetails

/**
 * Event emitted when the user is detected to be speaking while muted.
 *
 * @param audioLevel Audio level in dB that triggered the event
 */
data class MutedSpeechEvent(val audioLevel: Float)

/**
 * Microphone pipeline configuration.
 *
 * @param useSoftwareMute When true, the microphone track stays open when muted and outbound audio is zeroed locally. Enables [onMutedSpeech].
 * @param onMutedSpeech Invoked when local speech is detected while muted. Delivered on the main thread. Use this to show a "you're speaking while muted" indicator.
 * @param mutedSpeechThreshold Audio level in dB at which speech is detected. Defaults to -35 dB. Lower values are more sensitive.
 */
data class AudioPipelineConfiguration(
    val useSoftwareMute: Boolean = false,
    val onMutedSpeech: ((event: MutedSpeechEvent) -> Unit)? = null,
    val mutedSpeechThreshold: Float? = null,
)

/**
 * Configuration class for conversation sessions
 *
 * This class defines the parameters needed to start a conversation with an ElevenLabs agent.
 * Exactly one of [agentId], [conversationToken], or [signedUrl] must be provided.
 *
 * **Public Agents** (no authentication required):
 * - Use `agentId` only — works in both voice and text-only mode.
 * - SDK fetches the per-session token from the public endpoint.
 *
 * **Private Agents — voice (LiveKit/WebRTC):**
 * - Use `conversationToken`, generated on your backend with your API key.
 *
 * **Private Agents — text-only (raw WebSocket):**
 * - Use `signedUrl`, returned by your backend's call to
 *   `/v1/convai/conversation/get-signed-url`. The SDK opens it verbatim.
 *
 * @param agentId Agent identifier for public agents
 * @param conversationToken Pre-generated WebRTC token for private voice agents
 * @param signedUrl Pre-signed WebSocket URL for private text-only agents
 * @param userId Optional user identifier for conversation tracking
 * @param textOnly Whether to use text-only mode (true) or voice mode (false, default)
 * @param audioInputSampleRate Sample rate for audio recording in Hz (default: 48000 for high quality)
 * @param apiEndpoint Base URL for ElevenLabs API (default: "https://api.elevenlabs.io")
 * @param websocketUrl WebSocket URL for LiveKit WebRTC connection (default: "wss://livekit.rtc.elevenlabs.io")
 * @param environment Optional environment name for the agent (defaults to "production" on the server)
 * @param audioConfiguration Optional microphone pipeline settings (software mute, muted-speech callbacks)
 */
data class ConversationConfig(
    val agentId: String? = null,
    val conversationToken: String? = null,
    val signedUrl: String? = null,
    val userId: String? = null,
    val textOnly: Boolean = false,
    val audioInputSampleRate: Int = 48000,
    val apiEndpoint: String = "https://api.elevenlabs.io",
    val websocketUrl: String = "wss://livekit.rtc.elevenlabs.io",
    val environment: String? = null,
    val overrides: Overrides? = null,
    val customLlmExtraBody: Map<String, Any>? = null,
    val dynamicVariables: Map<String, Any>? = null,
    val clientTools: Map<String, ClientTool> = emptyMap(),
    val onConnect: ((conversationId: String) -> Unit)? = null,
    val onMessage: ((source: String, message: String) -> Unit)? = null,
    val onModeChange: ((mode: ConversationMode) -> Unit)? = null,
    val onStatusChange: ((status: ConversationStatus) -> Unit)? = null,
    val onCanSendFeedbackChange: ((canSend: Boolean) -> Unit)? = null,
    val onUnhandledClientToolCall: ((ClientToolCall) -> Unit)? = null,
    val onVadScore: ((score: Float) -> Unit)? = null,
    val onAudioLevelChanged: ((level: Float) -> Unit)? = null,
    val onAudioFrame: ((frame: AudioFrame) -> Unit)? = null,
    val onAudioAlignment: ((alignment: Map<String, Any>) -> Unit)? = null,
    val onAgentResponseMetadata: ((metadata: Map<String, Any>) -> Unit)? = null,
    @Deprecated("Use onUserTranscriptEvent, which also reports the server event id.")
    val onUserTranscript: ((userTranscript: String) -> Unit)? = null,
    @Deprecated("Use onAgentResponseEvent, which also reports the server event id.")
    val onAgentResponse: ((agentResponse: String) -> Unit)? = null,
    @Deprecated("Use onAgentResponseCorrectionEvent, which reports the corrected text and its event id.")
    val onAgentResponseCorrection: ((originalResponse: String, correctedResponse: String) -> Unit)? = null,
    // Finalized user transcript for a turn, with its server event id.
    val onUserTranscriptEvent: ((text: String, eventId: Int?) -> Unit)? = null,
    // In-progress user transcript, with its server event id.
    val onTentativeUserTranscriptEvent: ((text: String, eventId: Int?) -> Unit)? = null,
    // Finalized agent response for a turn, with its server event id.
    val onAgentResponseEvent: ((text: String, eventId: Int?) -> Unit)? = null,
    // Streaming agent response part (start/delta/stop), with its server event id.
    val onAgentResponsePartEvent: ((partType: AgentResponsePartType, text: String, eventId: Int?) -> Unit)? = null,
    // Corrected agent response (after interruption), with its server event id.
    val onAgentResponseCorrectionEvent: ((text: String, eventId: Int?) -> Unit)? = null,
    val onAgentToolResponse: ((toolName: String, toolCallId: String, toolType: String, isError: Boolean) -> Unit)? = null,
    val onConversationInitiationMetadata: ((conversationId: String, agentOutputFormat: String, userInputFormat: String) -> Unit)? = null,
    val onInterruption: ((eventId: Int) -> Unit)? = null,
    val onDisconnect: ((details: DisconnectionDetails) -> Unit)? = null,
    val onError: ((code: Int, message: String?) -> Unit)? = null,
    val audioConfiguration: AudioPipelineConfiguration? = null,
    val useMediaStream: Boolean = false
) {
    init {
        agentId?.let { require(it.isNotBlank()) { "agentId cannot be blank" } }
        conversationToken?.let { require(it.isNotBlank()) { "conversationToken cannot be blank" } }
        signedUrl?.let {
            require(it.isNotBlank()) { "signedUrl cannot be blank" }
            require(it.startsWith("ws://") || it.startsWith("wss://")) {
                "signedUrl must be a ws:// or wss:// URL"
            }
        }

        require(audioInputSampleRate in listOf(8000, 16000, 22050, 44100, 48000)) {
            "audioInputSampleRate must be a standard sample rate (8000, 16000, 22050, 44100, 48000 Hz)"
        }
    }

    /** True when the session authenticates with a backend-generated credential. */
    val isPrivateAgent: Boolean
        get() = conversationToken != null || signedUrl != null
}

data class Overrides(
    val agent: AgentOverrides? = null,
    val tts: TtsOverrides? = null,
    val conversation: ConversationOverrides? = null,
    val client: ClientOverrides? = null
)

data class AgentOverrides(
    val prompt: PromptOverrides? = null,
    val firstMessage: String? = null,
    val language: Language? = null
)

data class PromptOverrides(
    val prompt: String? = null
)

data class TtsOverrides(
    val voiceId: String? = null
)

data class ConversationOverrides(
    val textOnly: Boolean? = null
)

data class ClientOverrides(
    val source: String? = null,
    val version: String? = null
)

/**
 * Supported languages for ElevenLabs conversational agents.
 *
 * Source: https://help.elevenlabs.io/hc/en-us/articles/13313366263441-What-languages-do-you-support
 */
enum class Language(val code: String) {
    AF("af"),
    AR("ar"),
    AS("as"),
    AZ("az"),
    BE("be"),
    BG("bg"),
    BN("bn"),
    BS("bs"),
    CA("ca"),
    CEB("ceb"),
    CS("cs"),
    CY("cy"),
    DA("da"),
    DE("de"),
    EL("el"),
    EN("en"),
    ES("es"),
    ET("et"),
    FA("fa"),
    FI("fi"),
    FR("fr"),
    GA("ga"),
    GL("gl"),
    GU("gu"),
    HA("ha"),
    HE("he"),
    HI("hi"),
    HR("hr"),
    HU("hu"),
    HY("hy"),
    ID("id"),
    IS("is"),
    IT("it"),
    JA("ja"),
    JV("jv"),
    KA("ka"),
    KK("kk"),
    KN("kn"),
    KO("ko"),
    KY("ky"),
    LB("lb"),
    LN("ln"),
    LT("lt"),
    LV("lv"),
    MK("mk"),
    ML("ml"),
    MR("mr"),
    MS("ms"),
    NE("ne"),
    NL("nl"),
    NO("no"),
    NY("ny"),
    PA("pa"),
    PL("pl"),
    PS("ps"),
    PT("pt"),
    PT_BR("pt-br"),
    RO("ro"),
    RU("ru"),
    SD("sd"),
    SK("sk"),
    SL("sl"),
    SO("so"),
    SR("sr"),
    SV("sv"),
    SW("sw"),
    TA("ta"),
    TE("te"),
    TH("th"),
    TL("tl"),
    TR("tr"),
    UK("uk"),
    UR("ur"),
    VI("vi"),
    ZH("zh");

    companion object {
        fun fromCode(code: String): Language? = entries.find { it.code == code }
    }
}