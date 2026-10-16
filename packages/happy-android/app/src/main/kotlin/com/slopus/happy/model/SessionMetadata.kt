package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

// Session metadata as happy-app's storageTypes.ts `MetadataSchema` reads it.
// A document that fails the schema is no metadata at all (sessionEncryption.ts
// returns null), so [SessionMetadata.parse] returns null for it too. The raw
// object is kept: read-modify-write updates must not drop fields from newer
// writers, and a few readers look at keys the schema does not declare
// (`gitBranch`).

/** happy-wire RigBotSchema */
@Immutable
data class RigBot(
    val id: String,
    val name: String,
    val username: String,
    val workspaceId: String,
    val orderKey: String,
    /** A system bot's stable key; null for a user's own bot or from older Happy Agents. */
    val systemKey: String?,
) {
    companion object {
        val read: FieldReader<RigBot> = Read.objectOf { f ->
            RigBot(
                id = f.required("id", bounded(1, 128)),
                name = f.required("name", bounded(1, 512)),
                username = f.required("username", bounded(1, 64)),
                workspaceId = f.required("workspaceId", bounded(1, 128)),
                orderKey = f.required("orderKey", bounded(1, 64)),
                systemKey = f.nullish("systemKey", Read.string),
            )
        }

        private fun bounded(min: Int, max: Int): FieldReader<String> = {
            Read.string(it).also { s -> if (s.length !in min..max) Read.fail("string of $min..$max") }
        }
    }
}

/** `{ id, kind, name }`, the shape of `provider`, `project`, `workspace`, and each entry of `providers`. */
@Immutable
data class NamedRef(val id: String, val kind: String, val name: String) {
    companion object {
        val read: FieldReader<NamedRef> = Read.objectOf { f ->
            NamedRef(f.required("id", Read.string), f.required("kind", Read.string), f.required("name", Read.string))
        }
    }
}

@Immutable
data class ClientInfo(val id: String, val name: String, val version: String) {
    companion object {
        val read: FieldReader<ClientInfo> = Read.objectOf { f ->
            ClientInfo(f.required("id", Read.string), f.required("name", Read.string), f.required("version", Read.string))
        }
    }
}

/** One entry of `models` (session and Rig machine catalogs alike). */
@Immutable
data class ModelEntry(
    val code: String,
    val value: String,
    val description: String?,
    val id: String?,
    val name: String?,
    val providerId: String?,
    val providerKind: String?,
    val providerName: String?,
    val provider: NamedRef?,
    val contextWindow: Double?,
    val serviceTiers: List<String>?,
    val thinkingLevels: List<String>?,
    val defaultThinkingLevel: String?,
) {
    companion object {
        /** [defaultThinkingLevelNullish]: the machine catalog allows null there, the session one does not. */
        fun reader(defaultThinkingLevelNullish: Boolean): FieldReader<ModelEntry> = Read.objectOf { f ->
            ModelEntry(
                code = f.required("code", Read.string),
                value = f.required("value", Read.string),
                description = f.nullish("description", Read.string),
                id = f.optional("id", Read.string),
                name = f.optional("name", Read.string),
                providerId = f.optional("providerId", Read.string),
                providerKind = f.optional("providerKind", Read.string),
                providerName = f.optional("providerName", Read.string),
                provider = f.optional("provider", NamedRef.read),
                contextWindow = f.optional("contextWindow", Read.number),
                serviceTiers = f.optional("serviceTiers", Read.arrayOf(Read.string)),
                thinkingLevels = f.optional("thinkingLevels", Read.arrayOf(Read.string)),
                defaultThinkingLevel = if (defaultThinkingLevelNullish) {
                    f.nullish("defaultThinkingLevel", Read.string)
                } else {
                    f.optional("defaultThinkingLevel", Read.string)
                },
            )
        }
    }
}

/** `operatingModes` and `thoughtLevels` entries. */
@Immutable
data class CodeOption(val code: String, val value: String, val description: String?, val kind: String?) {
    companion object {
        val read: FieldReader<CodeOption> = Read.objectOf { f ->
            CodeOption(
                code = f.required("code", Read.string),
                value = f.required("value", Read.string),
                description = f.nullish("description", Read.string),
                kind = f.optional("kind", Read.string),
            )
        }
    }
}

