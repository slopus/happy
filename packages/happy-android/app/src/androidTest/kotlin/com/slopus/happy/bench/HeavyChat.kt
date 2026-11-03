package com.slopus.happy.bench

import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.MediaItem
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.Presentation
import com.slopus.happy.conversation.Run
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import java.io.File
import kotlin.random.Random

/**
 * Big conversations for ChatListBenchmark.
 *
 * [replay] reads a recorded `GET /v0/agents/:id/messages` history (the
 * wire the app receives, `{"runs": [...]}` oldest first) from a file pushed
 * to the device; recordings of real chats hold private text and are never
 * committed. [stress] makes one at that scale or larger, deterministically,
 * from the mix measured in the heaviest real chat on Steve's agent
 * connection (research/telegram-chat.md): per turn a short question, then
 * agent messages with reasoning on a third of them, about one tool call
 * each (Bash with output up to 8 KB, reads, edits, subtask and status
 * calls), markdown answers of 1.1k characters median and up to 6k with
 * headers, lists, tables and code blocks, and a picture every so often.
 */
object HeavyChat {
    fun replay(file: File): List<Message> = replay(file.readText())

    /**
     * The committed recording: the heaviest real chat, scrambled by
     * tools/bench/scramble-chat.py (every letter and digit replaced, lengths,
     * lines, markdown and block structure kept), in the test APK's assets.
     * Committed gzipped; aapt unpacks a .gz asset, so the APK holds it as
     * heavy-chat.json.
     */
    fun recorded(context: android.content.Context): List<Message> =
        replay(context.assets.open("heavy-chat.json").bufferedReader().readText())

    private fun replay(json: String): List<Message> {
        val root = Json.parseToJsonElement(json).jsonObject
        return root["runs"]!!.jsonArray.mapNotNull(Run::parse).flatMap { it.messages }.sortedBy { it.createdAt }
    }

    private val words = (
        "the callback session cookie redirect request token writes before after state layout measure frame list " +
            "compose recycler message cell text block draw canvas thread main background prefetch scroll fling " +
            "keyboard inset anchor older history stream answer glass header shimmer image decode cache bitmap " +
            "android device emulator build gradle test screenshot robolectric kotlin function value result error"
        ).split(' ')
    private val tools = listOf("Bash", "Bash", "Bash", "Read", "Edit", "Edit", "send_agent_message", "set_status", "create_subtask", "Grep")

    private fun Random.words(n: Int) = (0 until n).joinToString(" ") { words[nextInt(words.size)] }
    private fun Random.sentence() = words(5 + nextInt(14)).replaceFirstChar { it.uppercase() } +
        (if (nextInt(4) == 0) " `${words[nextInt(words.size)]}()`" else "") + (if (nextInt(6) == 0) " **${words(2)}**" else "") + "."
    private fun Random.paragraph() = (0 until 2 + nextInt(5)).joinToString(" ") { sentence() }

    private fun Random.code(lines: Int) = buildString {
        append("```kotlin\n")
        repeat(lines) { i ->
            append("    ".repeat(nextInt(3)))
            append(if (i % 4 == 0) "fun ${words[nextInt(words.size)]}(value: Int): String {" else "val ${words[nextInt(words.size)]} = ${words[nextInt(words.size)]}(${nextInt(100)}) // ${words(3)}")
            append('\n')
        }
        append("```")
    }

    private fun Random.table() = buildString {
        val cols = 3 + nextInt(3)
        append((0 until cols).joinToString(" | ", "| ", " |") { words(1 + nextInt(2)) }).append('\n')
        append((0 until cols).joinToString(" | ", "| ", " |") { "---" }).append('\n')
        repeat(3 + nextInt(8)) { append((0 until cols).joinToString(" | ", "| ", " |") { if (nextBoolean()) "${nextInt(1000)} ms" else words(1 + nextInt(3)) }).append('\n') }
    }

    /** One answer of about [target] characters. */
    private fun Random.answer(target: Int) = buildString {
        if (nextInt(3) == 0) append("## ").append(words(3 + nextInt(4))).append("\n\n")
        while (length < target) {
            when (nextInt(10)) {
                0, 1 -> append((0 until 2 + nextInt(5)).joinToString("\n") { "- " + sentence() })
                2 -> append(code(3 + nextInt(18)))
                3 -> append(table())
                4 -> append("### ").append(words(2 + nextInt(4)))
                else -> append(paragraph())
            }
            append("\n\n")
        }
    }.trim()

    /** Lengths like the real chat's answers: 1.1k median, a tenth past 4k, none past 6k. */
    private fun Random.answerLength(): Int = when (nextInt(10)) {
        9 -> 4_000 + nextInt(2_000)
        in 6..8 -> 1_600 + nextInt(2_400)
        else -> 200 + nextInt(1_200)
    }

    private fun Random.output(): String = (0 until 1 + nextInt(if (nextInt(5) == 0) 120 else 12)).joinToString("\n") {
        "sources/${words[nextInt(words.size)]}/${words[nextInt(words.size)]}.kt:${nextInt(900)}: ${words(4 + nextInt(10))}"
    }

    private fun Random.tool(turn: Int, i: Int): Block.ToolCall {
        val name = tools[nextInt(tools.size)]
        val presentation = when (name) {
            "Bash" -> Presentation.Command("./gradlew ${words(2)} | grep -n ${words[nextInt(words.size)]}", output())
            "Read", "Grep" -> Presentation.Exploration(listOf(Presentation.Exploration.Operation("read", name = "${words(1)}.kt", path = "sources/${words(1)}/${words(1)}.kt")))
            else -> null
        }
        val arguments = if (presentation == null) buildJsonObject {
            put("file_path", JsonPrimitive("sources/${words(1)}.kt"))
            put("text", JsonPrimitive(words(10 + nextInt(60))))
        } else null
        return Block.ToolCall("call-$turn-$i", name, "completed", presentation, arguments)
    }

    /**
     * [turns] turns (the default makes some 3,000 rows); a picture inline
     * every 15th turn, a presented one every 20th (its bytes come from the
     * screen's loadMedia).
     */
    fun stress(turns: Int = 400, picture: Block.Image, seed: Int = 1): List<Message> {
        val random = Random(seed)
        val out = ArrayList<Message>()
        var t = 1_755_400_000_000L
        for (turn in 0 until turns) {
            out += Message("u$turn", "user", t++, listOf(Block.Text(random.paragraph().take(60 + random.nextInt(400)))))
            val parts = 2 + random.nextInt(4)
            for (p in 0 until parts) {
                val blocks = ArrayList<Block>()
                if (random.nextInt(3) == 0) blocks += Block.Reasoning(random.paragraph())
                repeat(random.nextInt(3)) { blocks += random.tool(turn, p * 10 + it) }
                if (p == parts - 1 || random.nextInt(3) == 0) blocks += Block.Text(random.answer(random.answerLength()))
                if (p == parts - 1 && turn % 15 == 7) blocks += picture
                if (p == 0 && turn % 20 == 3) {
                    blocks += Block.ToolCall(
                        "media-$turn", "present_files", "completed",
                        Presentation.Media(listOf(MediaItem("image", "shot-$turn.png", "image/png", 1080.0, 1600.0), MediaItem("image", "shot-$turn-b.png", "image/png", 1600.0, 1080.0))),
                    )
                }
                if (blocks.isNotEmpty()) out += Message("a$turn-$p", "agent", t++, blocks, runId = "r$turn")
            }
        }
        return out
    }
}
