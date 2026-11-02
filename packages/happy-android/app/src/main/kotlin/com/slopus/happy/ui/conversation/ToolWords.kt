package com.slopus.happy.ui.conversation

import android.content.res.Resources
import androidx.compose.runtime.Immutable
import com.slopus.happy.R
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.Presentation
import com.slopus.happy.conversation.ToolUse
import com.slopus.happy.model.compactCount
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Octicon

/** A tool line's mark: desktop's house icons are the Ionicons they draw, its alert and code Octicons. */
@Immutable
sealed interface ToolGlyph {
    data class Ion(val icon: Ionicon) : ToolGlyph
    data class Oct(val icon: Octicon) : ToolGlyph
}

/**
 * A tool call's words and mark as desktop's single-line row reads them
 * (AgentActivityRow.tsx `AgentToolActivity`, `toolVerb`, `toolGlyph`; iOS
 * ChatTurnPlans.swift `ToolWords`): "Read README.md", "Edited x.ts +3 −1",
 * "Shell ls -la", in the present tense while it runs.
 */
@Immutable
data class ToolWords(
    val verb: String,
    val subject: String,
    /** A command, terminal input or file: set in mono. */
    val mono: Boolean,
    val glyph: ToolGlyph,
    val added: Int? = null,
    val deleted: Int? = null,
) {
    companion object {
        fun of(tool: ToolUse, res: Resources): ToolWords {
            val name = tool.name
            val lower = name.lowercase()
            val p = tool.presentation
            val glyph = glyph(name, p, tool.failed)
            // A skill the agent reads is named: "Read skill: release-notes".
            if (p == null && tool.skill != null) {
                return ToolWords(res.getString(if (tool.running) R.string.turn_reading_skill else R.string.turn_read_skill), tool.skill, false, glyph)
            }
            return when (p) {
                is Presentation.AgentSpawn -> ToolWords(
                    verb = res.getString(if (tool.failed) R.string.turn_failed_to_spawn else if (tool.running) R.string.turn_spawning else R.string.turn_spawned),
                    subject = p.model?.let { res.getString(R.string.turn_sub_agent_model, it) } ?: res.getString(R.string.turn_sub_agent),
                    mono = false,
                    glyph = glyph,
                )
                is Presentation.Search -> ToolWords(verb(name, tool.status, p, res), p.query, false, glyph)
                is Presentation.Media -> ToolWords(
                    // A read that turned out to be a picture still says it read it.
                    verb = if (Regex("(read|view)").containsMatchIn(lower)) res.getString(R.string.turn_read) else mediaNoun(p.items.map { it.kind }, res),
                    subject = p.items.joinToString(", ") { it.name },
                    mono = false,
                    glyph = glyph,
                )
                is Presentation.Artifact -> ToolWords(
                    verb = verb(name, tool.status, p, res),
                    subject = if (p.shows == "latest") p.title ?: res.getString(R.string.turn_artifact) else res.getString(R.string.turn_artifact),
                    mono = false,
                    glyph = glyph,
                )
                is Presentation.Exploration -> ToolWords(verb(name, tool.status, p, res), exploration(p.operations, res), false, glyph)
                is Presentation.FileDiff -> {
                    val first = p.files.firstOrNull()
                    val added = p.files.sumOf { it.added ?: 0 }
                    val deleted = p.files.sumOf { it.deleted ?: 0 }
                    ToolWords(
                        verb = when (first?.kind) {
                            null -> verb(name, tool.status, p, res)
                            "add" -> res.getString(R.string.turn_added)
                            "delete" -> res.getString(R.string.turn_deleted)
                            else -> res.getString(R.string.turn_edit)
                        },
                        subject = first?.let { fileName(it.path) } ?: humanize(name, res),
                        mono = true,
                        glyph = glyph,
                        // A side that changed nothing is left unsaid.
                        added = added.takeIf { it > 0 },
                        deleted = deleted.takeIf { it > 0 },
                    )
                }
                is Presentation.Command -> ToolWords(verb(name, tool.status, p, res), p.command, true, glyph)
                is Presentation.Terminal -> ToolWords(verb(name, tool.status, p, res), terminalInput(p.input, res).ifEmpty { p.command.orEmpty() }, true, glyph)
                else -> ToolWords(
                    verb = verb(name, tool.status, p, res),
                    subject = when {
                        name.startsWith("mcp__") && p == null -> mcp(name) ?: humanize(name, res)
                        lower == "wait_agent" -> res.getString(R.string.turn_for_subagents)
                        else -> humanize(name, res)
                    },
                    mono = false,
                    glyph = glyph,
                )
            }
        }

        private fun matches(pattern: String, text: String) = Regex(pattern).containsMatchIn(text)

        fun verb(name: String, status: String, presentation: Presentation?, res: Resources): String {
            val active = status == "running"
            fun say(running: Int, ran: Int) = res.getString(if (active) running else ran)
            val lower = name.lowercase()
            when (presentation) {
                is Presentation.Search -> return say(R.string.turn_searching, R.string.turn_searched)
                is Presentation.Exploration -> return say(R.string.turn_exploring, R.string.turn_explored)
                else -> Unit
            }
            // An artifact's tools say what they did to it in their own words.
            if (presentation is Presentation.Artifact || matches("^(create_artifact|edit_artifact_files|update_artifact)$", lower)) {
                return when {
                    status == "failed" -> res.getString(R.string.turn_failed_call)
                    lower == "edit_artifact_files" -> say(R.string.turn_opening, R.string.turn_opened)
                    lower == "create_artifact" -> say(R.string.turn_creating, R.string.turn_created)
                    else -> say(R.string.turn_updating, R.string.turn_updated)
                }
            }
            if (presentation is Presentation.Terminal || matches("stdin|terminal_?input|taskinput", lower)) return say(R.string.turn_typing, R.string.turn_typed)
            if (lower == "wait_agent") return say(R.string.turn_waiting, R.string.turn_waited)
            if (presentation is Presentation.Command || matches("(bash|exec|shell|command|run)", lower)) {
                return when (lower) {
                    "powershell" -> "PowerShell"
                    "bash" -> "Bash"
                    else -> res.getString(R.string.turn_shell)
                }
            }
            if (matches("(grep|find|glob|^ls$|list|search)", lower)) return say(R.string.turn_exploring, R.string.turn_explored)
            if (matches("(read|view|cat|open)", lower)) return say(R.string.turn_reading, R.string.turn_read)
            if (matches("(write|edit|patch|update|apply)", lower)) return say(R.string.turn_editing, R.string.turn_edited)
            return say(R.string.turn_tool, R.string.turn_used)
        }

        /** `toolGlyph`. */
        fun glyph(name: String, presentation: Presentation?, failed: Boolean): ToolGlyph {
            if (failed) return ToolGlyph.Oct(Octicon.Alert)
            when (presentation) {
                is Presentation.AgentSpawn -> return ToolGlyph.Ion(Ionicon.HardwareChipOutline)
                is Presentation.Search -> return ToolGlyph.Ion(Ionicon.GlobeOutline)
                is Presentation.Exploration -> return ToolGlyph.Ion(Ionicon.SearchOutline)
                is Presentation.FileDiff -> return ToolGlyph.Ion(Ionicon.DocumentOutline)
                is Presentation.Artifact -> return ToolGlyph.Ion(Ionicon.CubeOutline)
                is Presentation.Media -> {
                    val kinds = presentation.items.map { it.kind }
                    return ToolGlyph.Ion(
                        when {
                            "image" in kinds -> Ionicon.ImageOutline
                            "video" in kinds -> Ionicon.FilmOutline
                            else -> Ionicon.DocumentOutline
                        },
                    )
                }
                else -> Unit
            }
            val lower = name.lowercase()
            if (presentation is Presentation.Terminal || matches("stdin|terminal_?input|taskinput", lower)) return ToolGlyph.Ion(Ionicon.TerminalOutline)
            if (presentation is Presentation.Command || matches("(bash|exec|shell|command|run)", lower)) return ToolGlyph.Oct(Octicon.Code)
            if (matches("(grep|find|glob|^ls$|list|search)", lower)) return ToolGlyph.Ion(Ionicon.SearchOutline)
            if (matches("(read|view|cat|open)", lower)) return ToolGlyph.Ion(Ionicon.DocumentTextOutline)
            if (matches("(write|edit|patch|update|apply)", lower)) return ToolGlyph.Ion(Ionicon.DocumentOutline)
            if (matches("(fetch|http|web|url|browser)", lower)) return ToolGlyph.Ion(Ionicon.GlobeOutline)
            if (matches("(task|todo|plan)", lower)) return ToolGlyph.Ion(Ionicon.CheckboxOutline)
            if (matches("(agent|spawn|subagent|workflow)", lower)) return ToolGlyph.Ion(Ionicon.HardwareChipOutline)
            return ToolGlyph.Ion(Ionicon.FlashOutline)
        }

        private val KNOWN = mapOf(
            "Agent" to R.string.turn_tool_subagent,
            "compact" to R.string.turn_tool_compaction,
            "TaskInput" to R.string.turn_tool_terminal_input,
            "TaskList" to R.string.turn_tool_task_list,
            "TaskOutput" to R.string.turn_tool_background_output,
            "spawn_agent" to R.string.turn_tool_start_subagent,
            "wait_agent" to R.string.turn_tool_wait_subagents,
            "workflow" to R.string.turn_tool_workflow,
            "write_stdin" to R.string.turn_tool_terminal_input,
        )

        private fun mcp(name: String): String? {
            val parts = name.split("__")
            return if (parts.size >= 3) "${parts[1]} · ${parts.drop(2).joinToString(" ")}" else null
        }

        /** `humanizeToolName`: its own name where it has one, else its words spaced and capitalised. */
        fun humanize(name: String, res: Resources): String {
            KNOWN[name]?.let { return res.getString(it) }
            if (name.startsWith("mcp__")) mcp(name)?.let { return it }
            val text = name
                .replace(Regex("[_-]+"), " ")
                .replace(Regex("([a-z0-9])([A-Z])"), "$1 $2")
                .replace(Regex("\\s+"), " ")
                .trim()
            return text.replaceFirstChar { it.uppercaseChar() }
        }

        /** `explorationSummary`: the files read, or each step said. */
        fun exploration(operations: List<Presentation.Exploration.Operation>, res: Resources): String {
            if (operations.all { it.kind == "read" }) return operations.mapNotNull { it.name }.distinct().joinToString(", ")
            return operations.joinToString(" · ") { operation ->
                when (operation.kind) {
                    "list" -> res.getString(R.string.turn_list, operation.target.orEmpty())
                    "read" -> res.getString(R.string.turn_read_file, operation.name.orEmpty())
                    else -> {
                        val query = operation.query
                        val path = operation.path
                        res.getString(
                            R.string.turn_search,
                            if (query != null && path != null) res.getString(R.string.turn_search_in, query, path) else query ?: path ?: operation.command.orEmpty(),
                        )
                    }
                }
            }
        }

        fun fileName(path: String): String = path.replace('\\', '/').substringAfterLast('/').ifEmpty { path }

        /** `mediaNoun`: what one call showed, by its items' kinds (an unknown kind is a file). */
        fun mediaNoun(kinds: List<String>, res: Resources): String {
            val known = kinds.map { if (it in setOf("image", "video", "document")) it else "file" }
            val plural = known.size > 1
            if (known.toSet().size != 1) return res.getString(R.string.turn_files)
            return res.getString(
                when (known.first()) {
                    "image" -> if (plural) R.string.turn_images else R.string.turn_image
                    "video" -> if (plural) R.string.turn_videos else R.string.turn_video
                    "document" -> if (plural) R.string.turn_documents else R.string.turn_document
                    else -> if (plural) R.string.turn_files else R.string.turn_file
                },
            )
        }

        /** `terminalInputSummary`: control codes as a terminal echoes them, a paste by its first line and how many more. */
        fun terminalInput(input: String, res: Resources): String {
            val visible = buildString {
                for (char in input.replace("\r\n", "\n")) {
                    when {
                        char == '\n' -> append(char)
                        char.code < 0x20 || char.code == 0x7F -> append('^').append((char.code xor 0x40).toChar().uppercaseChar())
                        else -> append(char)
                    }
                }
            }.trimEnd('\n')
            if (visible.isEmpty()) return ""
            val lines = visible.split('\n')
            return if (lines.size > 1) res.getQuantityString(R.plurals.turn_more_lines, lines.size - 1, lines[0], lines.size - 1) else lines[0]
        }

        /** countText.ts `compactCount`. */
        fun compact(count: Int): String = compactCount(count.toLong())
    }
}

/** How a turn ended, in desktop's words (TurnSummary.tsx): "Completed in 12s". */
fun turnLabel(ended: ConversationRow.TurnEnd, res: Resources): String {
    val (bare, timed) = when (ended.reason) {
        "steering" -> R.string.turn_steered to R.string.turn_steered_after
        "compaction" -> R.string.turn_worked to R.string.turn_worked_for
        "abort" -> R.string.turn_stopped to R.string.turn_stopped_after
        "error" -> R.string.turn_failed to R.string.turn_failed_after
        else -> R.string.turn_completed to R.string.turn_completed_in
    }
    val ms = ended.durationMs ?: return res.getString(bare)
    val duration = turnDuration(ms)
    // Kept on one line with the word before it.
    return res.getString(timed, duration).replace(" $duration", "\u00a0$duration")
}

/** TurnSummary.tsx `durationFormat`: 42s, 3m 7s, 2h 5m. */
fun turnDuration(ms: Long): String {
    val total = maxOf(0L, ms / 1000)
    if (total < 60) return "${total}s"
    val minutes = total / 60
    if (minutes < 60) return "${minutes}m\u00a0${total % 60}s"
    return "${minutes / 60}h\u00a0${minutes % 60}m"
}
