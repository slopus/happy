package com.slopus.happy.journeys

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.test.core.app.ApplicationProvider
import com.slopus.happy.AppGraph
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.SecretKeyBackup
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.components.HeaderTags
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/**
 * What the journeys share: the real [AppGraph] and HappyApp on a
 * [FakeHappyServer], a daemon-like machine, and the fixtures a session needs
 * to be resumable, forkable and listed.
 */
internal class Journey(val server: FakeHappyServer = FakeHappyServer().start()) {
    private val graphs = mutableListOf<AppGraph>()

    fun graph(): AppGraph = AppGraph(
        context = ApplicationProvider.getApplicationContext(),
        clientId = "android/test",
        defaultServerUrl = server.url,
        secureStoreKeys = SoftwareKeys(),
        databaseName = null,
    ).also {
        graphs += it
        // MainActivity's onStart: the app is in front.
        it.setForeground(true)
    }

    /** Signs [graph] in to the fake's account with its secret key, as Restore does. */
    fun signIn(graph: AppGraph) = runBlocking {
        graph.auth.restore(SecretKeyBackup.format(encodeBase64(server.secret, Base64Variant.Url)))
    }

    fun close() {
        graphs.forEach { runBlocking { it.account.value?.stop() } }
        server.close()
    }

    /** A daemon's machine: online, with what resume and the new-session paths read. */
    fun machine(id: String = MACHINE, updatedAt: Long = 1) = server.addMachine(id, machineMetadata(), updatedAt)

    /** A Claude session on [MACHINE] in [path], resumable and forkable once inactive. */
    fun session(id: String, updatedAt: Long, path: String = "/h/repo", title: String = "Chat $id") = server.addSession(
        id,
        updatedAt = updatedAt,
        metadata = sessionMetadata(path, title, claudeSessionId = "claude-$id"),
    )

    private val stateVersions = mutableMapOf<String, Long>()
    private var envelopes = 0

    /**
     * The agent says [ev] in [turn], as the CLI's session protocol does
     * (the wrapped envelope, which also drives thinking), and the server
     * tells the app at once.
     */
    fun agent(sessionId: String, ev: JsonObject, turn: String = "t1", usage: JsonObject? = null) {
        val envelope = buildJsonObject {
            put("id", "env-${++envelopes}")
            put("time", System.currentTimeMillis())
            put("role", "agent")
            put("turn", turn)
            put("ev", ev)
            usage?.let { put("usage", it) }
        }
        val content = buildJsonObject {
            put("role", "agent")
            putJsonObject("content") { put("type", "session"); put("data", envelope) }
        }
        val message = server.appendMessage(sessionId, content)
        server.emitUpdate(server.newMessageBody(sessionId, message))
    }

    /** The session's agent state moves on to [state] (update-session, the next version). */
    fun agentState(sessionId: String, state: JsonObject) {
        val version = stateVersions.merge(sessionId, 1L, Long::plus)!!
        server.emitUpdate(buildJsonObject {
            put("t", "update-session")
            put("id", sessionId)
            putJsonObject("agentState") { put("version", version); put("value", server.seal(sessionId, state)) }
        })
    }

    /** Answers session or machine RPC [method] on [recordId] with [answer], keeping what was asked. */
    fun rpc(recordId: String, method: String, answer: (JsonObject) -> JsonElement): MutableList<JsonObject> {
        val calls = CopyOnWriteArrayList<JsonObject>()
        server.rpc["$recordId:$method"] = { params ->
            val opened = server.openRpc(recordId, params).jsonObject
            calls += opened
            server.sealRpc(recordId, answer(opened))
        }
        return calls
    }

    companion object {
        const val MACHINE = "m1"

        fun machineMetadata(): JsonObject = buildJsonObject {
            put("host", "devbox")
            put("platform", "linux")
            put("happyCliVersion", "1.2.3")
            put("happyHomeDir", "/h/.happy")
            put("homeDir", "/h")
            putJsonObject("resumeSupport") { put("rpcAvailable", true) }
        }

        fun sessionMetadata(path: String, title: String, claudeSessionId: String? = null, machineId: String = MACHINE) = buildJsonObject {
            put("path", path)
            put("host", "devbox")
            put("machineId", machineId)
            put("flavor", "claude")
            claudeSessionId?.let { put("claudeSessionId", it) }
            putJsonObject("summary") { put("text", title); put("updatedAt", 1) }
        }
    }
}

@OptIn(ExperimentalTestApi::class)
internal fun ComposeContentTestRule.waitFor(tag: String, timeoutMs: Long = 10_000) =
    waitUntilAtLeastOneExists(hasTestTag(tag), timeoutMs)

@OptIn(ExperimentalTestApi::class)
internal fun ComposeContentTestRule.waitForText(text: String, timeoutMs: Long = 10_000, substring: Boolean = false) =
    waitUntilAtLeastOneExists(hasText(text, substring = substring), timeoutMs)

/** The chat on screen is the one titled [title] (its header, not a tab or a row). */
internal fun ComposeContentTestRule.waitForChatTitle(title: String, timeoutMs: Long = 10_000) = waitUntil(timeoutMs) {
    onAllNodes(hasTestTag(HeaderTags.TITLE) and hasText(title), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
}

/** A 40×30 green PNG on the clipboard, as "Paste from Clipboard" reads it. */
internal fun copyImageToClipboard() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val file = File(context.cacheDir, "journey.png")
    file.outputStream().use { Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.GREEN) }.compress(Bitmap.CompressFormat.PNG, 100, it) }
    val clip = ClipData(ClipDescription("image", arrayOf("image/png")), ClipData.Item(Uri.fromFile(file)))
    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
}
