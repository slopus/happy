package com.slopus.happy.journeys

import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.data.OutboxKind
import com.slopus.happy.data.OutboxRecord
import com.slopus.happy.data.OutboxState
import com.slopus.happy.net.ConnectionStatus
import com.slopus.happy.push.BackgroundSendNotifications
import com.slopus.happy.push.BackgroundSendReceiver
import com.slopus.happy.sync.MessageSender
import com.slopus.happy.sync.SendOptions
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.chat.ChatScreenTags
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.chat.MessageTags
import com.slopus.happy.ui.home.FlatRowTags
import com.slopus.happy.ui.home.HomeTags
import com.slopus.happy.ui.node
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Journey 4, losing the server and getting it back: home says the
 * connection dropped; a message typed meanwhile stays "Sending…" while the
 * server refuses it, and so does a backlog of 150 more; once the server is
 * back everything goes out, in order, in posts of at most 100, and none
 * fails. Leaving the app with a message unsent schedules "Message not
 * sent"; coming back cancels it.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OfflineJourneyTest {
    @get:Rule val rule = createComposeRule()

    private val journey = Journey()
    private val server = journey.server
    private lateinit var graph: AppGraph
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    @After
    fun tearDown() {
        scope.cancel()
        journey.close()
    }

    private fun openChat() {
        journey.machine()
        journey.session("s1", updatedAt = 100, title = "Flaky wifi")
        graph = journey.graph()
        journey.signIn(graph)
        rule.setContent { HappyApp(graph) }
        rule.waitFor(FlatRowTags.ROW)
    }

    /** The server refuses every send (a 503 each) until [online]. */
    private fun refuseSends() = synchronized(server) { repeat(100_000) { server.failSends += 503 } }

    private fun online() {
        synchronized(server) { server.failSends.clear() }
        server.acceptSockets = true
    }

    private fun send(text: String) {
        rule.waitFor(ComposerTags.INPUT)
        rule.node(ComposerTags.INPUT).performTextInput(text)
        rule.node(ComposerTags.PRIMARY).performClick()
    }

    @Test
    fun aDropQueuesSendsAndABacklogThatGoOutWhenTheServerIsBack() {
        openChat()
        rule.node(HomeTags.STATUS).assertDoesNotExist()

        // The socket goes and won't come back; home says so.
        server.acceptSockets = false
        server.dropSockets()
        rule.waitUntil(10_000) { graph.connectionStatus.value != ConnectionStatus.CONNECTED }
        rule.waitFor(HomeTags.STATUS)
        rule.assertActionsLabelled()

        // A message typed meanwhile waits, as does a backlog left from before.
        refuseSends()
        rule.node(FlatRowTags.ROW).performClick()
        rule.waitFor(ChatScreenTags.SCREEN)
        send("written on the train")
        rule.waitUntilAtLeastOneExists(hasTestTag(MessageTags.USER_STATUS) and hasText("Sending…"), 10_000)
        val cipher = server.encryption.dataKeyCipher(server.dataKey("s1"))
        val backlog = (1..150).map { "b%03d".format(it) }
        graph.store.enqueueOutbox(backlog.map { id ->
            OutboxRecord(
                localId = id, sessionId = "s1", kind = OutboxKind.USER, recordJson = "{}",
                content = cipher.encryptToBase64(MessageSender.userRecord(id, "android", SendOptions())),
                createdAt = System.currentTimeMillis(), state = OutboxState.QUEUED, attempts = 0, error = null, serverId = null, serverSeq = null,
            )
        })
        assertTrue(server.sentRecords("s1").isEmpty())

        // The server is back: everything goes out, oldest first, none refused for size.
        online()
        rule.waitUntil(20_000) { graph.connectionStatus.value == ConnectionStatus.CONNECTED }
        rule.waitUntil(20_000) { server.sentRecords("s1").size == 151 }
        val texts = server.sentRecords("s1").map { it.second["content"].toString() }
        assertTrue(texts.first(), "written on the train" in texts.first())
        assertEquals(backlog, server.sentRecords("s1").drop(1).map { it.first })
        rule.waitUntil(10_000) { graph.store.outbox("s1").none { it.state == OutboxState.QUEUED || it.state == OutboxState.SENDING } }
        assertTrue(graph.store.outbox("s1").none { it.state == OutboxState.FAILED })
        rule.waitUntil(10_000) { rule.onAllNodes(hasText("Sending…"), useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    }

    @Test
    fun leavingWithAMessageUnsentSchedulesMessageNotSent() {
        BackgroundSendNotifications.watch(context, journey.graph().also { graph = it }, scope)
        journey.machine()
        journey.session("s1", updatedAt = 100, title = "Flaky wifi")
        journey.signIn(graph)
        rule.setContent { HappyApp(graph) }
        rule.waitFor(FlatRowTags.ROW)
        rule.node(FlatRowTags.ROW).performClick()
        rule.waitFor(ChatScreenTags.SCREEN)
        val alarms = shadowOf(context.getSystemService(AlarmManager::class.java))
        val notifications = shadowOf(context.getSystemService(NotificationManager::class.java))

        refuseSends()
        send("sent while leaving")
        rule.waitFor(MessageTags.USER_STATUS)
        assertNull(alarms.nextScheduledAlarm)

        // Home pressed: the app is behind, the message still unsent.
        graph.setForeground(false)
        rule.waitUntil(5_000) { alarms.scheduledAlarms.isNotEmpty() }
        assertEquals(AlarmManager.ELAPSED_REALTIME_WAKEUP, alarms.scheduledAlarms.single().type)
        // Thirty seconds on, the alarm fires.
        BackgroundSendReceiver().onReceive(context, Intent())
        assertEquals("Message not sent", notifications.getNotification("background-send", 1).extras.getString("android.title"))

        // Back in front: the alarm goes, and the message goes out.
        graph.setForeground(true)
        rule.waitUntil(5_000) { alarms.nextScheduledAlarm == null }
        online()
        rule.waitUntil(10_000) { server.sentRecords("s1").isNotEmpty() }
        rule.waitUntil(10_000) { rule.onAllNodes(hasText("Sending…"), useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    }
}