/** RigComposerModeSchema; [text] is set for a RigComposerDraftSchema. */
@Immutable
data class RigComposerMode(
    val providerId: String,
    val modelId: String,
    val effort: String,
    val serviceTier: String?,
    val permissionMode: String,
    val text: String? = null,
) {
    companion object {
        private fun reader(withText: Boolean): FieldReader<RigComposerMode> = Read.objectOf { f ->
            RigComposerMode(
                providerId = f.required("providerId", Read.string),
                modelId = f.required("modelId", Read.string),
                effort = f.required("effort", Read.string),
                serviceTier = run {
                    // z.string().nullable(): present, string or null.
                    if (!f.raw.containsKey("serviceTier")) throw SchemaException("serviceTier: required")
                    f.nullish("serviceTier", Read.string)
                },
                permissionMode = f.required("permissionMode", Read.string),
                text = if (withText) f.required("text", Read.string) else null,
            )
        }
        val mode = reader(withText = false)
        val draft = reader(withText = true)
    }
}

@Immutable
data class ReasoningInfo(val current: String?, val levels: List<String>)

@Immutable
data class SessionRuntime(
    val status: String,
    val permissionMode: String?,
    val modelLocked: Boolean,
    val serviceTier: String?,
)

@Immutable
data class SessionCapabilities(
    val abort: Boolean,
    val attachmentsEnabled: Boolean,
    val attachmentsMaxBytes: Double,
    val attachmentsMediaTypes: List<String>,
    val filesBrowse: Boolean,
    val filesRead: Boolean,
    val filesSearch: Boolean,
    val filesWrite: Boolean,
    val messageReceipts: Boolean?,
    val modelSelection: Boolean,
    val reasoningSelection: Boolean,
    val permissionModeSelection: Boolean,
    val resume: Boolean,
    val rpcMethods: List<String>,
    val shell: Boolean,
    val steering: Boolean,
)

@Immutable
data class SessionActivity(
    val subagentsRunning: Double,
    val subagentsQueued: Double,
    val subagentsTotal: Double,
    val workflowsRunning: Double,
    val workflowsTotal: Double,
    val processesRunning: Double,
    val tasksPending: Double,
    val tasksInProgress: Double,
    val tasksCompleted: Double,
    val tasksTotal: Double,
)

@Immutable
data class SessionSummary(val text: String, val updatedAt: Long)

@Immutable
data class GitCounts(val changedFiles: Long, val countsExact: Boolean, val deletions: Long, val insertions: Long)

@Immutable
data class McpServerStatus(val name: String, val status: String)

