package com.slopus.happy.agent

import com.slopus.happy.chat.arr
import com.slopus.happy.chat.long
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The systems a machine's installer runs on. */
enum class ComputeSystem { Linux, MacOS, Windows }

/**
 * How a machine takes agents, fixed by the config on the machine itself, and
 * the systems its installer accepts (happy-cluster deploy/README.md,
 * "Installing a node"). Only private installs without sudo.
 */
enum class ComputeModeKind(val wire: String, val systems: Set<ComputeSystem>) {
    Sandbox("sandbox", setOf(ComputeSystem.Linux)),
    Shared("shared", setOf(ComputeSystem.Linux)),
    Exclusive("exclusive", setOf(ComputeSystem.Linux, ComputeSystem.MacOS)),
    Private("private", setOf(ComputeSystem.Linux, ComputeSystem.MacOS, ComputeSystem.Windows));

    companion object {
        fun of(wire: String?): ComputeModeKind? = entries.firstOrNull { it.wire == wire }
    }
}

/** The agent holding an exclusive machine; [title] is null where the reader may not read its conversation. */
data class ComputeHolder(val agentId: String, val title: String?)

/** Who owns a private machine, as the reader sees them. */
sealed interface ComputeOwner {
    data object Reader : ComputeOwner
    data class Member(val userId: String, val name: String?) : ComputeOwner
}

/** A machine's mode, with what only that mode carries. */
sealed interface ComputeMode {
    val kind: ComputeModeKind

    data object Sandbox : ComputeMode { override val kind get() = ComputeModeKind.Sandbox }
    data object Shared : ComputeMode { override val kind get() = ComputeModeKind.Shared }
    data class Exclusive(val holder: ComputeHolder?) : ComputeMode { override val kind get() = ComputeModeKind.Exclusive }
    /** [owner] is null for a machine that joined before owners were kept. */
    data class Private(val owner: ComputeOwner?) : ComputeMode { override val kind get() = ComputeModeKind.Private }
}

/** Where a machine stands. A revoked machine is not listed. */
enum class ComputeStatus(val wire: String) {
    Online("online"), Offline("offline"), Draining("draining"), Enrolling("enrolling");

    companion object {
        fun of(wire: String?): ComputeStatus? = entries.firstOrNull { it.wire == wire }
    }
}

/** What the reader may do with compute: add any machine and free a held one, use machines and add a private one, or nothing. */
enum class ComputeAccess {
    Manage, Use, None;

    companion object {
        fun of(cloud: Boolean, permissions: ServerPermissions): ComputeAccess = when {
            !cloud || Permission.COMPUTE_USE !in permissions.granted -> None
            Permission.POOLS_MANAGE in permissions.granted -> Manage
            else -> Use
        }
    }
}

/** One machine agents can join (`GET /v0/compute/nodes`). */
data class ComputeMachine(
    val id: String,
    /** Its hostname unless someone renamed it. */
    val name: String,
    val status: ComputeStatus,
    val hostname: String?,
    /** `macos`, `linux` or `windows`, as the machine reported it. */
    val os: String?,
    val arch: String?,
    val mode: ComputeMode,
    /** What agents read about it in `list_compute`. */
    val description: String?,
    /** Why its sandbox failed its self-test, while it does; only managers are sent it. */
    val sandboxError: String?,
    /** When [status] last changed, in milliseconds. */
    val since: Long?,
) {
    val holder: ComputeHolder? get() = (mode as? ComputeMode.Exclusive)?.holder

    /** Online and held by an agent, so every other join is refused. */
    val busy: Boolean get() = status == ComputeStatus.Online && holder != null

    fun editable(access: ComputeAccess): Boolean =
        access == ComputeAccess.Manage || (mode as? ComputeMode.Private)?.owner == ComputeOwner.Reader

    fun releasable(access: ComputeAccess): Boolean = access == ComputeAccess.Manage && holder != null
}

