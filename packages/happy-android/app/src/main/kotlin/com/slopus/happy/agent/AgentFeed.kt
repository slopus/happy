package com.slopus.happy.agent

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** One row of an agent connection's home. [key] is stable for the row's whole life. */
@Immutable
sealed interface AgentFeedRow {
    val key: String

    /** Where a section starts: its rows are one card. It has no title, as on iOS. */
    data class Section(val section: AgentFeedSection) : AgentFeedRow {
        override val key get() = "section-${section.key}"
    }

    /**
     * A project, or one of its worktrees at [depth] 1: its conversations
     * follow, a level in. It opens nothing. [picture] is the repo's own,
     * for a repo the agent cloned (`project.avatar`); null for any other.
     */
    data class Folder(val id: String, val name: String, val depth: Int, val picture: String? = null) : AgentFeedRow {
        override val key get() = "folder-$id"
    }

    /** One conversation; its subtasks follow it, a level in. */
    data class Conversation(
        val agentId: String,
        /** The bot's or task's name, the agent's title, or null before it has one. */
        val title: String?,
        val kind: ConversationKind,
        val depth: Int,
        /** A bot's picture as the agent serves it (`/v0/bots/:id/avatar`) and its ThumbHash; null where it has none. */
        val picture: String? = null,
        val thumbhash: String? = null,
        val working: Boolean = false,
        val unread: Boolean = false,
        /** A question waits for the person. */
        val blocked: Boolean = false,
        val activityAt: Long = 0,
        /** The conversation this subtask is under; null for any other. */
        val parentId: String? = null,
    ) : AgentFeedRow {
        override val key get() = "agent-$agentId"
    }
}

enum class ConversationKind { Bot, Task, Project, Subtask }

enum class AgentFeedSection(val key: String) { Bots("bots"), Tasks("tasks"), Projects("projects") }

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
         * iOS's home (SidebarRows.swift), in the agent's own orders, never
         * by activity, so nothing moves while nothing is done: the bots
         * (catalog order), then the tasks in the person's list (their
         * order), then the projects, each a folder over its root
         * workspace's conversations, then each worktree's folder over its
         * own. Under each conversation, its active subtasks, at most two
         * levels (API.md, "Agents"); a worktree a bot's or task's subtask
         * works in is listed under that subtask only. Archived ones, hidden
         * subagents and Stem Cells' Surfaces are left out.
         */
        fun derive(catalog: AgentCatalog): AgentFeed {
            if (!catalog.loaded) return Empty
            val rows = ArrayList<AgentFeedRow>()
            val shown = HashSet<String>()

            fun active(resource: JsonObject) = resource["archivedAt"].isNullish() &&
                (resource.string("status") ?: "active") == "active"

            fun agentRows(
                agentId: String, title: String?, kind: ConversationKind, depth: Int,
                picture: String? = null, thumbhash: String? = null, parentId: String? = null, nesting: Int = 0,
            ) {
                val agent = catalog.agents[agentId] ?: return
                val wire = AgentCatalog.decodeAgent(agent) ?: return
                if (wire.archivedAt != null || !wire.visible || !shown.add(agentId)) return
                rows += AgentFeedRow.Conversation(
                    agentId = agentId,
                    title = title?.takeIf { it.isNotBlank() } ?: wire.title?.takeIf { it.isNotBlank() },
                    kind = kind,
                    depth = depth,
                    picture = picture,
                    thumbhash = thumbhash,
                    working = wire.working,
                    unread = wire.unread != null,
                    blocked = wire.pendingQuestionId != null,
                    activityAt = wire.unread?.since ?: wire.updatedAt,
                    parentId = parentId,
                )
                if (nesting >= 2) return
                for (child in (agent["subtasks"] as? JsonArray).orEmpty()) {
                    val childId = (child as? JsonObject)?.string("id") ?: continue
                    agentRows(childId, null, ConversationKind.Subtask, depth + 1, parentId = agentId, nesting = nesting + 1)
                }
            }

            fun section(section: AgentFeedSection, body: () -> Unit) {
                val at = rows.size
                rows += AgentFeedRow.Section(section)
                body()
                if (rows.size == at + 1) rows.removeAt(at)
            }

            val bots = catalog.bots.values.filter(::active).sortedWith(byOrderKey)
            val tasks = catalog.memberships.values.sortedWith(byOrderKey)
                .mapNotNull { membership -> membership.string("taskId")?.let(catalog.tasks::get)?.takeIf(::active) }
            // The worktrees bots' and tasks' subtasks work in: listed under those subtasks, not again under their project.
            val owned = HashSet<String>()
            fun collect(agentId: String) {
                for (child in (catalog.agents[agentId]?.get("subtasks") as? JsonArray).orEmpty()) {
                    val id = (child as? JsonObject)?.string("id") ?: continue
                    (catalog.agents[id] ?: child).string("workspaceId")?.let(owned::add)
                    collect(id)
                }
            }
            (bots + tasks).forEach { owner -> (owner["agent"] as? JsonObject)?.string("id")?.let(::collect) }

            section(AgentFeedSection.Bots) {
                bots.forEach { bot ->
                    val agentId = (bot["agent"] as? JsonObject)?.string("id") ?: return@forEach
                    val id = bot.string("id") ?: return@forEach
                    val avatar = bot["avatar"] as? JsonObject
                    val picture = avatar?.let { "/v0/bots/${AgentClient.escape(id)}/avatar" }
                    agentRows(agentId, bot.string("name"), ConversationKind.Bot, 0, picture, avatar?.string("thumbhash"))
                }
            }
            section(AgentFeedSection.Tasks) {
                tasks.forEach { task ->
                    val agentId = (task["agent"] as? JsonObject)?.string("id") ?: return@forEach
                    agentRows(agentId, task.string("name"), ConversationKind.Task, 0)
                }
            }
            section(AgentFeedSection.Projects) {
                catalog.projects.values.filter(::active).sortedWith(byOrderKey).forEach { project ->
                    val id = project.string("id") ?: return@forEach
                    // Only a picture the agent serves itself: a cloned repo's.
                    val picture = (project["avatar"] as? JsonObject)?.string("url")?.takeIf { it.startsWith("/v0/") }
                    rows += AgentFeedRow.Folder(id, project.string("name").orEmpty(), 0, picture)
                    fun series(owner: JsonObject, depth: Int) {
                        (owner["agents"] as? JsonArray).orEmpty().forEach { embedded ->
                            val agentId = (embedded as? JsonObject)?.string("id") ?: return@forEach
                            // A workspace-bound subtask shows under the work that made it.
                            if (catalog.agents[agentId]?.get("subtask")?.toString() == "true") return@forEach
                            agentRows(agentId, null, ConversationKind.Project, depth)
                        }
                    }
                    series(project, 1)
                    catalog.workspaces.values
                        .filter { it.string("projectId") == id && it.string("id") != id && active(it) && it.string("id") !in owned }
                        .sortedWith(byOrderKey)
                        .forEach { workspace ->
                            rows += AgentFeedRow.Folder(workspace.string("id").orEmpty(), workspace.string("name").orEmpty(), 1)
                            series(workspace, 2)
                        }
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
