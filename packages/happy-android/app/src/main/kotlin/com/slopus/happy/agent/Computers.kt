package com.slopus.happy.agent

import com.slopus.happy.chat.arr
import com.slopus.happy.chat.bool
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
enum class ComputeSystem(val wire: String) {
    Linux("linux"), MacOS("macos"), Windows("windows");

    companion object {
        /** A published build, as `linux-x86_64`. */
        fun ofPlatform(platform: String): ComputeSystem? = entries.firstOrNull { it.wire == platform.substringBefore('-') }
    }
}

/** Who may send agents to a computer, fixed when it joins: the whole team, or its owner alone. */
enum class ComputeAccess(val wire: String, val defaultConcurrency: Int) {
    Shared("shared", 8), Private("private", 1);

    companion object {
        fun of(wire: String?): ComputeAccess? = entries.firstOrNull { it.wire == wire }
    }
}

/** An agent placed on a computer; [title] is null where the reader may not read its conversation. */
data class ComputeAgent(val id: String, val title: String?)

/** Whether a computer can run restricted commands; full-access commands run either way. [reason] says why not. */
data class ComputeBoundary(val available: Boolean, val reason: String?)

/** Who owns a private computer, as the reader sees them. */
sealed interface ComputeOwner {
    data object Reader : ComputeOwner
    data class Member(val userId: String, val name: String?) : ComputeOwner
}

/** Where a computer stands. A revoked computer is not listed. */
enum class ComputeStatus(val wire: String) {
    Online("online"), Offline("offline"), Draining("draining"), Enrolling("enrolling");

    companion object {
        fun of(wire: String?): ComputeStatus? = entries.firstOrNull { it.wire == wire }
    }
}

/** What the reader may do with compute: add any computer and manage every one, use computers and add a private one, or nothing. */
enum class ComputeRole {
    Manage, Use, None;

    companion object {
        fun of(cloud: Boolean, permissions: ServerPermissions): ComputeRole = when {
            !cloud || Permission.COMPUTE_USE !in permissions.granted -> None
            Permission.POOLS_MANAGE in permissions.granted -> Manage
            else -> Use
        }
    }
}

/** How many agents a computer takes at once, as the cluster bounds it. */
object ComputeConcurrency {
    const val MIN = 1
    const val MAX = 64
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
    val access: ComputeAccess,
    /** A private computer's owner; null for a shared one or one whose owner wasn't sent. */
    val owner: ComputeOwner?,
    /** How many agents it takes at once. */
    val concurrency: Int,
    /** The most it can be set to, where the computer says. */
    val maxConcurrency: Int?,
    val agents: List<ComputeAgent>,
    val boundary: ComputeBoundary,
    /** What agents read about it in `list_compute`. */
    val description: String?,
    /** When [status] last changed, in milliseconds. */
    val since: Long?,
) {
    /** Every place taken: listed still, but no other agent joins. */
    val full: Boolean get() = agents.size >= concurrency

    /** The highest [concurrency] it may be set to. */
    val concurrencyLimit: Int get() = minOf(ComputeConcurrency.MAX, maxConcurrency ?: ComputeConcurrency.MAX).coerceAtLeast(ComputeConcurrency.MIN)

    /** A manager or the private computer's owner changes its concurrency and removes its agents. */
    fun manageable(role: ComputeRole): Boolean = role == ComputeRole.Manage || (role == ComputeRole.Use && owner == ComputeOwner.Reader)
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
    val access: ComputeAccess,
    val concurrency: Int,
    /** Null where the server publishes no installer; [token] and [clusterUrl] are then the way in. */
    val commands: ComputeCommands?,
    /** The systems with a published supervisor build; a command is shown only for these. */
    val systems: Set<ComputeSystem>,
    /** What isn't available yet, in the server's words. */
    val notice: String?,
    val token: String,
    val clusterUrl: String,
    /** In milliseconds. */
    val expiresAt: Long,
)

/** What a new computer will be: who may use it and, once picked, how many agents at once. It joins named by its hostname. */
data class ComputeDraft(val access: ComputeAccess, val concurrency: Int? = null) {
    /** What the computer will take: the one picked, or the cluster's default for [access]. */
    val agents: Int get() = concurrency ?: access.defaultConcurrency
}

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

    /** Changes the draft, which takes back a refusal the earlier draft got. A member may pick only private; concurrency stays in range. */
    fun edit(role: ComputeRole, change: (ComputeDraft) -> ComputeDraft): ComputerAdd {
        val draft = when (this) {
            is Choosing -> draft
            is Failed -> draft
            else -> return this
        }
        val next = change(draft)
        if (next.access == ComputeAccess.Shared && role != ComputeRole.Manage) return this
        if (next.concurrency != null && next.concurrency !in ComputeConcurrency.MIN..ComputeConcurrency.MAX) return this
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
        /** A manager starts on shared; a member may add only a private computer of their own. */
        fun open(role: ComputeRole): ComputerAdd? = when (role) {
            ComputeRole.Manage -> Choosing(ComputeDraft(ComputeAccess.Shared))
            ComputeRole.Use -> Choosing(ComputeDraft(ComputeAccess.Private))
            ComputeRole.None -> null
        }
    }
}

