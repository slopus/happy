package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.util.Base64
import com.slopus.happy.agent.AgentFamily
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.conversation.AgentChild
import com.slopus.happy.conversation.AgentDetail
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.AgentTerminal
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ContextUsage
import com.slopus.happy.conversation.MediaItem
import com.slopus.happy.conversation.MediaRef
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.Shared
import com.slopus.happy.conversation.SharedLink
import com.slopus.happy.conversation.SharedMedia
import java.io.ByteArrayOutputStream

/**
 * One task's page with every section in it: its two subtasks under it,
 * model, effort, start and tokens, pictures, a recording and a file, three
 * links, a child at work and a terminal running, three settled children,
 * and its details. Its pictures are drawn here, so it needs Robolectric.
 */
object AgentPageFixtures {
    /** 2025-10-31 08:40 UTC. */
    const val NOW = 1_761_900_000_000L
    const val HOUR = 3_600_000L

    private fun picture(from: Int, to: Int): Block.Image {
        val bitmap = Bitmap.createBitmap(120, 90, Bitmap.Config.ARGB_8888)
        Canvas(bitmap).drawPaint(Paint().apply { shader = LinearGradient(0f, 0f, 120f, 90f, from, to, Shader.TileMode.CLAMP) })
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        return Block.Image("image/png", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
    }

    val task = AgentFeedRow.Conversation("a1", "Ship the onboarding", ConversationKind.Task, 0, seed = "t1", working = true)
    val rows = listOf(
        AgentFeedRow.Section(com.slopus.happy.agent.AgentFeedSection.Tasks),
        task,
        AgentFeedRow.Conversation("s1", "Write the migration", ConversationKind.Subtask, 1, parentId = "a1", working = true),
        AgentFeedRow.Conversation("s2", "Review the copy", ConversationKind.Subtask, 1, parentId = "a1"),
    )

    val agent = AgentInfo("a1", "w1", null, "Ship the onboarding", "running_tools", null, null, NOW - 2 * HOUR, NOW, 1, 4, subtask = false)
    val mode = Mode("claude", "anthropic/opus-5", "high", null, "auto")

    val detail = AgentDetail(
        agent = agent,
        mode = mode,
        tokens = 1_234_567,
        context = ContextUsage(201_000, 272_000),
        running = listOf(AgentChild("s1", "Write the migration", "running_tools", false, 48_200, subtask = true)),
        terminals = listOf(AgentTerminal("p1", "pnpm dev", NOW - 12 * 60_000)),
        completed = listOf(
            AgentChild("c1", "Read the analytics", "idle", false, 12_400, subtask = false),
            AgentChild("c2", null, "idle", true, null, subtask = false),
            AgentChild("s2", "Review the copy", "idle", false, 3_100, subtask = true),
        ),
    )

    val shared: Shared by lazy {
        val colors = listOf(
            0xFF7C4DFF.toInt() to 0xFF448AFF.toInt(),
            0xFFFF6E40.toInt() to 0xFFFFD740.toInt(),
            0xFF00BFA5.toInt() to 0xFF64FFDA.toInt(),
            0xFFE040FB.toInt() to 0xFFFF4081.toInt(),
            0xFF536DFE.toInt() to 0xFF18FFFF.toInt(),
        )
        Shared(
            media = colors.mapIndexed { index, (from, to) -> SharedMedia.Picture("m$index:user", 0, picture(from, to)) } +
                SharedMedia.Presented(MediaRef("call1", 0, MediaItem("video", "demo.mp4", "video/mp4", 1280.0, 720.0))) +
                SharedMedia.Presented(MediaRef("call2", 0, MediaItem("file", "launch-plan.pdf", "application/pdf"))),
            links = listOf(
                SharedLink("https://github.com/slopus/happy/pull/412", "Onboarding PR", "github.com"),
                SharedLink("https://www.figma.com/file/abc/Onboarding", null, "figma.com"),
                SharedLink("https://developer.android.com/develop/ui/compose", "Compose docs", "developer.android.com"),
            ),
        )
    }

    val page: AgentPageState by lazy {
        AgentPageState(
            agentId = "a1",
            name = task.title,
            kind = AgentKind.Task,
            working = true,
            row = task,
            family = AgentFamily.of("a1", rows),
            mode = mode,
            modelName = "Opus 5",
            providerName = "Claude",
            detail = detail,
            reading = false,
            shared = shared,
            sharedMore = false,
            project = "Happy",
            workspace = "onboarding",
        )
    }
}