/** An agent waiting for the reader to let it join one of their private machines. */
data class ComputeApproval(
    val machineId: String,
    val machineName: String?,
    val agentId: String,
    /** Null where the reader may not read that agent's conversation. */
    val agentTitle: String?,
    val createdAt: Long,
) {
    val key: String get() = "$machineId/$agentId"
}

data class ComputeSnapshot(val machines: List<ComputeMachine>, val approvals: List<ComputeApproval>)

/** The install commands, both or neither. */
class ComputeCommands(val unix: String, val windows: String)

/**
 * A new machine's one-time install. It carries a single-use secret: kept in
 * memory only, never logged or saved, and not a data class so it never prints.
 */
class ComputeInstall(
    val mode: ComputeModeKind,
    /** Null where the server publishes no installer; [token] and [clusterUrl] are then the way in. */
    val commands: ComputeCommands?,
    val token: String,
    val clusterUrl: String,
    /** In milliseconds. */
    val expiresAt: Long,
)

/** What a new machine will be: its mode, and the name and description it joins with. */
data class ComputeDraft(val mode: ComputeModeKind, val name: String = "", val description: String = "")

/**
 * Adding a machine, while its page is up: the form, its request, a refusal
 * (the form again, with why), then the install, shown once.
 */
sealed interface MachineAdd {
    data class Choosing(val draft: ComputeDraft) : MachineAdd
    data class Creating(val draft: ComputeDraft) : MachineAdd
    /** [reason] is the server's own words; null when it gave none. */
    data class Failed(val draft: ComputeDraft, val reason: String?) : MachineAdd
    class Shown(val install: ComputeInstall) : MachineAdd

    /** The draft the form shows, or null once the install is shown. */
    val form: ComputeDraft?
        get() = when (this) {
            is Choosing -> draft
            is Creating -> draft
            is Failed -> draft
            is Shown -> null
        }

    /** Changes the draft, which takes back a refusal the earlier draft got. A member may pick only private. */
    fun edit(access: ComputeAccess, change: (ComputeDraft) -> ComputeDraft): MachineAdd {
        val draft = when (this) {
            is Choosing -> draft
            is Failed -> draft
            else -> return this
        }
        val next = change(draft)
        if (next.mode != ComputeModeKind.Private && access != ComputeAccess.Manage) return this
        return Choosing(next)
    }

    /** Sends the form, or null when it is not a form that can be sent. */
    fun create(): Creating? = when (this) {
        is Choosing -> Creating(draft)
        is Failed -> Creating(draft)
        else -> null
    }

    /** Only a request under way keeps the page up. */
    val closable: Boolean get() = this !is Creating

    companion object {
        /** A manager starts on sandbox; a member may add only a private machine of their own. */
        fun open(access: ComputeAccess): MachineAdd? = when (access) {
            ComputeAccess.Manage -> Choosing(ComputeDraft(ComputeModeKind.Sandbox))
            ComputeAccess.Use -> Choosing(ComputeDraft(ComputeModeKind.Private))
            ComputeAccess.None -> null
        }
    }
}

/** Renaming or describing a machine, while its page is up. */
data class MachineEdit(val machineId: String, val name: String, val description: String, val phase: Phase = Phase.Editing) {
    sealed interface Phase {
        data object Editing : Phase
        data object Saving : Phase
        /** [reason] is the server's own words; null when it gave none. */
        data class Failed(val reason: String?) : Phase
    }

    val savable: Boolean get() = phase != Phase.Saving && name.isNotBlank()

    /**
     * `PATCH /v0/compute/nodes/:id`'s body: what differs from [machine], an
     * emptied description as `null`, which clears it. Null when nothing
     * changed or the name is empty.
     */
    fun patch(machine: ComputeMachine): JsonObject? {
        val name = name.trim().ifEmpty { return null }
        val description = description.trim().ifEmpty { null }
        val body = buildMap<String, JsonElement> {
            if (name != machine.name) put("name", JsonPrimitive(name))
            if (description != machine.description) put("description", description?.let(::JsonPrimitive) ?: JsonNull)
        }
        return body.takeIf { it.isNotEmpty() }?.let(::JsonObject)
    }

