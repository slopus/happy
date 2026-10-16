package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/** Which agent CLIs the daemon found on the machine. */
@Immutable
data class CliAvailability(
    val claude: Boolean,
    val codex: Boolean,
    val gemini: Boolean,
    val openclaw: Boolean,
    /** Older CLIs do not report it. */
    val agy: Boolean?,
    /** Rig runs its own Happy-connected daemon. */
    val rig: Boolean?,
    val detectedAt: Long,
)

@Immutable
data class MachineCapabilities(val bots: Boolean?, val newSession: Boolean?, val resume: Boolean?, val worktrees: Boolean?)

@Immutable
data class RigDefaults(val effort: String?, val modelId: String?, val permissionMode: String?, val providerId: String?)

@Immutable
data class MachineProvider(val id: String, val kind: String?, val name: String?)

@Immutable
data class SessionCreation(val idempotencyKey: String?, val pendingRetryAfterMs: Double?, val resultKinds: List<String>?)

@Immutable
data class ResumeSupport(
    val rpcAvailable: Boolean?,
    val requiresSameMachine: Boolean?,
    val requiresHappyAgentAuth: Boolean?,
    val happyAgentAuthenticated: Boolean?,
    val detectedAt: Double?,
)

/**
 * storageTypes.ts `MachineMetadataSchema`. The Rig catalog blocks catch on
 * their own, so a malformed one costs Rig session creation, not the machine.
 */
