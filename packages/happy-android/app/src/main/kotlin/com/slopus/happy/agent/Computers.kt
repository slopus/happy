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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The systems a computer's installer runs on. */
enum class ComputeSystem { Linux, MacOS, Windows }

/**
 * How a computer takes agents, fixed by the config on the computer itself, and
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

/** The agent holding an exclusive computer; [title] is null where the reader may not read its conversation. */
data class ComputeHolder(val agentId: String, val title: String?)

/** Who owns a private computer, as the reader sees them. */
sealed interface ComputeOwner {
    data object Reader : ComputeOwner
    data class Member(val userId: String, val name: String?) : ComputeOwner
}

/** A computer's mode, with what only that mode carries. */
sealed interface ComputeMode {
    val kind: ComputeModeKind

    data object Sandbox : ComputeMode { override val kind get() = ComputeModeKind.Sandbox }
    data object Shared : ComputeMode { override val kind get() = ComputeModeKind.Shared }
    data class Exclusive(val holder: ComputeHolder?) : ComputeMode { override val kind get() = ComputeModeKind.Exclusive }
    /** [owner] is null for a computer that joined before owners were kept. */
    data class Private(val owner: ComputeOwner?) : ComputeMode { override val kind get() = ComputeModeKind.Private }
}

/** Where a computer stands. A revoked computer is not listed. */
enum class ComputeStatus(val wire: String) {
    Online("online"), Offline("offline"), Draining("draining"), Enrolling("enrolling");

    companion object {
        fun of(wire: String?): ComputeStatus? = entries.firstOrNull { it.wire == wire }
    }
}

/** What the reader may do with compute: add any computer and free a held one, use computers and add a private one, or nothing. */
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

/** One computer agents can join (`GET /v0/computers`). */
data class Computer(
    val id: String,
    /** Its hostname unless someone renamed it. */
    val name: String,
    val status: ComputeStatus,
    val hostname: String?,
    /** `macos`, `linux` or `windows`, as the computer reported it. */
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

    fun releasable(access: ComputeAccess): Boolean = access == ComputeAccess.Manage && holder != null
}

/** An agent waiting for the reader to let it join one of their private computers. */
data class ComputeApproval(
    val computerId: String,
    val computerName: String?,
    val agentId: String,
    /** Null where the reader may not read that agent's conversation. */
    val agentTitle: String?,
    val createdAt: Long,
) {
    val key: String get() = "$computerId/$agentId"
}

data class ComputeSnapshot(val computers: List<Computer>, val approvals: List<ComputeApproval>)

/** The install commands, both or neither. */
class ComputeCommands(val unix: String, val windows: String)

/**
 * A new computer's one-time install. It carries a single-use secret: kept in
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

/** What a new computer will be: its mode. It joins named by its hostname. */
data class ComputeDraft(val mode: ComputeModeKind)

/**
 * Adding a computer, while its page is up: the form, its request, a refusal
 * (the form again, with why), then the install, shown once.
 */
sealed interface ComputerAdd {
    data class Choosing(val draft: ComputeDraft) : ComputerAdd
    data class Creating(val draft: ComputeDraft) : ComputerAdd
    /** [reason] is the server's own words; null when it gave none. */
    data class Failed(val draft: ComputeDraft, val reason: String?) : ComputerAdd
    class Shown(val install: ComputeInstall) : ComputerAdd

    /** The draft the form shows, or null once the install is shown. */
    val form: ComputeDraft?
        get() = when (this) {
            is Choosing -> draft
            is Creating -> draft
            is Failed -> draft
            is Shown -> null
        }

    /** Changes the draft, which takes back a refusal the earlier draft got. A member may pick only private. */
    fun edit(access: ComputeAccess, change: (ComputeDraft) -> ComputeDraft): ComputerAdd {
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
        /** A manager starts on sandbox; a member may add only a private computer of their own. */
        fun open(access: ComputeAccess): ComputerAdd? = when (access) {
            ComputeAccess.Manage -> Choosing(ComputeDraft(ComputeModeKind.Sandbox))
            ComputeAccess.Use -> Choosing(ComputeDraft(ComputeModeKind.Private))
            ComputeAccess.None -> null
        }
    }
}

