package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.core.view.WindowCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentFeedSection
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatReduction
import com.slopus.happy.chat.ChatSessionInfo
import com.slopus.happy.chat.ChatSnapshot
import com.slopus.happy.chat.ChatState
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.Block
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.data.SessionRecord
import com.slopus.happy.model.Machine
import com.slopus.happy.model.MachineMetadata
import com.slopus.happy.model.Session
import com.slopus.happy.model.SessionListGrouping
import com.slopus.happy.model.SessionMetadata
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.ui.chat.ChatScreen
import com.slopus.happy.ui.chat.ChatScreenActions
import com.slopus.happy.ui.connection.AgentHomeActions
import com.slopus.happy.ui.connection.AgentHomeScreen
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.home.HomeListCallbacks
import com.slopus.happy.ui.home.HomeListInputs
import com.slopus.happy.ui.home.HomeScreen
import com.slopus.happy.ui.home.HomeScreenActions
import com.slopus.happy.ui.home.HomeSnapshot
import com.slopus.happy.ui.home.deriveHomeList
import com.slopus.happy.ui.settings.AboutInfo
import com.slopus.happy.ui.settings.SettingsProfile
import com.slopus.happy.ui.settings.SettingsScreen
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * The glass bars' bottom edge on a device, where RenderEffect really blurs:
 * agent home, an agent chat, the legacy home and chat, and Settings, light
 * and dark, at rest and held mid-drag with content under the bar's foot.
 * Every row is synthetic. Shots go to the app's external files under
 * `glass-edge/`, named `<-e shots>-<screen>-<state>-<theme>-<width>dp.png`.
 * Run on an assigned emulator, not someone's phone.
 */
@RunWith(AndroidJUnit4::class)
class GlassEdgeShots {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext
    private val prefix = InstrumentationRegistry.getArguments().getString("shots", "now")
    private val dir = File(app.getExternalFilesDir(null), "glass-edge").apply { mkdirs() }

    private fun shoot(screen: String, dark: Boolean, drag: Float, content: @Composable () -> Unit) {
        rule.runOnUiThread {
            rule.activity.enableEdgeToEdge()
            WindowCompat.getInsetsController(rule.activity.window, rule.activity.window.decorView).isAppearanceLightStatusBars = !dark
        }
        rule.setContent { HappyTheme(if (dark) ThemePreference.Dark else ThemePreference.Light) { content() } }
        rule.waitForIdle()
        val theme = if (dark) "dark" else "light"
        val width = app.resources.configuration.screenWidthDp
        capture("$prefix-$screen-rest-$theme-${width}dp")
        // Held, not flung: the content stays where the finger left it while the shot is taken.
        rule.onRoot().performTouchInput {
            down(Offset(centerX, centerY))
            moveBy(Offset(0f, drag / 2))
            moveBy(Offset(0f, drag / 2))
        }
        rule.waitForIdle()
        capture("$prefix-$screen-held-$theme-${width}dp")
        rule.onRoot().performTouchInput { up() }
    }

    private fun capture(name: String) {
        SystemClock.sleep(700)
        device.takeScreenshot(File(dir, "$name.png"))
        android.util.Log.i("GlassEdge", "captured $name")
    }

    private val now = 1_755_400_000_000L

    private fun feed(): AgentFeed {
        val rows = ArrayList<AgentFeedRow>()
        fun conversation(id: String, kind: ConversationKind, title: String) = AgentFeedRow.Conversation(
            agentId = id, title = title, kind = kind, depth = 0, working = false, unread = false, blocked = false,
            activityAt = now - id.hashCode().toLong().mod(3_600_000L * 48), parentId = null,
        )
        rows += AgentFeedRow.Section(AgentFeedSection.Bots)
        listOf("Chief of Staff", "Release captain", "Inbox triage").forEachIndexed { i, t -> rows += conversation("bot-$i", ConversationKind.Bot, t) }
        rows += AgentFeedRow.Section(AgentFeedSection.Tasks)
        repeat(16) { rows += conversation("task-$it", ConversationKind.Task, "Synthetic task $it: the login page loops back to itself") }
        return AgentFeed(loaded = true, rows = rows)
    }

    private fun agentHome(dark: Boolean) = shoot("agent-home", dark, drag = -180f) {
        val accounts = AccountMenu(listOf(AccountMenuEntry("fx-connection", "Fixture", agent = true, active = true)))
        AgentHomeScreen("Fixture", feed(), AgentLinkStatus.Connected, accounts, AgentHomeActions({}, {}, {}, {}, {}, {}))
    }

    private val markdown = "The callback rewrites the URL **before** the cookie is written, so the *next* request has no session. " +
        "Check that `setSession` runs first, then redirect to `next`."