    companion object {
        fun open(machine: ComputeMachine) = MachineEdit(machine.id, machine.name, machine.description.orEmpty())
    }
}

/** Happy Cloud's machines in modes (happy-cluster deploy/README.md, "Machines"). Every route needs `compute.use`. */
object ComputeMachines {
    private const val ROOT = "/v0/compute"

    /** The machines and the reader's join requests. Another member's private machine is [ComputeOwner.Member] with no name yet. */
    suspend fun read(client: AgentClient, readerId: String?): ComputeSnapshot {
        require(client.cloud)
        val nodes = client.decode<JsonObject>("GET", "$ROOT/nodes")
        val approvals = client.decode<JsonObject>("GET", "$ROOT/approvals")
        return ComputeSnapshot(
            machines = list(nodes, "nodes").mapNotNull { machine(it, readerId) }.sortedWith(onlineFirst),
            approvals = list(approvals, "approvals").mapNotNull(::approval),
        )
    }

    /** Mints the machine's single-use join token and its install commands. */
    suspend fun create(client: AgentClient, draft: ComputeDraft): ComputeInstall? {
        require(client.cloud)
        val body = buildMap<String, JsonElement> {
            put("mode", JsonPrimitive(draft.mode.wire))
            draft.name.trim().takeIf { it.isNotEmpty() }?.let { put("name", JsonPrimitive(it)) }
            draft.description.trim().takeIf { it.isNotEmpty() }?.let { put("description", JsonPrimitive(it)) }
        }
        return install(client.decode<JsonObject>("POST", "$ROOT/join-tokens", JsonObject(body)))
    }

    suspend fun edit(client: AgentClient, machineId: String, patch: JsonObject) {
        require(client.cloud)
        client.send("PATCH", "$ROOT/nodes/${AgentClient.escape(machineId)}", patch)
    }

    /** Frees an exclusive machine from the agent holding it (`pools.manage`). */
    suspend fun releaseLock(client: AgentClient, machineId: String) {
        require(client.cloud)
        client.send("POST", "$ROOT/nodes/${AgentClient.escape(machineId)}/release-lock", JsonObject(emptyMap()))
    }

    suspend fun answer(client: AgentClient, approval: ComputeApproval, approve: Boolean) {
        require(client.cloud)
        client.send(
            "POST",
            "$ROOT/approvals/${AgentClient.escape(approval.machineId)}/${AgentClient.escape(approval.agentId)}",
            JsonObject(mapOf("approve" to JsonPrimitive(approve))),
        )
    }

    /** A node, or null for a revoked one or one in no mode this phone knows. */
    internal fun machine(node: JsonObject, readerId: String?): ComputeMachine? {
        val id = node["id"].str?.takeIf { it.isNotBlank() } ?: return null
        val status = ComputeStatus.of(node["status"].str) ?: return null
        val mode = when (ComputeModeKind.of(node["mode"].str) ?: return null) {
            ComputeModeKind.Sandbox -> ComputeMode.Sandbox
            ComputeModeKind.Shared -> ComputeMode.Shared
            ComputeModeKind.Exclusive -> ComputeMode.Exclusive(node["exclusiveAgent"].obj?.let { held ->
                held["id"].str?.let { ComputeHolder(it, held["title"].text) }
            })
            ComputeModeKind.Private -> ComputeMode.Private(node["owner"].text?.let { owner ->
                if (owner == readerId) ComputeOwner.Reader else ComputeOwner.Member(owner, null)
            })
        }
        val hostname = node["hostname"].text
        return ComputeMachine(
            id = id,
            name = node["name"].text ?: hostname ?: id.take(8),
            status = status,
            hostname = hostname,
            os = node["os"].text,
            arch = node["arch"].text,
            mode = mode,
            description = node["description"].text,
            sandboxError = node["sandboxError"].text,
            since = node["since"].long,
        )
    }

    internal fun approval(value: JsonObject): ComputeApproval? = ComputeApproval(
        machineId = value["nodeId"].str ?: return null,
        machineName = value["nodeName"].text,
        agentId = value["agentId"].str ?: return null,
        agentTitle = value["agentTitle"].text,
        createdAt = value["createdAt"].long ?: 0,
    )

