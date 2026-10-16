package com.slopus.happy.perf

import com.slopus.happy.data.MessageRecord
import com.slopus.happy.model.HomeModelFixtures
import com.slopus.happy.ui.home.HomeSnapshot

/** A long working session's records: user turns, agent text with markdown, tool calls and their results. */
object LargeSessions {
    fun records(sessionId: String, count: Int, startSeq: Long = 1): List<MessageRecord> = (0 until count).map { i ->
        val seq = startSeq + i
        val turn = "t${seq / 10}"
        val json = when ((seq % 10).toInt()) {
            0 -> """{"role":"user","content":{"type":"text","text":"Please fix item $seq in the parser"}}"""
            1, 5 -> envelope(seq, turn, """{"t":"text","text":"Looking at **item $seq**.\n\n- step one\n- step two\n\n```kotlin\nval x = $seq\n```"}""")
            2, 6 -> envelope(seq, turn, """{"t":"tool-call-start","call":"c$seq","name":"Bash","title":"Run","description":"ls","args":{"command":"ls -la"}}""")
            3, 7 -> envelope(seq, turn, """{"t":"tool-call-end","call":"c${seq - 1}","result":"ok $seq"}""")
            // A subagent: its Task call, then its own output under the call's id.
            8 -> envelope(seq, turn, """{"t":"tool-call-start","call":"task$seq","name":"Task","title":"Task","description":"research","args":{"prompt":"look into $seq"}}""")
            else -> envelope(seq, turn, """{"t":"text","text":"Subagent notes for ${seq - 1}."}""", subagent = "task${seq - 1}")
        }
        MessageRecord(sessionId, seq, "m$seq", null, json, seq * 1000, seq * 1000)
    }

    private fun envelope(seq: Long, turn: String, ev: String, subagent: String? = null) =
        """{"role":"session","content":{"id":"e$seq","time":${seq * 1000},"role":"agent","turn":"$turn"${subagent?.let { ""","subagent":"$it"""" }.orEmpty()},"ev":$ev}}"""

    /**
     * [count] sessions over 5 computers: Happy Agent sessions in 40
     * projects with worktrees, Happy CLI sessions in their own folders,
     * a fifth of them archived.
     */
    fun home(count: Int): HomeSnapshot {
        val machines = (1..5).map { HomeModelFixtures.machine("m$it") }
        val sessions = (0 until count).map { i ->
            val machine = "m${i % 5 + 1}"
            val metadata = if (i % 2 == 0) {
                HomeModelFixtures.rigMetadata(
                    path = "/repo/p${i % 40}" + if (i % 3 == 0) "/.dev/worktree/w$i" else "",
                    machineId = machine,
                    projectId = "p${i % 40}",
                    projectName = "Project ${i % 40}",
                    workspaceId = if (i % 3 == 0) "w${i % 7}" else null,
                )
            } else {
                HomeModelFixtures.metadata(path = "/home/dev/cli${i % 60}") { kotlinx.serialization.json.JsonPrimitive(machine).let { put("machineId", it) } }
            }
            HomeModelFixtures.session(
                "s$i",
                metadata = metadata,
                active = i % 5 != 0,
                activeAt = 1_760_000_000_000L - i * 3_600_000L,
                createdAt = 1_760_000_000_000L - i * 3_600_000L,
                thinking = i % 17 == 0,
            )
        }
        return HomeSnapshot(sessions, machines)
    }
}