    private fun conversation(dark: Boolean) = shoot("conversation", dark, drag = 180f) {
        val builder = ConversationRowBuilder()
        val history = (0 until 24).flatMap { i ->
            listOf(
                Message("u$i", "user", i * 2L, listOf(Block.Text("Synthetic question $i: why does the login page loop back to itself?"))),
                Message("a$i", "agent", i * 2L + 1, listOf(Block.Text("Step ${i + 1}. $markdown"))),
            )
        }
        val agent = AgentInfo("fx-agent", "fx-workspace", null, "Fix the login redirect", "idle", null, null, now, now, 0, 0)
        val rows = history.flatMap { builder.rows(it, "fx-agent", null, false) }
        ConversationScreen(ConversationState(created = true, loaded = true, rows = rows.asReversed(), agent = agent), ConversationScreenActions())
    }

    private val session = ChatSessionInfo.from(
        SessionRecord(
            "s", 0, 0, 1, true, 0,
            """{"path":"/home/me/app","host":"devbox","homeDir":"/home/me","os":"linux","summary":{"text":"Fix the login redirect","updatedAt":1}}""",
            1, null, 1, "", null,
        ),
    )

    private fun chat(dark: Boolean) = shoot("chat", dark, drag = 180f) {
        val transcript = (0 until 16).flatMap { i ->
            listOf(
                ChatReduction.buildRow(ChatMessage.AgentText("a$i", 2L * i + 1, "Step ${i + 1}: $markdown"), true)!!,
                ChatReduction.buildRow(ChatMessage.UserText("u$i", "l$i", 2L * i, "What happens at step ${i + 1}?"), false)!!,
            )
        }.asReversed()
        ChatScreen(
            state = ChatState(ChatSnapshot(transcript, loaded = true), session, sessionLoaded = true, online = true),
            draft = "",
            bubbleColor = "gray",
            actions = ChatScreenActions(),
        )
    }

    private fun home(dark: Boolean) = shoot("home", dark, drag = -180f) {
        val machine = Machine(
            id = "m1", seq = 0, createdAt = 0, updatedAt = 0, active = true, activeAt = 0,
            metadata = MachineMetadata.parse(
                buildJsonObject {
                    put("host", "studio.local"); put("platform", "darwin"); put("happyCliVersion", "1.0.0")
                    put("happyHomeDir", "/Users/dev/.happy"); put("homeDir", "/Users/dev"); put("displayName", "Studio")
                },
            ),
            metadataVersion = 0, daemonState = null, daemonStateVersion = 0,
        )
        val noon = LocalDate.of(2026, 10, 16).atTime(12, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
        val sessions = (0 until 14).map { i ->
            Session(
                id = "s$i", seq = 0, createdAt = 0, updatedAt = 0, active = true, activeAt = 1, projectId = null,
                metadata = SessionMetadata.parse(
                    buildJsonObject {
                        put("path", "/Users/dev/happy"); put("host", "studio.local"); put("machineId", "m1")
                        putJsonObject("summary") { put("text", "Synthetic session $i: glass header polish"); put("updatedAt", 0) }
                    },
                ),
                metadataVersion = 0, attention = com.slopus.happy.model.AgentAttention.None, agentStateVersion = 0, thinking = false, lastMessageSentAt = noon - i * 3_600_000L,
            )
        }
        val state = deriveHomeList(
            HomeListInputs(HomeSnapshot(sessions, listOf(machine)), SessionListGrouping.Flat, true, emptySet(), emptySet(), emptySet()),
            ZoneOffset.UTC,
            LocalDate.of(2026, 10, 16),
        )
        HomeScreen(
            state, ConnectionStatus.CONNECTED, state.grouping,
            HomeListCallbacks({}, {}, {}, {}, {}, {}, {}, { _, _ -> }),
            HomeScreenActions({}, {}, {}, {}, {}),
            accounts = AccountMenu(listOf(AccountMenuEntry("0123456789abcdef", "Steve", active = true))),
        )
    }

    private fun settings(dark: Boolean) = shoot("settings", dark, drag = -240f) {
        SettingsScreen(
            profile = SettingsProfile("0123456789abcdef", "Ada Lovelace", "@ada"),
            about = AboutInfo("1.6.0"),
            accounts = AccountMenu(listOf(AccountMenuEntry("0123456789abcdef", "Ada Lovelace", active = true), AccountMenuEntry("fedcba9876543210", "Work"))),
        )
    }

    @Test fun agentHomeLight() = agentHome(false)
    @Test fun agentHomeDark() = agentHome(true)
    @Test fun conversationLight() = conversation(false)
    @Test fun conversationDark() = conversation(true)
    @Test fun chatLight() = chat(false)
    @Test fun chatDark() = chat(true)
    @Test fun homeLight() = home(false)
    @Test fun homeDark() = home(true)
    @Test fun settingsLight() = settings(false)
    @Test fun settingsDark() = settings(true)
}