@Immutable
data class MachineMetadata(
    val raw: JsonObject,
    val host: String,
    val platform: String,
    val happyCliVersion: String,
    val happyHomeDir: String,
    val homeDir: String,
    val username: String? = null,
    val arch: String? = null,
    val displayName: String? = null,
    val daemonLastKnownStatus: String? = null,
    val daemonLastKnownPid: Double? = null,
    val shutdownRequestedAt: Long? = null,
    val shutdownSource: String? = null,
    val cliAvailability: CliAvailability? = null,
    val machineKind: String? = null,
    val rigOnly: Boolean? = null,
    val rigMetadataVersion: Long? = null,
    val client: ClientInfo? = null,
    val capabilities: MachineCapabilities? = null,
    val defaults: RigDefaults? = null,
    val providers: List<MachineProvider>? = null,
    val models: List<ModelEntry>? = null,
    val operatingModes: List<CodeOption>? = null,
    val sessionCreation: SessionCreation? = null,
    val resumeSupport: ResumeSupport? = null,
) {
    companion object {
        fun parse(json: JsonObject): MachineMetadata? = try {
            read(JsonFields(json))
        } catch (_: SchemaException) {
            null
        }

        fun parse(text: String?): MachineMetadata? = parseJsonObject(text)?.let(::parse)

        private fun read(f: JsonFields) = MachineMetadata(
            raw = f.raw,
            host = f.required("host", Read.string),
            platform = f.required("platform", Read.string),
            happyCliVersion = f.required("happyCliVersion", Read.string),
            happyHomeDir = f.required("happyHomeDir", Read.string),
            homeDir = f.required("homeDir", Read.string),
            username = f.optional("username", Read.string),
            arch = f.optional("arch", Read.string),
            displayName = f.optional("displayName", Read.string),
            daemonLastKnownStatus = f.optional("daemonLastKnownStatus", Read.oneOf("running", "shutting-down")),
            daemonLastKnownPid = f.optional("daemonLastKnownPid", Read.number),
            shutdownRequestedAt = f.optional("shutdownRequestedAt", Read.long),
            shutdownSource = f.optional("shutdownSource", Read.oneOf("happy-app", "happy-cli", "os-signal", "unknown")),
            cliAvailability = f.optional(
                "cliAvailability",
                Read.objectOf { o ->
                    CliAvailability(
                        claude = o.required("claude", Read.boolean),
                        codex = o.required("codex", Read.boolean),
                        gemini = o.required("gemini", Read.boolean),
                        openclaw = o.required("openclaw", Read.boolean),
                        agy = o.optional("agy", Read.boolean),
                        rig = o.optional("rig", Read.boolean),
                        detectedAt = o.required("detectedAt", Read.long),
                    )
                },
            ),
            machineKind = f.optional("machineKind", Read.string),
            rigOnly = f.optional("rigOnly", Read.boolean),
            rigMetadataVersion = f.optional("rigMetadataVersion", Read.positiveInt),
            client = f.optional("client", ClientInfo.read),
            capabilities = f.optional(
                "capabilities",
                Read.objectOf { o ->
                    MachineCapabilities(
                        bots = o.optional("bots", Read.boolean),
                        newSession = o.optional("newSession", Read.boolean),
                        resume = o.optional("resume", Read.boolean),
                        worktrees = o.optional("worktrees", Read.boolean),
                    )
                },
            ),
            defaults = f.caught(
                "defaults",
                Read.objectOf { o ->
                    RigDefaults(
                        effort = o.optional("effort", Read.string),
                        modelId = o.optional("modelId", Read.string),
                        permissionMode = o.optional("permissionMode", Read.string),
                        providerId = o.optional("providerId", Read.string),
                    )
                },
            ),
            providers = f.caught(
                "providers",
                Read.arrayOf(
                    Read.objectOf { o ->
                        MachineProvider(o.required("id", Read.string), o.optional("kind", Read.string), o.optional("name", Read.string))
                    },
                ),
            ),
            models = f.caught("models", Read.arrayOf(ModelEntry.reader(defaultThinkingLevelNullish = true))),
            operatingModes = f.caught("operatingModes", Read.arrayOf(CodeOption.read)),
            sessionCreation = f.caught(
                "sessionCreation",
                Read.objectOf { o ->
                    SessionCreation(
                        idempotencyKey = o.optional("idempotencyKey", Read.string),
                        pendingRetryAfterMs = o.optional("pendingRetryAfterMs", Read.number),
                        resultKinds = o.optional("resultKinds", Read.arrayOf(Read.string)),
                    )
                },
            ),
            resumeSupport = f.caught(
                "resumeSupport",
                Read.objectOf { o ->
                    ResumeSupport(
                        rpcAvailable = o.optional("rpcAvailable", Read.boolean),
                        requiresSameMachine = o.optional("requiresSameMachine", Read.boolean),
                        requiresHappyAgentAuth = o.optional("requiresHappyAgentAuth", Read.boolean),
                        happyAgentAuthenticated = o.optional("happyAgentAuthenticated", Read.boolean),
                        detectedAt = o.optional("detectedAt", Read.number),
                    )
                },
            ),
        )
    }
}

/**
 * The daemon's runtime state (`Machine.daemonState`, `z.any()` in happy-app).
 * Only the fields the machine screen shows are read out of it.
 */
@Immutable
data class DaemonState(val raw: JsonObject) {
    val pid: String? get() = scalar("pid")
    val httpPort: String? get() = scalar("httpPort")
    val startTime: Double? get() = (raw["startTime"] as? JsonPrimitive)?.let { if (it.isString) it.content.toDoubleOrNull() else it.doubleOrNull }
    val startedWithCliVersion: String? get() = scalar("startedWithCliVersion")

    /** A value as JS would print it with `String(x)`, or null where JS would treat it as falsy. */
    private fun scalar(key: String): String? {
        val p = raw[key] as? JsonPrimitive ?: return null
        if (p.isString) return p.content.ifEmpty { null }
        val d = p.doubleOrNull ?: return null
        if (d == 0.0) return null
        return if (d == Math.floor(d) && !d.isInfinite()) d.toLong().toString() else d.toString()
    }

    companion object {
        fun parse(text: String?): DaemonState? = parseJsonObject(text)?.let(::DaemonState)
    }
}
