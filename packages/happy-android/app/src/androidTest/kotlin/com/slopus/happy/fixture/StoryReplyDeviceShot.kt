package com.slopus.happy.fixture

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.agent.AgentPictures
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.conversation.AgentRequest
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.ConversationApi
import com.slopus.happy.ui.connection.LocalAgentPictures
import com.slopus.happy.ui.conversation.ConversationRowTags
import com.slopus.happy.ui.conversation.ConversationScreen
import com.slopus.happy.ui.conversation.ConversationScreenActions
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.emptyFlow
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * A person's reply to the bot's story on a device, over a made-up agent
 * that exists only in this test's memory: the real Conversation and
 * ConversationScreen draw the quote (the story's first frame, "Story", the
 * bot's name and the caption) over the reply. The shot goes to the app's
 * external files under `story-reply/`. Run on an assigned emulator.
 */
@RunWith(AndroidJUnit4::class)
class StoryReplyDeviceShot {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val dir = File(instrumentation.targetContext.getExternalFilesDir(null), "story-reply").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After fun stop() = scope.cancel()

    /** The story's first frame: a 9:16 sunset over a hill. */
    private val frame: ByteArray by lazy {
        val bitmap = Bitmap.createBitmap(180, 320, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawPaint(Paint().apply { shader = LinearGradient(0f, 0f, 0f, 320f, intArrayOf(0xFFFF9500.toInt(), 0xFFFF2D55.toInt(), 0xFFAF52DE.toInt()), null, Shader.TileMode.CLAMP) })
        canvas.drawCircle(90f, 150f, 30f, Paint().apply { color = 0xFFFFCC00.toInt() })
        canvas.drawOval(-80f, 200f, 260f, 460f, Paint().apply { color = Color.argb(220, 26, 26, 26) })
        ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    private val request: AgentRequest = { _, path, _, _ ->
        when (path.substringBefore('?')) {
            "/v0/agents/$AGENT/bootstrap" -> json(BOOTSTRAP)
            "/v0/agents/$AGENT/messages" -> json(PAGE)
            "/v0/agents/$AGENT/messages/reply/story-frame" -> TransportResponse(200, mapOf("content-type" to "image/png"), frame)
            else -> TransportResponse(404, body = """{"error":"not in the fixture","code":"not_found"}""".toByteArray())
        }
    }

    private fun json(body: String) = TransportResponse(200, mapOf("content-type" to "application/json"), body.toByteArray())

    @Test fun storyReply() {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            HappyTheme {
                val conversation = remember { Conversation(ConversationApi(request), emptyFlow(), scope, AGENT).also { it.start() } }
                val pictures = remember { AgentPictures("fixture") { path -> request("GET", path, null, com.slopus.happy.connection.RequestCategory.File).body } }
                val state by conversation.state.collectAsStateWithLifecycle()
                CompositionLocalProvider(LocalAgentPictures provides pictures) {
                    ConversationScreen(state = state, connection = null, actions = remember { ConversationScreenActions(onBack = {}, onVisible = conversation::setVisible) })
                }
            }
        }
        rule.waitUntil(15_000) { rule.onAllNodesWithTag(ConversationRowTags.STORY, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.waitForIdle()
        SystemClock.sleep(1_500)
        device.takeScreenshot(File(dir, "android-story-reply.png"))
    }

    private companion object {
        const val AGENT = "fx-scout"
        const val BOOTSTRAP = """{"agent":{"id":"$AGENT","workspaceId":"fx-w","status":"idle","title":"Scout","pendingQuestionId":null},"draft":{"value":null,"updatedAt":null},"pending":[]}"""
        const val PAGE = """{"hasMore":false,"runs":[{"id":"r1","status":"completed","startedAt":1,"endedAt":2,"reason":"completed","messages":[
            {"id":"reply","role":"user","createdAt":1762000000000,"content":[{"type":"text","text":"This looks so much cleaner! Did the drop-off improve?"}],"metadata":{},
             "quote":{"kind":"story","storyId":"s1","agentId":"$AGENT","userId":null,"caption":"Shipped the new onboarding today","expiresAt":0,"frame":{"mimeType":"image/png"}}},
            {"id":"answer","role":"agent","createdAt":1762000001000,"content":[{"type":"text","text":"It did: completion went from 61% to 78% in the first day."}],"metadata":{}}]}]}"""
    }
}
