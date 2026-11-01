package com.slopus.happy.fixture

import android.os.SystemClock
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.setContent
import androidx.test.core.app.ActivityScenario
import androidx.navigation.NavHostController
import androidx.navigation.NavGraph
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.slopus.happy.HappyApplication
import com.slopus.happy.AppGraph
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import com.slopus.happy.MaxRefreshRate
import com.slopus.happy.OpenAccount
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.Lifecycle
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.SettingsRoute
import com.slopus.happy.ui.artifacts.AgentArtifactsRoute
import com.slopus.happy.ui.connection.AgentAppearanceRoute
import com.slopus.happy.ui.connection.AgentProfileRoute
import com.slopus.happy.ui.conversation.ConversationDetailsRoute
import com.slopus.happy.ui.conversation.ConversationRoute
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Opt-in, read-only navigation through the already-open agent account. Never
 * seeds, switches accounts, edits a setting, sends a message or clears data.
 * Uses the production graph/screens; only the activity and navigation driver
 * are test-owned. dumpsys includes instrumentation overhead, so these numbers
 * describe retained-stack growth, not production absolute process memory.
 */
@RunWith(AndroidJUnit4::class)
class NavigationRetentionDeviceTest {
    private var scenario: ActivityScenario<ComponentActivity>? = null
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)
    private lateinit var nav: NavHostController
    private lateinit var graph: AppGraph

    @After fun close() { scenario?.close() }

    private fun <T : Any> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        return checkNotNull(result)
    }

    private fun show(): String {
        check(InstrumentationRegistry.getArguments().getString("allowExistingAccount") == "true") {
            "Pass allowExistingAccount=true to navigate the existing account read-only"
        }
        graph = runBlocking { (app.applicationContext as HappyApplication).graphReady.await() }
        val account = graph.openAccount.value as? OpenAccount.Agent ?: error("Open an agent account first")
        scenario = ActivityScenario.launch(ComponentActivity::class.java)
        scenario!!.onActivity { activity ->
            activity.enableEdgeToEdge()
            MaxRefreshRate.follow(activity)
            activity.lifecycleScope.launch {
                activity.repeatOnLifecycle(Lifecycle.State.STARTED) {
                    graph.setForeground(true)
                    graph.requestSync()
                    try { awaitCancellation() } finally { graph.setForeground(false) }
                }
            }
            activity.setContent { HappyApp(graph, onNavigationReady = { nav = it }) }
        }
        check(device.wait(Until.hasObject(By.desc("Settings")), 15_000))
        return account.id
    }

    private fun settled() {
        SystemClock.sleep(900)
        instrumentation.waitForIdleSync()
    }

    @Test fun deepStackMemory() {
        val connection = show()
        val evidence = File(app.getExternalFilesDir(null), "retention-evidence").apply { mkdirs() }
        fun sample(name: String) {
            settled()
            File(evidence, "$name.txt").writeText(device.executeShellCommand("dumpsys meminfo ${app.packageName}"))
            val depth = onMain { nav.currentBackStack.value.count { it.destination !is NavGraph } }
            android.util.Log.i("RetentionEvidence", "$name depth=$depth")
        }
        fun push(route: Any, name: String) {
            onMain { nav.navigate(route) }
            sample(name)
        }
        sample("00-home")
        val session = checkNotNull(graph.agentSessions.session(connection))
        val deadline = SystemClock.uptimeMillis() + 15_000
        while (session.catalog.value.bots.values.none { it["systemKey"]?.jsonPrimitive?.contentOrNull == "chief_of_staff" }) {
            check(SystemClock.uptimeMillis() < deadline) { "The existing account has no cached Chief of Staff" }
            SystemClock.sleep(50)
        }
        val chief = session.catalog.value.bots.values.first { it["systemKey"]?.jsonPrimitive?.contentOrNull == "chief_of_staff" }
        val agent = checkNotNull((chief["agent"] as? JsonObject)?.get("id")?.jsonPrimitive?.contentOrNull)
        val chat = ConversationRoute(connection, agent)
        push(chat, "01-chat")
        push(ConversationDetailsRoute(connection, agent), "02-agent")
        push(chat, "03-second-chat")
        push(SettingsRoute(), "04-settings")
        push(AgentAppearanceRoute(connection), "05-appearance")
        push(AgentProfileRoute(connection), "06-profile")
        push(AgentArtifactsRoute(connection), "07-artifacts")
        // Real OS trim signal, not a stack-size eviction policy.
        device.executeShellCommand("am send-trim-memory ${app.packageName} RUNNING_LOW")
        sample("08-memory-pressure")
        repeat(7) { index ->
            onMain { check(nav.popBackStack()) }
            sample("${9 + index}-return")
        }
        assertEquals(1, onMain { nav.currentBackStack.value.count { it.destination !is NavGraph } })
        check(device.hasObject(By.desc("Settings")))
    }

    @Test fun rapidTapBack() {
        show()
        settled()
        val home = onMain { nav.currentBackStackEntry!!.id }
        for (delay in listOf(45L, 225L, 405L)) repeat(3) {
            val button = checkNotNull(device.wait(Until.findObject(By.desc("Settings")), 10_000)).visibleCenter
            device.click(button.x, button.y)
            val tapped = SystemClock.uptimeMillis()
            SystemClock.sleep(delay)
            // UiAutomator's pressBack adds an idle wait. Inject real key events
            // directly so the requested delay really interrupts the transition.
            val now = SystemClock.uptimeMillis()
            instrumentation.uiAutomation.injectInputEvent(KeyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK, 0), true)
            instrumentation.uiAutomation.injectInputEvent(KeyEvent(now, now, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK, 0), true)
            android.util.Log.i("RetentionEvidence", "tapBack requested=$delay actual=${SystemClock.uptimeMillis() - tapped}")
            settled()
            assertEquals(home, onMain { nav.currentBackStackEntry!!.id })
            check(device.hasObject(By.desc("Settings")))
        }
    }
}