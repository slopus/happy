package com.slopus.happy.fixture

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentFeedSection
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.AgentPictures
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.ui.connection.AgentHomeActions
import com.slopus.happy.ui.connection.AgentHomeScreen
import com.slopus.happy.ui.connection.AgentHomeTags
import com.slopus.happy.ui.connection.LocalAgentPictures
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.theme.HappyTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Agent home on a device with bots, tasks, a project and their subtasks
 * open, captured to the test app's files under `device-evidence/` so a
 * review sees what each row wears before its title. Every row is synthetic.
 */
@RunWith(AndroidJUnit4::class)
class AgentHomeMarksDeviceTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val app = InstrumentationRegistry.getInstrumentation().targetContext
    private val evidence = File(app.filesDir, "device-evidence").apply { mkdirs() }

    private fun conversation(
        agentId: String, title: String, kind: ConversationKind, depth: Int = 0, parentId: String? = null, childCount: Int = 0,
        detail: String? = null, minutes: Long = 5, working: Boolean = false, unread: Boolean = false, blocked: Boolean = false,
        picture: String? = null,
    ) = AgentFeedRow.Conversation(
        agentId = agentId, title = title, kind = kind, detail = detail, depth = depth, picture = picture,
        working = working, unread = unread, blocked = blocked, activityAt = NOW - minutes * 60_000, parentId = parentId, childCount = childCount,
    )

    private val feed = AgentFeed(
        loaded = true,
        rows = listOf(
            AgentFeedRow.Section(AgentFeedSection.Bots),
            conversation("ab1", "Happy", ConversationKind.Bot, childCount = 1, minutes = 20, picture = "/v0/bots/b1/avatar"),
            conversation("as1", "Review the PR", ConversationKind.Subtask, depth = 1, parentId = "ab1", working = true),
            conversation("ab2", "Research", ConversationKind.Bot, minutes = 180),
            AgentFeedRow.Section(AgentFeedSection.Tasks),
            conversation("at1", "Fix login redirect", ConversationKind.Task, childCount = 2, minutes = 1),
            conversation("as2", "Trace the redirect loop", ConversationKind.Subtask, depth = 1, parentId = "at1", unread = true),
            conversation("as3", "Write the regression test", ConversationKind.Subtask, depth = 1, parentId = "at1", minutes = 12),
            conversation("at2", "Write release notes", ConversationKind.Task, unread = true, minutes = 40),
            conversation("at3", "Plan the sprint", ConversationKind.Task, blocked = true, minutes = 90),
            AgentFeedRow.Section(AgentFeedSection.Project("p1", "happy", null, true)),
            conversation("ap1", "Android home feed", ConversationKind.Project, childCount = 1, minutes = 2 * 1440),
            conversation("as4", "Port the row marks", ConversationKind.Subtask, depth = 1, parentId = "ap1", minutes = 30),
            conversation("aw1", "Scroll jumps", ConversationKind.Project, detail = "fix-scroll", minutes = 9 * 1440),
        ),
    )

    @Test fun capture() {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        val accounts = AccountMenu(listOf(AccountMenuEntry("fx-connection", "Studio", agent = true, active = true)))
        // The bot's picture, drawn here: a disc of colour with a face, as a PNG the agent would serve.
        val pictures = AgentPictures("fx-connection") { picture() }
        rule.setContent {
            CompositionLocalProvider(LocalAgentPictures provides pictures) {
                HappyTheme { AgentHomeScreen("Studio", feed, AgentLinkStatus.Connected, accounts, AgentHomeActions({}, {}, {}, {}, {}, {}), now = NOW) }
            }
        }
        for (parent in listOf("ab1", "at1", "ap1")) rule.onNodeWithTag(AgentHomeTags.toggle(parent), useUnmergedTree = true).performClick()
        rule.waitForIdle()
        SystemClock.sleep(800)
        device.takeScreenshot(File(evidence, "agent-home-marks.png"))
    }

    private fun picture(): ByteArray {
        val bitmap = Bitmap.createBitmap(256, 256, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        canvas.drawColor(Color.rgb(255, 196, 61))
        paint.color = Color.rgb(40, 30, 20)
        canvas.drawCircle(92f, 110f, 16f, paint)
        canvas.drawCircle(164f, 110f, 16f, paint)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 14f
        canvas.drawArc(76f, 120f, 180f, 196f, 20f, 140f, false, paint)
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    private companion object {
        const val NOW = 1_755_400_000_000L
    }
}