    /** `expiresAt` is milliseconds: the cluster sends the token's `exp` times 1000. */
    internal fun install(answer: JsonObject): ComputeInstall? {
        val commands = answer["commands"].obj
        return ComputeInstall(
            mode = ComputeModeKind.of(answer["mode"].str) ?: return null,
            commands = commands?.let { ComputeCommands(it["unix"].str ?: return@let null, it["windows"].str ?: return@let null) },
            token = answer["token"].str ?: return null,
            clusterUrl = answer["clusterUrl"].str.orEmpty(),
            expiresAt = answer["expiresAt"].long ?: return null,
        )
    }

    /** Online first, then by name, so the machines that can take work lead. */
    private val onlineFirst = compareBy<ComputeMachine>({ it.status != ComputeStatus.Online }, { it.name.lowercase() })

    private val JsonElement?.text: String? get() = str?.takeIf { it.isNotEmpty() }

    private fun list(body: JsonObject, key: String): List<JsonObject> = requireNotNull(body[key].arr).mapNotNull { it.obj }
}

/**
 * Settings › Compute's machines and join requests while the page shows:
 * read on every `hello`, `runners.updated` and `compute.approvals.updated`,
 * and every few seconds, since nothing says a machine went offline.
 */
class ComputeSource(
    private val client: AgentClient,
    private val readerId: String?,
    /** Names for member IDs ([TeamDirectory.names]), for the private machines of others a manager sees. */
    private val names: suspend (Set<String>) -> Map<String, String> = { emptyMap() },
) {
    sealed interface State {
        data object Loading : State
        data object Failed : State
        data class Loaded(val snapshot: ComputeSnapshot) : State
    }

    private val mutable = MutableStateFlow<State>(State.Loading)
    val state = mutable.asStateFlow()
    private val lock = Mutex()

    /** A failed read keeps what was shown; only a first read that fails says so. */
    suspend fun refresh() = lock.withLock {
        try {
            mutable.value = State.Loaded(named(ComputeMachines.read(client, readerId)))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            if (mutable.value !is State.Loaded) mutable.value = State.Failed
        }
    }

    /** Called only while resumed; cancelling stops the timer, the events and a read under way. */
    suspend fun observe(events: SharedFlow<AgentEvent>, interval: Long = POLL_MILLIS) = coroutineScope {
        launch {
            events.collect { if (it.type in REFRESHED_BY) refresh() }
        }
        while (isActive) {
            refresh()
            delay(interval)
        }
    }

    /** Throws what the server said; the install is never kept here. */
    suspend fun create(draft: ComputeDraft): ComputeInstall? = ComputeMachines.create(client, draft).also { refresh() }

    suspend fun edit(machineId: String, patch: JsonObject) {
        ComputeMachines.edit(client, machineId, patch)
        refresh()
    }

    suspend fun releaseLock(machine: ComputeMachine) {
        ComputeMachines.releaseLock(client, machine.id)
        refresh()
    }

    suspend fun answer(approval: ComputeApproval, approve: Boolean) {
        ComputeMachines.answer(client, approval, approve)
        refresh()
    }

    private suspend fun named(snapshot: ComputeSnapshot): ComputeSnapshot {
        val members = snapshot.machines.mapNotNull { ((it.mode as? ComputeMode.Private)?.owner as? ComputeOwner.Member)?.userId }.toSet()
        if (members.isEmpty()) return snapshot
        val known = try {
            names(members)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyMap()
        }
        return snapshot.copy(machines = snapshot.machines.map { machine ->
            val owner = (machine.mode as? ComputeMode.Private)?.owner as? ComputeOwner.Member ?: return@map machine
            machine.copy(mode = ComputeMode.Private(owner.copy(name = known[owner.userId])))
        })
    }

    companion object {
        const val POLL_MILLIS = 4_000L
        val REFRESHED_BY = setOf(AgentEvent.HELLO, "runners.updated", "compute.approvals.updated")
    }
}
