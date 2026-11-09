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
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentFeedSection
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.AgentPictures
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.agent.MemberProfile
import com.slopus.happy.agent.MemberProfileSource
import com.slopus.happy.agent.MemberProfileTask
import com.slopus.happy.agent.MemberProfileUser
import com.slopus.happy.agent.MemberUsage
import com.slopus.happy.agent.TeamRole
import com.slopus.happy.agent.TeamUser
import com.slopus.happy.search.SearchAnswer
import com.slopus.happy.search.SearchHit
import com.slopus.happy.ui.connection.AgentHomeActions
import com.slopus.happy.ui.connection.AgentHomeScreen
import com.slopus.happy.ui.connection.AgentHomeTags
import com.slopus.happy.ui.connection.AgentSearchTags
import com.slopus.happy.ui.connection.LocalAgentPictures
import com.slopus.happy.ui.connection.MemberProfileScreen
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.theme.HappyTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Emulator-only fixture: a Happy Cloud member's profile and home's search
 * finding people, from synthetic data (no network, account or server).
 * Captured to the test app's external files under `member-profile/`.
 */
@RunWith(AndroidJUnit4::class)
class MemberProfileDeviceShots {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val directory = File(instrumentation.targetContext.getExternalFilesDir(null), "member-profile").apply { mkdirs() }
    private val now = System.currentTimeMillis()
    private val thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"
    private val pictures = AgentPictures("fx-cloud") { picture(Color.rgb(255, 196, 61)) }

    private fun shot(name: String) {
        rule.waitForIdle()
        SystemClock.sleep(800)
        device.takeScreenshot(File(directory, "$name.png"))
    }

    @Test fun profile() {
        val profile = MemberProfile(
            user = MemberProfileUser("u-ada", "Ada Lovelace", photo = thumbhash, role = "Staff engineer", teamRole = "owner"),
            totalTasks = 27,
            activeTasks = 4,
            lastActivityAt = now - 12 * 60_000,
            activeDays = 18,
            usage = mapOf(
                "hour" to MemberUsage(84_000, 6_100),
                "day" to MemberUsage(1_420_000, 96_000),
                "week" to MemberUsage(8_900_000, 610_000),
                "month" to MemberUsage(31_000_000, 2_400_000),
            ),
            recentTasks = listOf(
                MemberProfileTask("t1", "a1", "Fix login redirect", now - 12 * 60_000, working = true),
                MemberProfileTask("t2", "a2", "Write release notes", now - 3 * 3_600_000),
                MemberProfileTask("t3", "a3", "Plan the sprint", now - 26 * 3_600_000),
                MemberProfileTask("t4", "a4", "Migrate billing webhooks", now - 4 * 86_400_000, archived = true),
            ),
        )
        val opened = mutableListOf<String>()
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            CompositionLocalProvider(LocalAgentPictures provides pictures) {
                HappyTheme {
                    MemberProfileScreen(MemberProfileSource.State.Loaded(profile), listOf(TeamRole("owner", "Owner", builtIn = true)), { opened += it }, {}, {}, now = now)
                }
            }
        }
        rule.onAllNodesWithText("Ada Lovelace").onFirst().assertExists()
        shot("profile")
        device.swipe(device.displayWidth / 2, device.displayHeight * 3 / 4, device.displayWidth / 2, device.displayHeight / 4, 30)
        shot("profile-scrolled")
        rule.onNodeWithText("Write release notes").performClick()
        assertEquals(listOf("a2"), opened)
    }

    @Test fun searchFindsPeople() {
        val feed = AgentFeed(
            loaded = true,
            rows = listOf(
                AgentFeedRow.Section(AgentFeedSection.Tasks),
                AgentFeedRow.Conversation("at1", "Adapt the billing page", ConversationKind.Task, 0, seed = "t1", activityAt = now - 60_000),
                AgentFeedRow.Conversation("at2", "Write release notes", ConversationKind.Task, 0, seed = "t2", activityAt = now - 600_000),
            ),
        )
        val people = mapOf("u-ada" to TeamUser("u-ada", "Ada Lovelace", thumbhash))
        val answer = { q: String ->
            SearchAnswer(
                q,
                listOf(
                    SearchHit.User("user:u-ada", 1, "u-ada", "Ada Lovelace"),
                    SearchHit.Agent("agent:at1", 2, "at1", "Adapt the billing page", "task", workspaceId = "w1"),
                    SearchHit.User("user:u-adam", 3, "u-adam", "Adam Smith"),
                ),
            )
        }
        val opened = mutableListOf<String>()
        val accounts = AccountMenu(listOf(AccountMenuEntry("fx-cloud", "@acme", agent = true, active = true)))
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            CompositionLocalProvider(LocalAgentPictures provides pictures) {
                HappyTheme {
                    AgentHomeScreen(
                        "@acme", feed, AgentLinkStatus.Connected, accounts,
                        AgentHomeActions({}, {}, {}, {}, {}, {}, projectsAvailable = false, onOpenPerson = { opened += it }),
                        search = { q -> answer(q) },
                        people = people,
                    )
                }
            }
        }
        rule.onNodeWithTag(AgentHomeTags.SEARCH).performClick()
        rule.onNodeWithTag(AgentSearchTags.FIELD).performTextInput("ada")
        rule.waitUntil(5_000) { rule.onAllNodesWithTagExists(AgentSearchTags.result("user:u-adam")) }
        // The keyboard down, so the results show whole; the search stays.
        rule.runOnUiThread {
            androidx.core.view.WindowInsetsControllerCompat(rule.activity.window, rule.activity.window.decorView).hide(androidx.core.view.WindowInsetsCompat.Type.ime())
        }
        shot("search-people")
        rule.onNodeWithTag(AgentSearchTags.result("user:u-ada"), useUnmergedTree = true).performClick()
        assertEquals(listOf("u-ada"), opened)
    }

    private fun androidx.compose.ui.test.junit4.ComposeTestRule.onAllNodesWithTagExists(tag: String) =
        onAllNodes(androidx.compose.ui.test.hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

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
}