/** Happy Cloud's computers (happy-cluster deploy/README.md, "Compute nodes"). Every route needs `compute.use`. */
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

    /** Mints the computer's single-use join token and its install commands; concurrency only where the person picked one. */
    suspend fun create(client: AgentClient, draft: ComputeDraft): ComputeInstall? {
        require(client.cloud)
        val body = buildMap {
            put("access", JsonPrimitive(draft.access.wire))
            draft.concurrency?.let { put("concurrency", JsonPrimitive(it)) }
        }
        return install(client.decode<JsonObject>("POST", "$ROOT/join-tokens", JsonObject(body)))
    }

    /** How many agents the computer takes at once (`pools.manage` or the private owner). */
    suspend fun setConcurrency(client: AgentClient, computerId: String, concurrency: Int) {
        require(client.cloud)
        client.send("PATCH", "$ROOT/${AgentClient.escape(computerId)}", JsonObject(mapOf("concurrency" to JsonPrimitive(concurrency))))
    }

    /** Takes an agent off the computer, freeing its place (`pools.manage` or the private owner). */
    suspend fun removeAgent(client: AgentClient, computerId: String, agentId: String) {
        require(client.cloud)
        client.send("DELETE", "$ROOT/${AgentClient.escape(computerId)}/agents/${AgentClient.escape(agentId)}")
    }

    suspend fun answer(client: AgentClient, approval: ComputeApproval, approve: Boolean) {
        require(client.cloud)
        client.send(
            "POST",
            "$ROOT/approvals/${AgentClient.escape(approval.computerId)}/${AgentClient.escape(approval.agentId)}",
            JsonObject(mapOf("approve" to JsonPrimitive(approve))),
        )
    }

    /** A computer, or null for a revoked one or one this phone can't read. */
    internal fun computer(node: JsonObject, readerId: String?): Computer? {
        val id = node["id"].str?.takeIf { it.isNotBlank() } ?: return null
        val status = ComputeStatus.of(node["status"].str) ?: return null
        val access = ComputeAccess.of(node["access"].str) ?: return null
        val concurrency = node["concurrency"].long?.toInt()?.takeIf { it >= ComputeConcurrency.MIN } ?: return null
        val boundary = node["boundary"].obj ?: return null
        val hostname = node["hostname"].text
        return Computer(
            id = id,
            name = node["name"].text ?: hostname ?: id.take(8),
            status = status,
            hostname = hostname,
            os = node["os"].text,
            arch = node["arch"].text,
            access = access,
            owner = node["owner"].text?.takeIf { access == ComputeAccess.Private }?.let { owner ->
                if (owner == readerId) ComputeOwner.Reader else ComputeOwner.Member(owner, null)
            },
            concurrency = concurrency,
            maxConcurrency = node["maxConcurrency"].long?.toInt(),
            agents = node["agents"].arr.orEmpty().mapNotNull { agent ->
                agent.obj?.let { ComputeAgent(it["id"].str ?: return@mapNotNull null, it["title"].text) }
            },
            boundary = ComputeBoundary(
                available = boundary["available"].bool ?: return null,
                reason = boundary["reason"].text,
            ),
            description = node["description"].text,
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
        val access = ComputeAccess.of(answer["access"].str) ?: return null
        return ComputeInstall(
            access = access,
            concurrency = answer["concurrency"].long?.toInt() ?: return null,
            commands = commands?.let { ComputeCommands(it["unix"].str ?: return@let null, it["windows"].str ?: return@let null) },
            systems = answer["platforms"].arr.orEmpty().mapNotNull { platform -> platform.str?.let(ComputeSystem::ofPlatform) }.toSet(),
            notice = answer["notice"].text,
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

    suspend fun setConcurrency(computer: Computer, concurrency: Int) {
        Computers.setConcurrency(client, computer.id, concurrency)
        refresh()
    }

    suspend fun removeAgent(computer: Computer, agent: ComputeAgent) {
        Computers.removeAgent(client, computer.id, agent.id)
        refresh()
    }

    suspend fun answer(approval: ComputeApproval, approve: Boolean) {
        Computers.answer(client, approval, approve)
        refresh()
    }

    private suspend fun named(snapshot: ComputeSnapshot): ComputeSnapshot {
        val members = snapshot.computers.mapNotNull { (it.owner as? ComputeOwner.Member)?.userId }.toSet()
        if (members.isEmpty()) return snapshot
        val known = try {
            names(members)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyMap()
        }
        return snapshot.copy(computers = snapshot.computers.map { computer ->
            val owner = computer.owner as? ComputeOwner.Member ?: return@map computer
            computer.copy(owner = owner.copy(name = known[owner.userId]))
        })
    }

    companion object {
        const val POLL_MILLIS = 4_000L
        val REFRESHED_BY = setOf(AgentEvent.HELLO, "runners.updated", "compute.nodes.updated", "compute.approvals.updated")
    }
}
