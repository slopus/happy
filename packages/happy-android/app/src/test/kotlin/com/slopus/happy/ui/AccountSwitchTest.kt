package com.slopus.happy.ui

import android.content.Context
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.OpenAccount
import com.slopus.happy.accounts.AccountStore
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.config.ServerConfig
import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.SecretKeyBackup
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.sync.eventually
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.connection.AgentHomeTags
import com.slopus.happy.ui.home.HomeTags
import com.slopus.happy.ui.settings.SettingsPageTags
import com.slopus.happy.ui.start.StartTags
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Switching accounts, as iOS's switcher and Settings do it
 * (AccountSwitcher): the open account changes once per switch, never through
 * "none" (which is the first screen); from Settings, Settings stays on top
 * over the new account's home, in place and where it was scrolled to.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AccountSwitchTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val keys = SoftwareKeys()
    private val first = FakeHappyServer().start()
    private val second = FakeHappyServer(ByteArray(32) { (it * 11 + 3).toByte() }).start()
    private val agent = "agent-connection-1"
    private lateinit var graph: AppGraph
    private val watching = CoroutineScope(Dispatchers.Unconfined)

    @Before
    fun setUp() {
        val names = listOf(ExpoSecureStore.PREFS_NAME, AccountStore.PREFS_NAME, AccountStore.CREDENTIALS_PREFS_NAME, ServerConfig.PREFS_NAME, AgentConnections.REGISTRY_PREFS, AgentConnections.SECRETS_PREFS)
        for (name in names) context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
        File(context.filesDir, "mmkv").deleteRecursively()
        // One agent connection, paired before: its credentials and its entry, as AgentConnections keeps them.
        ExpoSecureStore(context.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE), keys, keychainService = AgentConnections.KEYCHAIN_SERVICE)
            .setItem(agent, Json.encodeToString(AgentConnectionCredentials.serializer(), AgentConnectionCredentials("127.0.0.1", 9, "dv1", "token")))
        context.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE).edit()
            .putString("accounts", """[{"id":"$agent","name":"Studio","addedAt":1}]""").commit()
        graph = AppGraph(context, "android/test", first.url, keys, databaseName = null).also { it.setForeground(true) }
        runBlocking { graph.auth.restore(backup(first)) }
    }

    @After
    fun tearDown() {
        watching.cancel()
        runBlocking { graph.account.value?.stop() }
        first.close()
        second.close()
    }

    private fun backup(server: FakeHappyServer) = SecretKeyBackup.format(encodeBase64(server.secret, Base64Variant.Url))

    /** The open Happy account, once the sign-in just made shows. */
    private fun happyId(): String {
        eventually(message = "a Happy account open") { graph.openAccount.value is OpenAccount.Happy && (graph.openAccount.value as OpenAccount.Happy).id == graph.accountStore.registry.value.activeId }
        return (graph.openAccount.value as OpenAccount.Happy).id
    }

    /** Every value [AppGraph.openAccount] takes from now on. */
    private fun record(): List<OpenAccount> {
        val seen = java.util.Collections.synchronizedList(mutableListOf<OpenAccount>())
        watching.launch { graph.openAccount.collect { seen += it } }
        return seen
    }

    @Test
    fun aSwitchBetweenKindsNeverPassesThroughNoAccount() {
        val happy = happyId()
        val seen = record()
        repeat(3) {
            runBlocking { graph.open(agent).join() }
            assertEquals(OpenAccount.Agent(agent), graph.openAccount.value)
            runBlocking { graph.open(happy).join() }
            assertEquals(OpenAccount.Happy(happy), graph.openAccount.value)
        }
        assertFalse("$seen", OpenAccount.None in seen)
        // One change per switch.
        assertEquals(listOf(OpenAccount.Happy(happy)) + List(3) { listOf(OpenAccount.Agent(agent), OpenAccount.Happy(happy)) }.flatten(), seen.toList())
    }

    /** Steps the UI a frame at a time until [done], failing the moment the first screen shows. */
    private fun stepUntil(message: String, done: () -> Boolean) {
        rule.mainClock.autoAdvance = false
        try {
            val deadline = System.currentTimeMillis() + 10_000
            while (true) {
                rule.mainClock.advanceTimeByFrame()
                assertTrue("the first screen showed during the switch", rule.onAllNodesWithTag(StartTags.BACKGROUND, useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
                if (done()) break
                check(System.currentTimeMillis() < deadline) { "timed out waiting for $message" }
                Thread.sleep(5)
            }
        } finally {
            rule.mainClock.autoAdvance = true
        }
    }

    private fun shows(tag: String) = rule.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun theFirstScreenNeverShowsWhileHomeSwitches() {
        val happy = happyId()
        rule.setContent { HappyApp(graph) }
        rule.waitUntilAtLeastOneExists(hasTestTag(HomeTags.BAR), 10_000)
        repeat(2) {
            graph.open(agent)
            stepUntil("agent home") { shows(AgentHomeTags.BAR) }
            graph.open(happy)
            stepUntil("Happy home") { shows(HomeTags.BAR) && !shows(AgentHomeTags.BAR) }
        }
    }

    @Test
    fun switchingInSettingsStaysInSettingsOverTheNewHome() {
        val happy = happyId()
        rule.setContent { HappyApp(graph) }
        rule.waitUntilAtLeastOneExists(hasTestTag(HomeTags.SETTINGS), 10_000)
        rule.node(HomeTags.SETTINGS).performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag(SettingsPageTags.account(agent)), 10_000)
        rule.waitForIdle()
        // Scrolled a little, the accounts card still in reach.
        rule.node(SettingsPageTags.HEADER).performTouchInput { swipeUp(startY = centerY, endY = centerY - 150f) }
        rule.waitForIdle()
        val header = rule.node(SettingsPageTags.HEADER).fetchSemanticsNode().boundsInRoot.top

        // To the other kind: Settings stays, now the agent's (its picture has the pencil), at the same place.
        rule.node(SettingsPageTags.account(agent)).performClick()
        stepUntil("the agent's Settings") { shows(SettingsPageTags.EDIT) && !rule.onAllNodesWithTag(SettingsPageTags.HEADER, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
        rule.waitForIdle()
        assertEquals(OpenAccount.Agent(agent), graph.openAccount.value)
        assertEquals(header, rule.node(SettingsPageTags.HEADER).fetchSemanticsNode().boundsInRoot.top, 1f)
        assertFalse(shows(HomeTags.BAR))

        // Back lands on the agent's home, which replaced the Happy account's underneath.
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitUntilAtLeastOneExists(hasTestTag(AgentHomeTags.BAR), 10_000)

        // And back to the Happy account from the agent's Settings.
        rule.waitUntilAtLeastOneExists(hasTestTag(AgentHomeTags.SETTINGS), 10_000)
        rule.node(AgentHomeTags.SETTINGS).performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag(SettingsPageTags.account(happy)), 10_000)
        rule.node(SettingsPageTags.account(happy)).performClick()
        stepUntil("the Happy account's Settings") { !shows(SettingsPageTags.EDIT) && shows(SettingsPageTags.HEADER) }
        rule.waitForIdle()
        assertEquals(OpenAccount.Happy(happy), graph.openAccount.value)
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitUntilAtLeastOneExists(hasTestTag(HomeTags.BAR), 10_000)
    }

    @Test
    fun aSwitchOfTheSameKindChangesSettingsInPlaceWithoutMoving() {
        val firstId = happyId()
        // A second Happy account, added while the agent is open (so on the chosen server), then the first again.
        runBlocking { graph.open(agent).join() }
        graph.serverConfig.set(second.url)
        runBlocking { graph.auth.restore(backup(second)) }
        val secondId = happyId()
        runBlocking { graph.open(firstId).join() }

        rule.setContent { HappyApp(graph) }
        rule.waitUntilAtLeastOneExists(hasTestTag(HomeTags.SETTINGS), 10_000)
        rule.node(HomeTags.SETTINGS).performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag(SettingsPageTags.account(secondId)), 10_000)
        rule.waitForIdle()
        rule.node(SettingsPageTags.HEADER).performTouchInput { swipeUp(startY = centerY, endY = centerY - 150f) }
        rule.waitForIdle()
        val header = rule.node(SettingsPageTags.HEADER).fetchSemanticsNode().boundsInRoot.top

        rule.node(SettingsPageTags.account(secondId)).performClick()
        // Every frame of it: Settings on screen where it was, nothing dissolving.
        stepUntil("the second account") {
            assertEquals(header, rule.node(SettingsPageTags.HEADER).fetchSemanticsNode().boundsInRoot.top, 1f)
            graph.openAccount.value == OpenAccount.Happy(secondId)
        }
        rule.waitForIdle()
        assertEquals(header, rule.node(SettingsPageTags.HEADER).fetchSemanticsNode().boundsInRoot.top, 1f)
        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitUntilAtLeastOneExists(hasTestTag(HomeTags.BAR), 10_000)
    }
}
