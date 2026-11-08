package com.slopus.happy.agent

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull

internal const val SURFACE_JOIN = "surface.join"

/** Pending membership and name changes apply to every Surface reader, including home. */
internal fun AgentCatalog.withSurfaceIntents(intents: List<Intent>): AgentCatalog = intents.fold(this) { catalog, intent ->
    when {
        intent.kind == SURFACE_JOIN -> catalog.withJoinedSurface(intent.target)
        intent.kind == Intent.LEAVE && intent.of == "surface" -> catalog.withoutSurface(intent.target)
        intent.kind == Intent.RENAME && intent.of == "surface" ->
            intent.value.string("title")?.let { catalog.withName("surface", intent.target, it) } ?: catalog
        else -> catalog
    }
}

/** The Surface kinds the computer makes (happy-agent-client `protocol/surfaces.ts`); the wire may add more. */
object SurfaceType {
    const val TODO = "todo"
    const val DOCUMENT = "document"
    const val CALENDAR = "calendar"
    const val SYSTEM_MONITOR = "system_monitor"
    const val VAULT = "vault"
    const val CHAT = "chat"
    const val ARTIFACT = "artifact"
    const val BOT = "bot"
    const val TASK = "task"
}

/** What the person may do in a vault (a vault Surface's `access`); a server that doesn't say allows writing. */
enum class VaultAccess {
    None, Read, Write;

    companion object {
        fun of(value: String?): VaultAccess = when (value) {
            "none" -> None
            "read" -> Read
            else -> Write
        }
    }
}

/** One person in a Surface: when they joined and where it sits in their own list. */
data class SurfaceMember(val userId: String?, val orderKey: String, val joinedAt: Long?)

/**
 * What a reference Surface (an artifact, bot or task kept in the list) points
 * at; [available] false when the reader can't see it, which names nothing.
 */
data class SurfaceTarget(val type: String, val id: String?, val name: String?, val available: Boolean)

/**
 * One shared Surface as the computer describes it (`surfaceSchema`): its
 * kind, name and members, who made it, its shared agent chat once opened,
 * and what a reference Surface points at.
 */
data class Surface(
    val id: String,
    val type: String,
    val name: String,
    val members: List<SurfaceMember> = emptyList(),
    val creatorUserId: String? = null,
    val chatAgentId: String? = null,
    val target: SurfaceTarget? = null,
    val thumbhash: String? = null,
    val version: String? = null,
    /** A vault's: what the person may do in it. */
    val access: VaultAccess = VaultAccess.Write,
    /** The team's Policy vault (`policyVault`): its instructions and security rules, which keep their places. */
    val policyVault: Boolean = false,
) {
    /** A Policy vault is marked even for its writers; an ordinary inaccessible vault is marked too. */
    val showsLock: Boolean get() = type == SurfaceType.VAULT && (policyVault || access == VaultAccess.None)

    /** Whether [userId] is in it; for the paired person, whether it is in their list. */
    fun joinedBy(userId: String?): Boolean = members.any { it.userId == userId }

    companion object {
        /** Reads one Surface as the wire sends it; null without an id or kind. */
        fun parse(value: JsonObject): Surface? {
            val id = value.string("id") ?: return null
            val type = value.string("type") ?: return null
            val target = (value["target"] as? JsonObject)?.let { t ->
                val kind = t.string("type") ?: return@let null
                SurfaceTarget(
                    type = kind,
                    id = t.string("artifactId") ?: t.string("botId") ?: t.string("taskId"),
                    name = t.string("name"),
                    available = t.string("state") == "available",
                )
            }
            return Surface(
                id = id,
                type = type,
                name = value.string("name").orEmpty(),
                members = (value["members"] as? JsonArray).orEmpty().mapNotNull { m ->
                    val member = m as? JsonObject ?: return@mapNotNull null
                    SurfaceMember(member.string("userId"), member.string("orderKey").orEmpty(), (member["joinedAt"] as? JsonPrimitive)?.longOrNull)
                },
                creatorUserId = value.string("creatorUserId"),
                chatAgentId = value.string("chatAgentId"),
                target = target,
                thumbhash = (value["image"] as? JsonObject)?.string("thumbhash"),
                version = value.string("version"),
                access = VaultAccess.of(value.string("access")),
                policyVault = (value["policyVault"] as? JsonPrimitive)?.booleanOrNull == true,
            )
        }
    }
}

/**
 * Every Surface on the computer, joined or not, as the kept catalog holds
 * it (iOS's `SurfaceCatalogFeed.State`): read from disk first, then the
 * snapshot, and again after each `surface.*` event.
 */
data class SurfaceCatalog(
    val surfaces: List<Surface> = emptyList(),
    /** The paired person, whose memberships say what is in their list. */
    val userId: String? = null,
    /** Something was read, from disk or the computer. */
    val loaded: Boolean = false,
) {
    operator fun get(id: String): Surface? = surfaces.firstOrNull { it.id == id }

    fun joined(surface: Surface): Boolean = surface.joinedBy(userId)

    /** The Surfaces of [type], by name as people sort it, then id. */
    fun of(type: String): List<Surface> = surfaces.filter { it.type == type }.sortedWith(byName)

    companion object {
        private val collator = java.text.Collator.getInstance().apply { strength = java.text.Collator.SECONDARY }
        private val byName = Comparator<Surface> { a, b -> collator.compare(a.name, b.name).takeIf { it != 0 } ?: a.id.compareTo(b.id) }

        fun of(catalog: AgentCatalog): SurfaceCatalog = SurfaceCatalog(
            surfaces = catalog.surfaces.values
                .filter { it.string("status") != "archived" && it["archivedAt"].isNullish() }
                .mapNotNull(Surface::parse),
            userId = catalog.userId,
            loaded = catalog.loaded,
        )
    }
}