@Immutable
data class SessionMetadata(
    val raw: JsonObject,
    val bot: RigBot? = null,
    val models: List<ModelEntry>? = null,
    val currentModelCode: String? = null,
    val operatingModes: List<CodeOption>? = null,
    val currentOperatingModeCode: String? = null,
    val thoughtLevels: List<CodeOption>? = null,
    val currentThoughtLevelCode: String? = null,
    val rigMetadataVersion: Long? = null,
    val client: ClientInfo? = null,
    val provider: NamedRef? = null,
    val providers: List<NamedRef>? = null,
    /** `{ providerId, id }` */
    val model: Pair<String, String>? = null,
    val currentModelProviderId: String? = null,
    val reasoning: ReasoningInfo? = null,
    val session: SessionRuntime? = null,
    val draft: RigComposerMode? = null,
    val draftUpdatedAt: Long? = null,
    val lastMode: RigComposerMode? = null,
    val capabilities: SessionCapabilities? = null,
    val activity: SessionActivity? = null,
    val path: String,
    val host: String,
    val version: String? = null,
    val name: String? = null,
    val os: String? = null,
    val summary: SessionSummary? = null,
    val lastMeaningfulMessageAt: Long? = null,
    val git: GitCounts? = null,
    val machineId: String? = null,
    val claudeSessionId: String? = null,
    val codexThreadId: String? = null,
    val tools: List<String>? = null,
    val slashCommands: List<String>? = null,
    val mcpServers: List<McpServerStatus>? = null,
    val skills: List<String>? = null,
    val homeDir: String? = null,
    val happyHomeDir: String? = null,
    val startedFromDaemon: Boolean? = null,
    val hostPid: Double? = null,
    val startedBy: String? = null,
    val flavor: String? = null,
    val project: NamedRef? = null,
    val workspace: NamedRef? = null,
    val sandbox: JsonElement? = null,
    val dangerouslySkipPermissions: Boolean? = null,
    val lifecycleState: String? = null,
    val lifecycleStateSince: Long? = null,
    val archivedBy: String? = null,
    val archiveReason: String? = null,
    val parentSessionId: String? = null,
    val forkedFromMessageId: String? = null,
    val isSideChat: Boolean? = null,
    val depth: Long? = null,
    val permissionMode: String? = null,
    val modelMode: String? = null,
    val effortLevel: String? = null,
) {
    /** The branch the agent last reported for its checkout: not in the schema, read through passthrough. */
    val gitBranch: String?
        get() = (raw["gitBranch"] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content

    companion object {
        /** MetadataSchema.safeParse: null when the document does not match. */
        fun parse(json: JsonObject): SessionMetadata? = try {
            read(JsonFields(json))
        } catch (_: SchemaException) {
            null
        }

        fun parse(text: String?): SessionMetadata? = parseJsonObject(text)?.let(::parse)

        private fun read(f: JsonFields) = SessionMetadata(
            raw = f.raw,
            bot = f.optional("bot", RigBot.read),
            models = f.optional("models", Read.arrayOf(ModelEntry.reader(defaultThinkingLevelNullish = false))),
            currentModelCode = f.optional("currentModelCode", Read.string),
            operatingModes = f.optional("operatingModes", Read.arrayOf(CodeOption.read)),
            currentOperatingModeCode = f.optional("currentOperatingModeCode", Read.string),
            thoughtLevels = f.optional(
                "thoughtLevels",
                Read.arrayOf(
                    Read.objectOf { o ->
                        CodeOption(o.required("code", Read.string), o.required("value", Read.string), o.nullish("description", Read.string), null)
                    },
                ),
            ),
            currentThoughtLevelCode = f.optional("currentThoughtLevelCode", Read.string),
            rigMetadataVersion = f.optional("rigMetadataVersion", Read.positiveInt),
            client = f.optional("client", ClientInfo.read),
            provider = f.optional("provider", NamedRef.read),
            providers = f.optional("providers", Read.arrayOf(NamedRef.read)),
            model = f.optional("model", Read.objectOf { o -> o.required("providerId", Read.string) to o.required("id", Read.string) }),
            currentModelProviderId = f.optional("currentModelProviderId", Read.string),
            reasoning = f.optional(
                "reasoning",
                Read.objectOf { o ->
                    if (!o.raw.containsKey("current")) throw SchemaException("current: required")
                    ReasoningInfo(o.nullish("current", Read.string), o.required("levels", Read.arrayOf(Read.string)))
                },
            ),
            session = f.optional(
                "session",
                Read.objectOf { o ->
                    SessionRuntime(
                        status = o.required("status", Read.string),
                        permissionMode = o.optional("permissionMode", Read.string),
                        modelLocked = o.required("modelLocked", Read.boolean),
                        serviceTier = o.optional("serviceTier", Read.string),
                    )
                },
            ),
            draft = f.caught("draft", RigComposerMode.draft),
            draftUpdatedAt = f.caught("draftUpdatedAt", Read.nonNegativeInt),
            lastMode = f.caught("lastMode", RigComposerMode.mode),
            capabilities = f.optional("capabilities", capabilities),
            activity = f.optional("activity", activity),
            path = f.required("path", Read.string),
            host = f.required("host", Read.string),
            version = f.optional("version", Read.string),
            name = f.optional("name", Read.string),
            os = f.optional("os", Read.string),
            summary = f.optional(
                "summary",
                Read.objectOf { o -> SessionSummary(o.required("text", Read.string), o.required("updatedAt", Read.long)) },
            ),
            lastMeaningfulMessageAt = f.optional("lastMeaningfulMessageAt", Read.long),
            git = f.optional(
                "git",
                Read.objectOf { o ->
                    GitCounts(
                        changedFiles = o.required("changedFiles", Read.nonNegativeInt),
                        countsExact = o.required("countsExact", Read.boolean),
                        deletions = o.required("deletions", Read.nonNegativeInt),
                        insertions = o.required("insertions", Read.nonNegativeInt),
                    )
                },
            ),
            machineId = f.optional("machineId", Read.string),
            claudeSessionId = f.optional("claudeSessionId", Read.string),
            codexThreadId = f.optional("codexThreadId", Read.string),
            tools = f.optional("tools", Read.arrayOf(Read.string)),
            slashCommands = f.optional("slashCommands", Read.arrayOf(Read.string)),
            mcpServers = f.optional(
                "mcpServers",
                Read.arrayOf(Read.objectOf { o -> McpServerStatus(o.required("name", Read.string), o.required("status", Read.string)) }),
            ),
            skills = f.optional("skills", Read.arrayOf(Read.string)),
            homeDir = f.optional("homeDir", Read.string),
            happyHomeDir = f.optional("happyHomeDir", Read.string),
            startedFromDaemon = f.optional("startedFromDaemon", Read.boolean),
            hostPid = f.optional("hostPid", Read.number),
            startedBy = f.optional("startedBy", Read.oneOf("daemon", "terminal")),
            flavor = f.nullish("flavor", Read.string),
            project = f.optional("project", NamedRef.read),
            workspace = f.optional("workspace", NamedRef.read),
            sandbox = f.nullish("sandbox", Read.any),
            dangerouslySkipPermissions = f.nullish("dangerouslySkipPermissions", Read.boolean),
            lifecycleState = f.optional("lifecycleState", Read.string),
            lifecycleStateSince = f.optional("lifecycleStateSince", Read.long),
            archivedBy = f.optional("archivedBy", Read.string),
            archiveReason = f.optional("archiveReason", Read.string),
            parentSessionId = f.optional("parentSessionId", Read.string),
            forkedFromMessageId = f.optional("forkedFromMessageId", Read.string),
            isSideChat = f.optional("isSideChat", Read.boolean),
            depth = f.caught("depth", Read.nonNegativeInt),
            permissionMode = f.nullish("permissionMode", Read.string),
            modelMode = f.nullish("modelMode", Read.string),
            effortLevel = f.nullish("effortLevel", Read.string),
        )

        private val capabilities: FieldReader<SessionCapabilities> = Read.objectOf { o ->
            val attachments = JsonFields(o.required("attachments", Read.obj))
            val files = JsonFields(o.required("files", Read.obj))
            SessionCapabilities(
                abort = o.required("abort", Read.boolean),
                attachmentsEnabled = attachments.required("enabled", Read.boolean),
                attachmentsMaxBytes = attachments.required("maxBytes", Read.number),
                attachmentsMediaTypes = attachments.required("mediaTypes", Read.arrayOf(Read.string)),
                filesBrowse = files.required("browse", Read.boolean),
                filesRead = files.required("read", Read.boolean),
                filesSearch = files.required("search", Read.boolean),
                filesWrite = files.required("write", Read.boolean),
                messageReceipts = o.optional("messageReceipts", Read.boolean),
                modelSelection = o.required("modelSelection", Read.boolean),
                reasoningSelection = o.required("reasoningSelection", Read.boolean),
                permissionModeSelection = o.required("permissionModeSelection", Read.boolean),
                resume = o.required("resume", Read.boolean),
                rpcMethods = o.required("rpcMethods", Read.arrayOf(Read.string)),
                shell = o.required("shell", Read.boolean),
                steering = o.required("steering", Read.boolean),
            )
        }

        private val activity: FieldReader<SessionActivity> = Read.objectOf { o ->
            val subagents = JsonFields(o.required("subagents", Read.obj))
            val workflows = JsonFields(o.required("workflows", Read.obj))
            val processes = JsonFields(o.required("processes", Read.obj))
            val tasks = JsonFields(o.required("tasks", Read.obj))
            SessionActivity(
                subagentsRunning = subagents.required("running", Read.number),
                subagentsQueued = subagents.required("queued", Read.number),
                subagentsTotal = subagents.required("total", Read.number),
                workflowsRunning = workflows.required("running", Read.number),
                workflowsTotal = workflows.required("total", Read.number),
                processesRunning = processes.required("running", Read.number),
                tasksPending = tasks.required("pending", Read.number),
                tasksInProgress = tasks.required("inProgress", Read.number),
                tasksCompleted = tasks.required("completed", Read.number),
                tasksTotal = tasks.required("total", Read.number),
            )
        }
    }
}
