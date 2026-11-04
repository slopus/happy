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

    /** Desktop's fixed Artifacts row, first on home: the agent's artifacts, newest first. */
    data object Artifacts : AgentFeedRow {
        override val key get() = "artifacts"
    }

    /** Desktop's Feed row under Artifacts, while the computer keeps a feed for the person: how many entries they haven't seen. */
    data class Feed(val unread: Int) : AgentFeedRow {
        override val key get() = "feed"
    }
    /** iOS direct:todos: the computer's todo lists among the fixed places. */
    data object Todos : AgentFeedRow { override val key get() = "todos" }

    /**
     * A Surface the person joined: a todo list, a document, a calendar, a
     * system monitor or a chat ([type]). It opens on its own page.
     */
    data class Surface(val id: String, val name: String, val type: String) : AgentFeedRow {
        override val key get() = "surface-$id"
    }

    /**
     * A project, or one of its worktrees at [depth] 1: its conversations
     * follow, a level in. It opens nothing. A project wears a [mark]; a
     * worktree none. [running]: work runs in one of the conversations under
     * it and none waits on a question (desktop's project and workspace
     * `activity`).
     */
    data class Folder(val id: String, val name: String, val depth: Int, val mark: FolderMark? = null, val running: Boolean = false, val lineChanges: WorkspaceLineChanges? = null) : AgentFeedRow {
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
        /** What a bot or task wears without a picture: the placeholder its own ID picks (happy-ios's `.placeholder(seed:)`). */
        val seed: String? = null,
        /** The person's Happy (the `chief_of_staff` bot): Happy's mark, as on happy-ios. */
        val happy: Boolean = false,
        val working: Boolean = false,
        val unread: Boolean = false,
        /** A question waits for the person. */
        val blocked: Boolean = false,
        val activityAt: Long = 0,
        /** The conversation this subtask is under; null for any other. */
        val parentId: String? = null,
        /** Its turn sits in a scheduled wait. */
        val waiting: Boolean = false,
        /** One of its subtasks listed under it is [running]. */
        val delegating: Boolean = false,
        val workspaceId: String? = null,
        val lineChanges: WorkspaceLineChanges? = null,
    ) : AgentFeedRow {
        override val key get() = "agent-$agentId"

        /**
         * This row as its line draws it (iOS 2932427fe): what only orders or
         * nests it ([activityAt], [parentId]) or only opens it elsewhere
         * ([workspaceId]) left out, so a working agent's activity ticking
         * redraws nothing.
         */
        fun drawn(): Conversation = if (activityAt == 0L && parentId == null && workspaceId == null) this else copy(activityAt = 0, parentId = null, workspaceId = null)

        /**
         * Desktop's `activity == "running"` (summaryActivity): a question
         * waiting on the person outranks everything; then work handed to a
         * subtask counts as this conversation's; then its own turn runs,
         * outside a scheduled wait. A running conversation's title shimmers.
         */
        val running: Boolean get() = !blocked && (delegating || (working && !waiting))
    }
}

enum class ConversationKind { Bot, Task, Project, Subtask }

/** What a project's folder wears (API.md "Projects", `avatar`). */
@Immutable
sealed interface FolderMark {
    /** The project picture the person chose or the agent made, read from [path] over its [thumbhash]. */
    data class Picture(val path: String, val thumbhash: String?) : FolderMark

    /** The built-in home project (`{ "kind": "home" }`): desktop's home glyph; it has no picture. */
    data object Home : FolderMark

    /** No picture: the placeholder the project's ID picks, as everything else without one wears. */
    data class Placeholder(val seed: String) : FolderMark

    companion object {
        /**
         * [project]'s mark from its `avatar`: `kind: "image"` is a picture
         * at `GET /v0/projects/:id/avatar`, `kind: "home"` the home
         * project; null or anything else is no picture. The wire carries
         * no URL (desktop's `avatar.url` is its own renderer's projection),
         * so the picture is always the agent's own, read over the tunnel.
         */
        fun of(id: String, project: JsonObject): FolderMark {
            val avatar = project["avatar"] as? JsonObject
            return when (avatar?.string("kind")) {
                "image" -> Picture("/v0/projects/${AgentClient.escape(id)}/avatar", avatar.string("thumbhash"))
                "home" -> Home
                else -> Placeholder(id)
            }
        }
    }
}