/** Happy Cloud's computers in modes (happy-cluster deploy/README.md, "Compute nodes"). Every route needs `compute.use`. */
object Computers {
    private const val ROOT = "/v0/computers"

    /** The computers and the reader's join requests. Another member's private computer is [ComputeOwner.Member] with no name yet. */
    suspend fun read(client: AgentClient, readerId: String?): ComputeSnapshot {
        require(client.cloud)
        val computers = client.decode<JsonObject>("GET", ROOT)
        val approvals = client.decode<JsonObject>("GET", "$ROOT/approvals")
        return ComputeSnapshot(
            computers = list(computers, "computers").mapNotNull { computer(it, readerId) }.sortedWith(onlineFirst),
            approvals = list(approvals, "approvals").mapNotNull(::approval),
        )
    }

    /** Mints the computer's single-use join token and its install commands. */
    suspend fun create(client: AgentClient, draft: ComputeDraft): ComputeInstall? {
        require(client.cloud)
        val body = JsonObject(mapOf("mode" to JsonPrimitive(draft.mode.wire)))
        return install(client.decode<JsonObject>("POST", "$ROOT/join-tokens", body))
    }

    /** Frees an exclusive computer from the agent holding it (`pools.manage`). */
    suspend fun releaseLock(client: AgentClient, computerId: String) {
        require(client.cloud)
        client.send("POST", "$ROOT/${AgentClient.escape(computerId)}/release-lock", JsonObject(emptyMap()))
    }

    suspend fun answer(client: AgentClient, approval: ComputeApproval, approve: Boolean) {
        require(client.cloud)
        client.send(
            "POST",
            "$ROOT/approvals/${AgentClient.escape(approval.computerId)}/${AgentClient.escape(approval.agentId)}",
            JsonObject(mapOf("approve" to JsonPrimitive(approve))),
        )
    }

    /** A computer, or null for a revoked one or one in no mode this phone knows. */
    internal fun computer(node: JsonObject, readerId: String?): Computer? {
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
        return Computer(
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
        computerId = value["computerId"].str ?: return null,
        computerName = value["computerName"].text,
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

    /** Online first, then by name, so the computers that can take work lead. */
    private val onlineFirst = compareBy<Computer>({ it.status != ComputeStatus.Online }, { it.name.lowercase() })

    private val JsonElement?.text: String? get() = str?.takeIf { it.isNotEmpty() }

    private fun list(body: JsonObject, key: String): List<JsonObject> = requireNotNull(body[key].arr).mapNotNull { it.obj }
}

/**
 * Settings › Compute's computers and join requests while the page shows:
 * read on every `hello`, `runners.updated`, `compute.nodes.updated` and `compute.approvals.updated`,
 * and every few seconds, since nothing says a computer went offline.
 */
class ComputeSource(
    private val client: AgentClient,
    private val readerId: String?,
    /** Names for member IDs ([TeamDirectory.names]), for the private computers of others a manager sees. */
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
            mutable.value = State.Loaded(named(Computers.read(client, readerId)))
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
    suspend fun create(draft: ComputeDraft): ComputeInstall? = Computers.create(client, draft).also { refresh() }

    suspend fun releaseLock(computer: Computer) {
        Computers.releaseLock(client, computer.id)
        refresh()
    }

    suspend fun answer(approval: ComputeApproval, approve: Boolean) {
        Computers.answer(client, approval, approve)
        refresh()
    }

    private suspend fun named(snapshot: ComputeSnapshot): ComputeSnapshot {
        val members = snapshot.computers.mapNotNull { ((it.mode as? ComputeMode.Private)?.owner as? ComputeOwner.Member)?.userId }.toSet()
        if (members.isEmpty()) return snapshot
        val known = try {
            names(members)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyMap()
        }
        return snapshot.copy(computers = snapshot.computers.map { computer ->
            val owner = (computer.mode as? ComputeMode.Private)?.owner as? ComputeOwner.Member ?: return@map computer
            computer.copy(mode = ComputeMode.Private(owner.copy(name = known[owner.userId])))
        })
    }

    companion object {
        const val POLL_MILLIS = 4_000L
        val REFRESHED_BY = setOf(AgentEvent.HELLO, "runners.updated", "compute.nodes.updated", "compute.approvals.updated")
    }
}
