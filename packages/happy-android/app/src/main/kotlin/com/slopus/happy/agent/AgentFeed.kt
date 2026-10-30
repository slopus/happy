package com.slopus.happy.agent

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** One row of an agent connection's home. [key] is stable for the row's whole life. */
@Immutable
sealed interface AgentFeedRow {
    val key: String

    /** A section heading: bots, tasks, or one project. */
    data class Section(val section: AgentFeedSection) : AgentFeedRow {
        override val key get() = "section-${section.key}"
    }

    /** One conversation; [depth] 1 and 2 are subtasks under the row above. */
    data class Conversation(
        val agentId: String,
        /** The bot's or task's name, the agent's title, or null before it has one. */
        val title: String?,
        val kind: ConversationKind,
        /** Where it runs: the workspace, for an agent in a project's child workspace. */
        val detail: String?,
        val depth: Int,
        /** What the avatar is drawn from, and a bot's ThumbHash. */
        val avatarId: String,
        val thumbhash: String? = null,
        val working: Boolean = false,
        val unread: Boolean = false,
        /** A question waits for the person. */
        val blocked: Boolean = false,
        val activityAt: Long = 0,
        /** The conversation this subtask is under; null at the top. */
        val parentId: String? = null,
        /** How many subtask rows follow under this one, at any depth. */
        val childCount: Int = 0,
    ) : AgentFeedRow {
        override val key get() = "agent-$agentId"
    }
}

enum class ConversationKind { Bot, Task, Project, Subtask }

@Immutable
sealed interface AgentFeedSection {
    val key: String

    data object Bots : AgentFeedSection {
        override val key = "bots"
    }

    data object Tasks : AgentFeedSection {
        override val key = "tasks"
    }

    data class Project(val id: String, val name: String, val thumbhash: String?, val home: Boolean) : AgentFeedSection {
        override val key get() = "project-$id"
    }
}

/** What home shows for an agent connection. [loaded] is false until a snapshot (cached or read) is in. */
@Immutable
data class AgentFeed(val loaded: Boolean = false, val rows: List<AgentFeedRow> = emptyList()) {
    val conversations: List<AgentFeedRow.Conversation> get() = rows.filterIsInstance<AgentFeedRow.Conversation>()

    /** The name home shows for [agentId]'s row; null if home has no row for it or the row has no name yet. */
    fun title(agentId: String): String? = rows.firstNotNullOfOrNull { row ->
        (row as? AgentFeedRow.Conversation)?.takeIf { it.agentId == agentId }?.title
    }

    companion object {
        val Empty = AgentFeed()

        /**
         * The conversations the person can open, in the agent's own orders,
         * never by activity, so nothing moves while nothing is done: bots
         * (catalog order), then the tasks in the person's list (their
         * order), then each project's conversations, its root workspace's
         * first and then each child workspace's. Under each, its active
         * subtasks, at most two levels (API.md, "Agents"). Archived ones,
         * hidden subagents and Stem Cells' Surfaces are left out.
         */
        fun derive(catalog: AgentCatalog): AgentFeed {
            if (!catalog.loaded) return Empty
            val rows = ArrayList<AgentFeedRow>()
            val shown = HashSet<String>()

            fun active(resource: JsonObject) = resource["archivedAt"].isNullish() &&
                (resource.string("status") ?: "active") == "active"

            fun agentRows(
                agentId: String, title: String?, kind: ConversationKind, detail: String?, avatarId: String, thumbhash: String?, depth: Int,
                parentId: String? = null,
            ) {
                val agent = catalog.agents[agentId] ?: return
                val wire = AgentCatalog.decodeAgent(agent) ?: return
                if (wire.archivedAt != null || !wire.visible || !shown.add(agentId)) return
                val at = rows.size
                rows += AgentFeedRow.Conversation(
                    agentId = agentId,
                    title = title?.takeIf { it.isNotBlank() } ?: wire.title?.takeIf { it.isNotBlank() },
                    kind = kind,
                    detail = detail,
                    depth = depth,
                    avatarId = avatarId,
                    thumbhash = thumbhash,
                    working = wire.working,
                    unread = wire.unread != null,
                    blocked = wire.pendingQuestionId != null,
                    activityAt = wire.unread?.since ?: wire.updatedAt,
                    parentId = parentId,
                )
                if (depth >= 2) return
                for (child in (agent["subtasks"] as? JsonArray).orEmpty()) {
                    val childId = (child as? JsonObject)?.string("id") ?: continue
                    agentRows(childId, null, ConversationKind.Subtask, null, childId, null, depth + 1, agentId)
                }
                val children = rows.size - at - 1
                if (children > 0) rows[at] = (rows[at] as AgentFeedRow.Conversation).copy(childCount = children)
            }

            fun section(section: AgentFeedSection, body: () -> Unit) {
                val at = rows.size
                rows += AgentFeedRow.Section(section)
                body()
                if (rows.size == at + 1) rows.removeAt(at)
            }

            section(AgentFeedSection.Bots) {
                catalog.bots.values.filter(::active).sortedWith(byOrderKey).forEach { bot ->
                    val agentId = (bot["agent"] as? JsonObject)?.string("id") ?: return@forEach
                    val id = bot.string("id") ?: return@forEach
                    val thumbhash = (bot["avatar"] as? JsonObject)?.string("thumbhash")
                    agentRows(agentId, bot.string("name"), ConversationKind.Bot, null, id, thumbhash, 0)
                }
            }
            section(AgentFeedSection.Tasks) {
                catalog.memberships.values.sortedWith(byOrderKey).forEach { membership ->
                    val task = membership.string("taskId")?.let(catalog.tasks::get)?.takeIf(::active) ?: return@forEach
                    val agentId = (task["agent"] as? JsonObject)?.string("id") ?: return@forEach
                    agentRows(agentId, task.string("name"), ConversationKind.Task, null, agentId, null, 0)
                }
            }
            catalog.projects.values.filter(::active).sortedWith(byOrderKey).forEach { project ->
                val id = project.string("id") ?: return@forEach
                val avatar = project["avatar"] as? JsonObject
                val heading = AgentFeedSection.Project(id, project.string("name").orEmpty(), avatar?.string("thumbhash"), avatar?.string("kind") == "home")
                section(heading) {
                    fun series(owner: JsonObject, detail: String?) {
                        (owner["agents"] as? JsonArray).orEmpty().forEach { embedded ->
                            val agentId = (embedded as? JsonObject)?.string("id") ?: return@forEach
                            // A workspace-bound subtask shows under the work that made it.
                            if (catalog.agents[agentId]?.get("subtask")?.toString() == "true") return@forEach
                            agentRows(agentId, null, ConversationKind.Project, detail, agentId, null, 0)
                        }
                    }
                    series(project, null)
                    catalog.workspaces.values
                        .filter { it.string("projectId") == id && it.string("id") != id && active(it) }
                        .sortedWith(byOrderKey)
                        .forEach { workspace -> series(workspace, workspace.string("name")) }
                }
            }
            return AgentFeed(loaded = true, rows = rows)
        }

        private val byOrderKey = compareBy<JsonObject>({ it.string("orderKey") ?: "\uFFFF" }, { it.string("id") ?: it.string("taskId") })

        /** [next] with every row equal to one in [previous] kept as that instance, so Compose skips it. */
        fun reuse(previous: AgentFeed?, next: AgentFeed): AgentFeed {
            if (previous == null) return next
            if (previous == next) return previous
            val old = previous.rows.associateBy { it.key }
            return next.copy(rows = next.rows.map { row -> old[row.key]?.takeIf { it == row } ?: row })
        }
    }
}
