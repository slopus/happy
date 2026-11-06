package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.Text
import androidx.activity.compose.setContent
import androidx.test.core.app.ActivityScenario
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.slopus.happy.agent.AgentFeed
import com.slopus.happy.agent.AgentFeedRow
import com.slopus.happy.agent.AgentFeedSection
import com.slopus.happy.agent.AgentLinkStatus
import com.slopus.happy.agent.ConversationKind
import com.slopus.happy.call.CallControl
import com.slopus.happy.call.CallScreen
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.call.callScreen
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.connection.AgentHomeActions
import com.slopus.happy.ui.connection.AgentHomeScreen
import com.slopus.happy.ui.conversation.ConversationRoute
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * What the call presses on screen as the person would (`VoiceTouch`), on a device, over home's real list and
 * compose button and a pushed page's real back button, each followed by what the call then does: compose for
 * new work (nothing moves), a row far down the list (scrolled to first) and one on screen opened, back, and
 * home. Logs each step's start and end under `VoiceTouch`, with a pause between, for a screen recording to be
 * reviewed against. `dark` = true draws it dark. Run on an assigned emulator.
 */
@RunWith(AndroidJUnit4::class)
class VoiceTouchDeviceShots {
    /** A plain activity, not the compose test rule's: its frames are the screen's own, as a recording shows them. */
    private lateinit var scenario: ActivityScenario<ComponentActivity>

    private val dark = InstrumentationRegistry.getArguments().getString("dark") == "true"
    private lateinit var nav: NavHostController
    private lateinit var screen: CallScreen
    private val began = SystemClock.elapsedRealtime()

    private val titles = listOf("Research Assistant", "Inbox Triage") + (1..40).map { "Fixture task $it" }

    private val named = titles.mapIndexed { index, title -> (if (index < 2) "bot-$index" else "task-${index - 2}") to title }.toMap()

    private fun feed() = AgentFeed(loaded = true, rows = buildList {
        add(AgentFeedRow.Section(AgentFeedSection.Bots))
        titles.take(2).forEachIndexed { index, title -> add(AgentFeedRow.Conversation(agentId = "bot-$index", title = title, kind = ConversationKind.Bot, depth = 0, activityAt = 1_755_400_000_000L)) }
        add(AgentFeedRow.Section(AgentFeedSection.Tasks))
        titles.drop(2).forEachIndexed { index, title -> add(AgentFeedRow.Conversation(agentId = "task-$index", title = title, kind = ConversationKind.Task, depth = 0, activityAt = 1_755_400_000_000L)) }
    })

    private fun show() {
        scenario = ActivityScenario.launch(ComponentActivity::class.java)
        scenario.onActivity { activity -> activity.enableEdgeToEdge(); activity.setContent {
            HappyTheme(if (dark) ThemePreference.Dark else ThemePreference.Light) {
                nav = rememberNavController()
                NavHost(nav, startDestination = HomeRoute) {
                    composable<HomeRoute> {
                        val accounts = AccountMenu(listOf(AccountMenuEntry(CONNECTION, "Studio Mac", agent = true, active = true)))
                        AgentHomeScreen("Studio Mac", feed(), AgentLinkStatus.Connected, accounts, AgentHomeActions({}, {}, {}, {}, {}, {}, onVoice = {}))
                    }
                    composable<ConversationRoute> { entry ->
                        val title = named[entry.toRoute<ConversationRoute>().agentId] ?: "Conversation"
                        Screen(header = { StackHeader(title, onBack = { nav.popBackStack() }) }) { Text("The conversation's messages") }
                    }
                }
            }
        } }
        SystemClock.sleep(1_500)
        scenario.onActivity { screen = callScreen(nav, CONNECTION, panel = null) }
    }

    /** One step as the call takes it: the press, then what it does, on the main thread, timed. */
    private fun step(name: String, act: suspend CallScreen.() -> Unit) {
        val start = SystemClock.elapsedRealtime()
        android.util.Log.i("VoiceTouch", "%.2f start %s".format((start - began) / 1000.0, name))
        runBlocking { withContext(Dispatchers.Main.immediate) { screen.act() } }
        val end = SystemClock.elapsedRealtime()
        android.util.Log.i("VoiceTouch", "%.2f end %s (%d ms)".format((end - began) / 1000.0, name, end - start))
        SystemClock.sleep(2_000)
    }

    @Test fun eachMoveIsPressedAsAFingerWould() {
        show()
        SystemClock.sleep(2_500)
        step("compose") { press(CallControl.Compose) }
        step("open far") { press(CallControl.Row("task-35")); open("task-35") }
        step("back") { press(CallControl.Back); back() }
        step("open near") { press(CallControl.Row("bot-0")); open("bot-0") }
        step("home") { press(CallControl.Back); home() }
        var home = false
        scenario.onActivity { home = screen.atHome }
        assertEquals(true, home)
        android.util.Log.i("VoiceTouch", "done")
    }

    private companion object {
        const val CONNECTION = "fx-connection"
    }
}
