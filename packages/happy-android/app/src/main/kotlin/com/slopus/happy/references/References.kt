package com.slopus.happy.references

import androidx.compose.runtime.Immutable
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/**
 * What each Happy reference in a message reads as now, and what it opens:
 * iOS `References` (happy-desktop's `messageReferencesCreate`), over the
 * bots and tasks this phone holds. An agent reads as its conversation's
 * name (a bot's or task's own as the bot's or task's), a workspace as the
 * bot, task or subtask it holds, an artifact as its current title, a person
 * as "@" and their name, set apart when it is the reader. What the lists
 * don't hold (archived, a project, a service, a kind this build doesn't
 * know) is inert words that say what it was.
 */
@Immutable
data class References(
    val agents: Map<String, Entity> = emptyMap(),
    val workspaces: Map<String, Entity> = emptyMap(),
    val artifacts: Map<String, Artifact> = emptyMap(),
    /** The artifacts read so far that want to be shown inline, by ID. */
    val pages: Map<String, Page> = emptyMap(),
    /** The conversation's own subagents, by ID, as titled ("" untitled): a hidden one reads as its title, and opens nothing. */
    val subagents: Map<String, String> = emptyMap(),
    /** The people a message may mention, by user ID, as named. */
    val users: Map<String, String> = emptyMap(),
    /** The person reading: their mentions are set apart. */
    val me: String? = null,
    /** People the computer doesn't know; any other unnamed one is still being read. */
    val missingUsers: Set<String> = emptySet(),
    val words: ReferenceWords = ReferenceWords.English,
) {
    /** Something a reference can open: a conversation. */
    data class Entity(val label: String, val agentId: String)

    /** An artifact's title as read: absent until read. */
    sealed interface Artifact {
        data class Active(val title: String, val type: String, val latestVersion: Int) : Artifact
        data class Deleted(val title: String) : Artifact
        data object Missing : Artifact
    }

    /**
     * An artifact the conversation shows inline under its card, at its latest
     * version: an HTML page that asks for it (`display` `inline_expanded`),
     * with the entry the page loads and the colour behind it, if any; or a
     * Gen UI view ([genUi]), drawn natively.
     */
    data class Page(val version: Int, val entry: String, val background: String? = null, val genUi: Boolean = false)

    sealed interface View {
        val label: String

        /** Opens: a name to tap. [reading] while an artifact's title is on its way. */
        data class Link(override val label: String, val reading: Boolean = false) : View
        /** Opens nothing: plain words. */
        data class Text(override val label: String) : View
        /** A person named in the message: "@" and their name, set apart, and more so when it is the person reading ([me]). */
        data class Mention(override val label: String, val me: Boolean) : View
    }

    /** Words for a reference nobody can resolve, such as "an unavailable artifact". */
    fun placeholder(reference: HappyReferences.Reference): String = words.unavailable(reference.kind)

    /** What [reference] reads as now. */
    fun view(reference: HappyReferences.Reference): View {
        val inert = View.Text(placeholder(reference))
        return when (reference.kind) {
            "artifact" -> when (val read = artifacts[reference.id]) {
                null -> View.Link(words.artifact, reading = true)
                Artifact.Missing -> inert
                // A deleted artifact serves nothing, so it is named and not offered.
                is Artifact.Deleted -> read.title.trim().takeIf { it.isNotEmpty() }?.let(View::Text) ?: inert
                is Artifact.Active -> View.Link(read.title.trim().ifEmpty { words.untitledArtifact })
            }
            "agent", "workspace" -> {
                val entity = (if (reference.kind == "agent") agents else workspaces)[reference.id]
                if (entity == null) {
                    // desktop's `messageReferencesCreate`: a subagent is named, as "Subagent" untitled.
                    val title = subagents[reference.id]?.takeIf { reference.kind == "agent" } ?: return inert
                    View.Text(title.trim().ifEmpty { words.subagent })
                } else {
                    View.Link(entity.label.trim().ifEmpty { if (reference.kind == "agent") words.untitledAgent else words.untitledWorkspace })
                }
            }
            "user" -> {
                val name = users[reference.id]?.trim().orEmpty()
                when {
                    name.isNotEmpty() -> View.Mention("@$name", me = reference.id == me)
                    reference.id in missingUsers -> inert
                    else -> View.Mention("@…", me = reference.id == me)
                }
            }
            // Projects aren't on this phone; services open nowhere yet.
            else -> inert
        }
    }

    /** The conversation a reference opens, for an agent or a workspace. */
    fun entity(reference: HappyReferences.Reference): Entity? = when (reference.kind) {
        "agent" -> agents[reference.id]
        "workspace" -> workspaces[reference.id]
        else -> null
    }

    /** The artifacts [text] names whose titles haven't been read. */
    fun unread(text: String): List<String> = named(text, "<happy-artifact", "artifact") { it !in artifacts }

    /** The people [text] mentions whose names haven't been read. */
    fun unknownUsers(text: String): List<String> = named(text, "<happy-user", "user") { it !in users }

    private inline fun named(text: String, tag: String, kind: String, wanted: (String) -> Boolean): List<String> {
        if (!text.contains(tag)) return emptyList()
        val ids = ArrayList<String>()
        for (segment in HappyReferences.parse(text)) {
            val reference = (segment as? HappyReferences.Segment.Tag)?.reference ?: continue
            if (reference.kind == kind && wanted(reference.id) && reference.id !in ids) ids += reference.id
        }
        return ids
    }

    companion object {
        /** Whether [text] may hold a reference at all: most messages don't, and are never parsed for one. */
        fun mayHold(text: String): Boolean = text.contains("<happy-")

        /**
         * `messageReferenceEntities`, from the bots and tasks [catalog] holds,
         * each owner's agent as the catalog has it newest, with its active subtasks.
         */
        fun entities(catalog: AgentCatalog): Pair<Map<String, Entity>, Map<String, Entity>> {
            val agents = HashMap<String, Entity>()
            val workspaces = HashMap<String, Entity>()
            val subtasks = ArrayList<JsonObject>()
            fun active(resource: JsonObject) = (resource["archivedAt"] ?: JsonNull) == JsonNull && (resource["status"].str ?: "active") == "active"
            fun collect(agent: JsonObject) {
                for (child in (agent["subtasks"] as? JsonArray).orEmpty()) {
                    val embedded = child as? JsonObject ?: continue
                    val subtask = embedded["id"].str?.let(catalog.agents::get) ?: embedded
                    if ((subtask["archivedAt"] ?: JsonNull) != JsonNull) continue
                    subtasks += subtask
                    collect(subtask)
                }
            }
            for (owner in catalog.bots.values.filter(::active) + catalog.tasks.values.filter(::active)) {
                val embedded = owner["agent"] as? JsonObject ?: continue
                val agentId = embedded["id"].str ?: continue
                val agent = catalog.agents[agentId] ?: embedded
                val name = owner["name"].str.orEmpty()
                agents[agentId] = Entity(name, agentId)
                (owner["workspaceId"].str ?: agent["workspaceId"].str)?.let { workspaces[it] = Entity(name, agentId) }
                collect(agent)
            }
            for (subtask in subtasks) {
                val agentId = subtask["id"].str ?: continue
                val title = subtask["title"].str.orEmpty()
                agents[agentId] = Entity(title, agentId)
                subtask["workspaceId"].str?.let { if (it !in workspaces) workspaces[it] = Entity(title, agentId) }
            }
            return agents to workspaces
        }

        /** An artifact object (`GET /v0/artifacts/:id`) as a reference reads it. */
        fun artifact(artifact: JsonObject): Artifact {
            val title = artifact["title"].str.orEmpty()
            if (artifact["status"].str == "deleted") return Artifact.Deleted(title)
            return Artifact.Active(title, artifact["type"].str.orEmpty(), artifact["latestVersion"].num?.toInt() ?: 1)
        }

        /**
         * An artifact object as a page the conversation shows inline: an
         * active HTML artifact of files (not a live URL) whose latest version
         * asks for `inline_expanded`, or an active Gen UI artifact unless its
         * latest version asks to stay at its title (`inline_compact`, `side`),
         * as desktop does. Null for anything else, which stays a card.
         */
        fun page(artifact: JsonObject): Page? {
            if (artifact["status"].str == "deleted") return null
            if (artifact["type"].str == "gen_ui") {
                if (artifact["display"].str == "inline_compact" || artifact["display"].str == "side") return null
                val version = artifact["latestVersion"].num?.toInt() ?: return null
                return Page(version, artifact["entry"].obj?.get("path").str.orEmpty(), genUi = true)
            }
            if (artifact["type"].str != "html" || artifact["display"].str != "inline_expanded") return null
            if (artifact["live"].let { it != null && it !is JsonNull }) return null
            val entry = artifact["entry"].obj?.get("path").str ?: return null
            val version = artifact["latestVersion"].num?.toInt() ?: return null
            // `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, and nothing else.
            val background = artifact["background"].str?.takeIf { BACKGROUND.matches(it) }?.lowercase()
            return Page(version, entry, background)
        }

        private val BACKGROUND = Regex("^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
    }
}

/**
 * The words references read as where nothing names them: what an artifact
 * still being read is called, the untitled names, and the placeholders for
 * what nobody can resolve. [English] is iOS's and desktop's; the app gives
 * its own from its strings.
 */
@Immutable
data class ReferenceWords(
    val artifact: String,
    val untitledArtifact: String,
    val untitledAgent: String,
    val untitledWorkspace: String,
    val subagent: String,
    /** By kind; [unavailableReference] for any other. */
    val unavailableKinds: Map<String, String>,
    val unavailableReference: String,
) {
    fun unavailable(kind: String): String = unavailableKinds[kind] ?: unavailableReference

    companion object {
        val English = ReferenceWords(
            artifact = "artifact",
            untitledArtifact = "Untitled artifact",
            untitledAgent = "Untitled agent",
            untitledWorkspace = "Untitled workspace",
            subagent = "Subagent",
            unavailableKinds = HappyReferences.knownKinds.associateWith { "an unavailable $it" },
            unavailableReference = "an unavailable reference",
        )
    }
}