enum class AgentFeedSection(val key: String) { Places("places"), Bots("bots"), Tasks("tasks"), Projects("projects") }

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
         * by activity, so nothing moves while nothing is done: Artifacts and
         * the Surfaces the person joined (in their own order), the bots
         * (catalog order), then the tasks in the person's list (their
         * order), then the projects, each a folder over its root
         * workspace's conversations, then each worktree's folder over its
         * own. Under each conversation, its active subtasks, at most two
         * levels (API.md, "Agents"); a worktree a bot's or task's subtask
         * works in is listed under that subtask only. Archived ones, hidden
         * subagents and Stem Cells' Surfaces are left out, and the projects
         * altogether while the person hides them on the desktop
         * ([AgentCatalog.projectsHidden]), and the Surfaces being left
         * ([leaving]), gone at once while the agent is asked. What this
         * phone has on its way ([intents]) shows already: a chat read has
         * no dot, a task, bot, subtask or Surface archived or left is gone,
         * a task or bot renamed wears its new name.
         */
        fun derive(
            catalog: AgentCatalog,
            leaving: Set<String> = emptySet(),
            git: Map<String, WorkspaceLineChanges> = emptyMap(),
            intents: IntentOverlay = IntentOverlay(),
            /** The Feed's unread count; null where there is no Feed. */
            feedUnread: Int? = null,
        ): AgentFeed {
            if (!catalog.loaded) return Empty
            val removed = intents.removed
            val rows = ArrayList<AgentFeedRow>()
            val shown = HashSet<String>()

            fun active(resource: JsonObject) = resource["archivedAt"].isNullish() &&
                (resource.string("status") ?: "active") == "active"

            /** Adds the conversation's row and its subtasks'; whether it is running. */
            fun agentRows(
                agentId: String, title: String?, kind: ConversationKind, depth: Int,
                picture: String? = null, thumbhash: String? = null, parentId: String? = null, nesting: Int = 0,
                seed: String? = null, happy: Boolean = false,
                /** A bot muted on the desktop: listed, its subtasks too, without activity or unread (iOS SidebarRows' `muted`). */
                muted: Boolean = false,
            ): Boolean {
                if (agentId in removed) return false
                val agent = catalog.agents[agentId] ?: return false
                val wire = AgentCatalog.decodeAgent(agent) ?: return false
                if (wire.archivedAt != null || !wire.visible || !shown.add(agentId)) return false
                val at = rows.size
                rows += AgentFeedRow.Conversation(
                    agentId = agentId,
                    title = title?.takeIf { it.isNotBlank() } ?: wire.title?.takeIf { it.isNotBlank() },
                    kind = kind,
                    depth = depth,
                    picture = picture,
                    thumbhash = thumbhash,
                    seed = seed,
                    happy = happy,
                    working = !muted && wire.working,
                    unread = !muted && wire.unread != null && agentId !in intents.read,
                    blocked = !muted && wire.pendingQuestionId != null,
                    activityAt = wire.unread?.since ?: wire.updatedAt,
                    parentId = parentId,
                    waiting = !muted && wire.wait != null,
                    workspaceId = wire.workspaceId,
                    lineChanges = git[wire.workspaceId]?.takeIf { it.visible },
                )
                var delegating = false
                if (nesting < 2) {
                    for (child in (agent["subtasks"] as? JsonArray).orEmpty()) {
                        val childId = (child as? JsonObject)?.string("id") ?: continue
                        if (agentRows(childId, null, ConversationKind.Subtask, depth + 1, parentId = agentId, nesting = nesting + 1, muted = muted)) delegating = true
                    }
                }
                val row = rows[at] as AgentFeedRow.Conversation
                if (delegating) rows[at] = row.copy(delegating = true)
                return (rows[at] as AgentFeedRow.Conversation).running
            }

            /** Marks the folder at [at] running when a conversation listed after it runs and none waits on a question. */
            fun folderActivity(at: Int) {
                val under = rows.subList(at + 1, rows.size).filterIsInstance<AgentFeedRow.Conversation>()
                if (under.none { it.blocked } && under.any { it.running }) rows[at] = (rows[at] as AgentFeedRow.Folder).copy(running = true)
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

            section(AgentFeedSection.Places) {
                rows += AgentFeedRow.Artifacts
                feedUnread?.let { rows += AgentFeedRow.Feed(it) }
                rows += AgentFeedRow.Todos
                catalog.surfaces.values
                    .filter { it.string("status") != "archived" && it["archivedAt"].isNullish() }
                    .mapNotNull { surface ->
                        // A computer with no Happy account has one person, with no ID on either side (iOS SidebarRows).
                        val member = (surface["members"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
                            .firstOrNull { it.string("userId") == catalog.userId } ?: return@mapNotNull null
                        surface to member.string("orderKey").orEmpty()
                    }
                    .sortedWith(compareBy({ it.second }, { it.first.string("id") }))
                    .forEach { (surface, _) ->
                        val id = surface.string("id")?.takeIf { it !in leaving && it !in removed } ?: return@forEach
                        rows += AgentFeedRow.Surface(id, surface.string("name").orEmpty(), surface.string("type").orEmpty())
                    }
            }
            section(AgentFeedSection.Bots) {
                bots.forEach { bot ->
                    val agentId = (bot["agent"] as? JsonObject)?.string("id") ?: return@forEach
                    val id = bot.string("id") ?: return@forEach
                    // Hidden or muted on the desktop, as its sidebar has it (desktop 731c8bbc, 1dc8b566).
                    if (DesktopSettings.botHidden(catalog.settingValues, id) || id in removed) return@forEach
                    val avatar = bot["avatar"] as? JsonObject
                    val picture = avatar?.let { "/v0/bots/${AgentClient.escape(id)}/avatar" }
                    val happy = bot.string("systemKey") == "chief_of_staff"
                    agentRows(
                        agentId, intents.titles[id] ?: bot.string("name"), ConversationKind.Bot, 0, picture, avatar?.string("thumbhash"), seed = id, happy = happy,
                        muted = DesktopSettings.botMuted(catalog.settingValues, id),
                    )
                }
            }
            section(AgentFeedSection.Tasks) {
                tasks.forEach { task ->
                    val agentId = (task["agent"] as? JsonObject)?.string("id") ?: return@forEach
                    val id = task.string("id")
                    if (id != null && id in removed) return@forEach
                    agentRows(agentId, id?.let(intents.titles::get) ?: task.string("name"), ConversationKind.Task, 0, seed = id ?: agentId)
                }
            }
            if (!catalog.projectsHidden) section(AgentFeedSection.Projects) {
                catalog.projects.values.filter(::active).sortedWith(byOrderKey).forEach { project ->
                    val id = project.string("id") ?: return@forEach
                    val projectAt = rows.size
                    rows += AgentFeedRow.Folder(id, project.string("name").orEmpty(), 0, FolderMark.of(id, project), lineChanges = git[id]?.takeIf { it.visible })
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
                            val workspaceAt = rows.size
                            rows += AgentFeedRow.Folder(workspace.string("id").orEmpty(), workspace.string("name").orEmpty(), 1, lineChanges = git[workspace.string("id")]?.takeIf { it.visible })
                            series(workspace, 2)
                            folderActivity(workspaceAt)
                        }
                    folderActivity(projectAt)
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

/** The Chief of Staff's name as the computer calls it: the `chief_of_staff` bot's ([AgentFeedRow.Conversation.happy]); null until listed or unnamed. */
fun AgentFeed.chiefOfStaffName(): String? =
    rows.firstNotNullOfOrNull { row -> (row as? AgentFeedRow.Conversation)?.takeIf { it.happy }?.title?.takeIf { it.isNotBlank() } }
