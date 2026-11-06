package com.slopus.happy.fixture

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.navigation.NavGraph
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.call.CallScreen
import com.slopus.happy.conversation.WorkChoice
import com.slopus.happy.conversation.WorkKind
import com.slopus.happy.ui.HomeRoute
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.ui.call.callScreen
import com.slopus.happy.ui.conversation.ConversationRoute
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.ThemePreference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The call's screen moves ([callScreen], what `CallScreenEffect` hands the
 * call) on a device, over the app's own routes: home, a conversation, new
 * work as compose opens it and a page that is neither. The pages are plain
 * labels naming their route; nothing reaches a computer. Shots go to the
 * app's external files under `call-nav/`. Run on an assigned emulator.
 */
@RunWith(AndroidJUnit4::class)
class CallNavDeviceShots {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val dir = File(instrumentation.targetContext.getExternalFilesDir(null), "call-nav").apply { mkdirs() }
    private lateinit var nav: NavHostController
    private lateinit var screen: CallScreen

    private fun show() {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            HappyTheme(ThemePreference.Light) {
                nav = rememberNavController()
                NavHost(nav, startDestination = HomeRoute) {
                    composable<HomeRoute> { Page("Home", "Studio Mac's bots, tasks and projects") }
                    composable<ConversationRoute> { entry ->
                        val route = entry.toRoute<ConversationRoute>()
                        when {
                            route.agentId != null -> Page("Conversation", route.agentId)
                            else -> Page("New ${if (route.kind == "bot") "bot" else "task"}", route.name?.takeIf { it.isNotEmpty() } ?: "Name (optional)")
                        }
                    }
                    composable<SettingsRoute> { Page("Settings", "a page that is no conversation") }
                }
            }
        }
        rule.waitForIdle()
        screen = callScreen(nav, CONNECTION, panel = null)
    }

    /** The stack, bottom first, as the call would name its pages. */
    private fun stack(): List<String> = onMain {
        nav.currentBackStack.value.filter { it.destination !is NavGraph }.map { entry ->
            when {
                entry.destination.route?.contains("HomeRoute") == true -> "home"
                entry.destination.route?.contains("SettingsRoute") == true -> "settings"
                else -> entry.toRoute<ConversationRoute>().let { it.agentId ?: "new ${it.kind}" }
            }
        }
    }

    private fun <T> onMain(block: () -> T): T {
        var result: Result<T>? = null
        rule.runOnUiThread { result = runCatching(block) }
        return result!!.getOrThrow()
    }

    private fun step(name: String, move: () -> Unit) {
        onMain(move)
        rule.waitForIdle()
        SystemClock.sleep(700)
        device.takeScreenshot(File(dir, "$name.png"))
        android.util.Log.i("CallNav", "$name stack=${stack()} focused=${onMain { screen.focused }} atHome=${onMain { screen.atHome }}")
    }

    @Test fun newWorkBackAndHomeMoveTheAppsOwnStack() {
        show()
        step("01-open") { screen.open("research-agent") }
        assertEquals(listOf("home", "research-agent"), stack())
        assertEquals("research-agent", onMain { screen.focused })

        // New work takes the conversation's place, as compose does from a chat.
        step("02-new-bot") { screen.compose(WorkChoice(WorkKind.Bot, "Voice bot")) }
        assertEquals(listOf("home", "new bot"), stack())

        var went = false
        step("03-back") { went = screen.back() }
        assertTrue(went)
        assertEquals(listOf("home"), stack())
        assertTrue(onMain { screen.atHome })

        // At home there is nothing to go back to.
        step("04-back-at-home") { went = screen.back() }
        assertFalse(went)
        assertEquals(listOf("home"), stack())

        step("05-open-again") { screen.open("research-agent") }
        step("06-settings") { nav.navigate(SettingsRoute()) }
        assertEquals(null, onMain { screen.focused })
        // Over a page that is no conversation, new work goes on top of it.
        step("07-new-task") { screen.compose(WorkChoice()) }
        assertEquals(listOf("home", "research-agent", "settings", "new task"), stack())

        step("08-home") { screen.home() }
        assertEquals(listOf("home"), stack())
        assertTrue(onMain { screen.atHome })
    }

    private companion object {
        const val CONNECTION = "fx-connection"
    }
}

@androidx.compose.runtime.Composable
private fun Page(title: String, detail: String) {
    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Text(title, style = MaterialTheme.typography.headlineMedium)
            Text(detail, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 12.dp))
        }
    }
}
