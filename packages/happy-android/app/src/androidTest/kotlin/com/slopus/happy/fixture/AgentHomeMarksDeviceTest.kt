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
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentFeedSection
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.AgentPictures
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.conversation.Todo
import com.slopus.happy.ui.connection.AgentHomeActions
import com.slopus.happy.ui.connection.PlaceRead
import com.slopus.happy.ui.connection.SurfaceBody
import com.slopus.happy.ui.connection.SurfaceScreen
import com.slopus.happy.ui.connection.AgentHomeScreen
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
 * Agent home on a device with Artifacts and Surfaces, bots, tasks, a
 * project and their subtasks, the agent's own picture on the bar,
 * captured to the test app's files under `device-evidence/` so a review
 * sees each section's card and what each row wears before its title. Every
 * row is synthetic.
 */
@RunWith(AndroidJUnit4::class)
class AgentHomeMarksDeviceTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val app = InstrumentationRegistry.getInstrumentation().targetContext
    private val evidence = File(app.filesDir, "device-evidence").apply { mkdirs() }

    private fun conversation(
        agentId: String, title: String, kind: ConversationKind, depth: Int = 0, parentId: String? = null,
        minutes: Long = 5, working: Boolean = false, unread: Boolean = false, blocked: Boolean = false, picture: String? = null,
    ) = AgentFeedRow.Conversation(
        agentId = agentId, title = title, kind = kind, depth = depth, picture = picture,
        working = working, unread = unread, blocked = blocked, activityAt = NOW - minutes * 60_000, parentId = parentId,
    )

    private val feed = AgentFeed(
        loaded = true,
        rows = listOf(
            AgentFeedRow.Section(AgentFeedSection.Places),
            AgentFeedRow.Artifacts,
            AgentFeedRow.Surface("s1", "Groceries", "todo"),
            AgentFeedRow.Surface("s2", "Launch plan", "document"),
            AgentFeedRow.Surface("s3", "Team calendar", "calendar"),
            AgentFeedRow.Section(AgentFeedSection.Bots),
            conversation("ab1", "Happy", ConversationKind.Bot, minutes = 20, picture = "/v0/bots/b1/avatar"),
            conversation("as1", "Review the PR", ConversationKind.Subtask, depth = 1, parentId = "ab1", working = true),
            conversation("ab2", "Research", ConversationKind.Bot, minutes = 180),
            AgentFeedRow.Section(AgentFeedSection.Tasks),
            conversation("at1", "Fix login redirect", ConversationKind.Task, minutes = 1),
            conversation("as2", "Trace the redirect loop", ConversationKind.Subtask, depth = 1, parentId = "at1", unread = true),
            conversation("as3", "Write the regression test", ConversationKind.Subtask, depth = 1, parentId = "at1", minutes = 12),
            conversation("at2", "Write release notes", ConversationKind.Task, unread = true, minutes = 40),
            conversation("at3", "Plan the sprint", ConversationKind.Task, blocked = true, minutes = 90),
            AgentFeedRow.Section(AgentFeedSection.Projects),
            AgentFeedRow.Folder("p1", "happy", 0),
            conversation("ap1", "Android home feed", ConversationKind.Project, depth = 1, minutes = 2 * 1440),
            conversation("as4", "Port the row marks", ConversationKind.Subtask, depth = 2, parentId = "ap1", minutes = 30),
            AgentFeedRow.Folder("w1", "fix-scroll", 1),
            conversation("aw1", "Scroll jumps", ConversationKind.Project, depth = 2, minutes = 9 * 1440),
        ),
    )

    @Test fun capture() {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        // The agent's own picture, kept as a file the way a refresh keeps it, on the bar's menu button.
        val instance = File(evidence, "instance-avatar.png").apply { writeBytes(picture(Color.rgb(88, 86, 214))) }
        val accounts = AccountMenu(listOf(AccountMenuEntry("fx-connection", "Studio", imageUrl = "file://${instance.path}", agent = true, active = true)))
        // The bot's picture, drawn here: a disc of colour with a face, as a PNG the agent would serve.
        val pictures = AgentPictures("fx-connection") { picture(Color.rgb(255, 196, 61)) }
        rule.setContent {
            CompositionLocalProvider(LocalAgentPictures provides pictures) {
                HappyTheme { AgentHomeScreen("Studio", feed, AgentLinkStatus.Connected, accounts, AgentHomeActions({}, {}, {}, {}, {}, {}), now = NOW) }
            }
        }
        rule.waitForIdle()
        SystemClock.sleep(800)
        device.takeScreenshot(File(evidence, "agent-home-marks.png"))
    }

    /** A todo list Surface as home's Groceries row opens it. */
    @Test fun captureSurface() {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        val todos = listOf(Todo("t1", "Eggs", false), Todo("t2", "Sourdough loaf", false), Todo("t3", "Milk", true))
        rule.setContent { HappyTheme { SurfaceScreen("Groceries", PlaceRead.Ready(SurfaceBody.Todos(todos)), {}, {}, {}) } }
        rule.waitForIdle()
        SystemClock.sleep(500)
        device.takeScreenshot(File(evidence, "agent-surface-todo.png"))
    }

    private fun picture(ground: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(256, 256, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        canvas.drawColor(ground)
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
