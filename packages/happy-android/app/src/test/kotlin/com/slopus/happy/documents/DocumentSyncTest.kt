package com.slopus.happy.documents

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.documents.yjs.YAwarenessState
import com.slopus.happy.documents.yjs.YDoc
import com.slopus.happy.documents.yjs.YID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.URLDecoder
import java.nio.file.Files
import java.util.Base64

/**
 * [DocumentSync] against a daemon that keeps documents as the real one does
 * (`SurfaceDocuments.change`): one Yjs replica, a change log with mutation
 * IDs, live frames to every subscribed stream (iOS's `DocumentSyncTests`).
 */
class DocumentSyncTest {
    private class Daemon(val surfaceId: String, base: ByteArray) : Transport {
        private val lock = Mutex()
        val doc = YDoc(1).also { it.applyUpdate(base) }
        @Volatile var seq = 0
        private val mutations = HashMap<String, Int>()
        val posted: MutableList<String> = java.util.Collections.synchronizedList(ArrayList())
        val presence: MutableList<ByteArray> = java.util.Collections.synchronizedList(ArrayList())
        val subscribed: MutableSet<String> = java.util.Collections.synchronizedSet(HashSet())
        @Volatile var online = true
        /** The next update is stored but its answer lost. */
        @Volatile var loseNextAnswer = false
        @Volatile var streams: DocumentStreams? = null

        suspend fun markdown(): String = lock.withLock { DocumentMarkdown.markdown(DocumentReader.blocks(doc)) }

        /** A change from desktop: applied and sent to every subscriber. */
        suspend fun remote(update: ByteArray) {
            lock.withLock {
                doc.applyUpdate(update)
                seq += 1
                broadcast(update, null)
            }
        }

        private fun broadcast(update: ByteArray, mutationId: String?) {
            val streams = streams ?: return
            if (subscribed.isEmpty()) return
            val frame = buildJsonObject {
                put("surfaceId", surfaceId); put("seq", seq); put("update", Base64.getEncoder().encodeToString(update))
                put("mutationId", mutationId?.let(::JsonPrimitive) ?: JsonNull)
                put("actor", buildJsonObject { put("userId", JsonNull); put("agentId", JsonNull) }); put("source", "api")
            }
            streams.frame("document.update", frame.toString())
        }

        override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse = lock.withLock {
            if (!online) throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
            val base = "/v0/surfaces/document/$surfaceId"
            val json = body?.let { AgentClient.json.parseToJsonElement(it.decodeToString()).jsonObject }
            fun answer(value: JsonObject) = TransportResponse(200, body = value.toString().toByteArray())
            val route = path.substringBefore('?')
            val query = path.substringAfter('?', "")
            when ("$method $route") {
                "GET $base/state" -> {
                    val raw = query.split("&").firstOrNull { it.startsWith("stateVector=") }?.removePrefix("stateVector=")
                    val since = raw?.let { YDoc.decodeStateVector(Base64.getDecoder().decode(URLDecoder.decode(it, "UTF-8"))) } ?: emptyMap()
                    answer(buildJsonObject {
                        put("seq", seq)
                        put("update", Base64.getEncoder().encodeToString(doc.encodeStateAsUpdate(since)))
                        put("stateVector", Base64.getEncoder().encodeToString(YDoc.encodeStateVector(doc.stateVector())))
                    })
                }
                "POST $base/updates" -> {
                    val id = json!!["mutationId"]!!.jsonPrimitive.content
                    posted += id
                    mutations[id]?.let { return@withLock answer(buildJsonObject { put("seq", it) }) }
                    val update = Base64.getDecoder().decode(json["update"]!!.jsonPrimitive.content)
                    val before = doc.stateVector()
                    doc.applyUpdate(update)
                    assertFalse("a change the daemon can't place", doc.hasPending)
                    if (doc.stateVector() != before || update.isNotEmpty()) {
                        seq += 1
                        mutations[id] = seq
                        broadcast(update, id)
                    }
                    if (loseNextAnswer) {
                        loseNextAnswer = false
                        throw AgentConnectionException(AgentConnectionException.Reason.Unavailable)
                    }
                    answer(buildJsonObject { put("seq", seq) })
                }
                "POST $base/subscribe" -> {
                    subscribed += json!!["streamId"]!!.jsonPrimitive.content
                    answer(buildJsonObject { put("seq", seq) })
                }
                "POST $base/unsubscribe" -> {
                    subscribed -= json!!["streamId"]!!.jsonPrimitive.content
                    answer(JsonObject(emptyMap()))
                }
                "POST $base/presence" -> {
                    presence += Base64.getDecoder().decode(json!!["update"]!!.jsonPrimitive.content)
                    answer(JsonObject(emptyMap()))
                }
                else -> TransportResponse(404, body = "{\"error\":\"Not found.\",\"code\":\"not_found\"}".toByteArray())
            }
        }

        override suspend fun close() {}
    }

    private lateinit var directory: File
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val base = DocumentFixtures.fixture("desktop-short")
    private val surfaceId = "doc1"

    @Before
    fun setUp() {
        directory = Files.createTempDirectory("document-sync").toFile()
    }

    @After
    fun tearDown() {
        scope.cancel()
        directory.deleteRecursively()
    }

    private fun hello(id: String) = buildJsonObject { put("streamId", id) }

    private fun library(client: AgentClient) = DocumentLibrary(client, directory, scope)

    /** An editor wired to its sync as the screen wires them. */
    private suspend fun attach(sync: DocumentSync): DocumentEditor {
        val editor = sync.editor()
        assertNotNull(editor)
        editor!!.onLocalUpdate = { sync.local(it) }
        return editor
    }

    private suspend fun eventually(timeout: Long = 5_000, condition: suspend () -> Boolean): Boolean {
        val end = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < end) {
            if (condition()) return true
            delay(10)
        }
        return condition()
    }

    private fun type(editor: DocumentEditor, text: String, line: Int = 1) {
        for (character in text) {
            val block = editor.lines[line].block
            editor.setRuns(block.id, listOf(DocumentRun(block.plainText + character)))
        }
    }

    private suspend fun <T : Any> ReceiveChannel<DocumentSyncEvent>.first(pick: (DocumentSyncEvent) -> T?): T = withTimeout(5_000) {
        var found: T? = null
        while (found == null) found = pick(receive())
        found
    }

    @Test
    fun typingGoesOutInBatchesAndEndsSaved() = runBlocking {
        val daemon = Daemon(surfaceId, base)
        val library = library(AgentClient(daemon, "t"))
        daemon.streams = library.streams
        library.opened(hello("s1"))
        val sync = library.document(surfaceId)
        assertEquals(DocumentOpening.Ready, sync.start())
        val editor = attach(sync)
        assertTrue(eventually { "s1" in daemon.subscribed })
        type(editor, " and more words typed quickly")
        val expected = DocumentMarkdown.markdown(editor.blocks)
        assertTrue(eventually { sync.saveState() == DocumentSaveState.Saved && daemon.markdown() == expected })
        assertTrue("29 keystrokes, a few batches at most 200 ms apart", sync.posts < 10)
        assertEquals("every batch its own mutation", daemon.posted.size, daemon.posted.toSet().size)
    }

    @Test
    fun remoteChangesReachTheEditorOnce() = runBlocking {
        val daemon = Daemon(surfaceId, base)
        val library = library(AgentClient(daemon, "t"))
        daemon.streams = library.streams
        library.opened(hello("s1"))
        val sync = library.document(surfaceId)
        sync.start()
        val events = sync.events()
        val editor = attach(sync)
        eventually { "s1" in daemon.subscribed }
        // Desktop types at the start of the second line.
        val desktop = DocumentEditor(YDoc(4040).also { it.applyUpdate(base) })
        var sent = ByteArray(0)
        desktop.onLocalUpdate = { sent = it }
        desktop.setRuns(desktop.lines[1].id, listOf(DocumentRun("Desktop: " + desktop.lines[1].block.plainText)))
        daemon.remote(sent)
        val remote = events.first { (it as? DocumentSyncEvent.Remote)?.update }
        assertTrue(remote.contentEquals(sent))
        editor.applyRemote(remote)
        assertTrue(editor.lines[1].block.plainText.startsWith("Desktop: "))
    }

    @Test
    fun offlineEditsSurviveARelaunchAndGoOutOnceOnReconnect() = runBlocking {
        val daemon = Daemon(surfaceId, base)
        val client = AgentClient(daemon, "t")
        var library = library(client)
        daemon.streams = library.streams
        library.opened(hello("s1"))
        var sync = library.document(surfaceId)
        sync.start()
        var editor = attach(sync)
        eventually { "s1" in daemon.subscribed }
        // Airplane mode.
        daemon.online = false
        library.closed()
        type(editor, " offline")
        assertTrue("a keystroke reaches the disk a moment after it is typed", eventually { sync.saveState() == DocumentSaveState.Waiting && sync.kept == 8 })
        val expected = DocumentMarkdown.markdown(editor.blocks)
        // Killed: nothing shut down, a new library over the same folder.
        library = library(client)
        daemon.streams = library.streams
        sync = library.document(surfaceId)
        sync.start()
        editor = attach(sync)
        assertEquals("opens from disk with the offline edit", expected, DocumentMarkdown.markdown(editor.blocks))
        assertEquals(DocumentSaveState.Waiting, sync.saveState())
        // Back online; the first answer is lost after the daemon stored it.
        daemon.online = true
        daemon.loseNextAnswer = true
        library.opened(hello("s2"))
        assertTrue(eventually { sync.saveState() == DocumentSaveState.Saved })
        assertEquals(expected, daemon.markdown())
        assertEquals("sent, answer lost, sent again", 2, daemon.posted.size)
        assertEquals("under the same mutation ID", 1, daemon.posted.toSet().size)
        assertEquals("stored once", 1, daemon.seq)
    }

    @Test
    fun anUnsentDocumentNoEditorHoldsIsSentWhenTheStreamReturns() = runBlocking {
        val daemon = Daemon(surfaceId, base)
        val client = AgentClient(daemon, "t")
        var library = library(client)
        val sync = library.document(surfaceId)
        sync.start()
        val editor = attach(sync)
        type(editor, "!")
        eventually { sync.saveState() == DocumentSaveState.Waiting }
        sync.release()
        val expected = DocumentMarkdown.markdown(editor.blocks)
        library = library(client)
        daemon.streams = library.streams
        library.opened(hello("s3"))
        assertTrue(eventually { daemon.markdown() == expected })
        assertTrue("let go of once saved", eventually { library.open.isEmpty() })
    }

    @Test
    fun presenceGoesOutSpacedAndPeersComeIn() = runBlocking {
        val daemon = Daemon(surfaceId, base)
        val library = library(AgentClient(daemon, "t"))
        library.opened(hello("s1"))
        val sync = library.document(surfaceId)
        sync.start()
        val events = sync.events()
        val editor = attach(sync)
        eventually { "s1" in daemon.subscribed }
        val caret = editor.relativePosition(DocumentCaret(editor.lines[1].id, 2))!!
        for (name in listOf("a", "b", "c", "d")) sync.presence(DocumentPeer.state(name, "#123456", caret, caret))
        assertTrue(eventually {
            val last = daemon.presence.lastOrNull()?.let { runCatching { YAwarenessState.decode(it) }.getOrNull() }
            last?.firstOrNull()?.state?.get("user")?.get("name")?.stringValue == "d"
        })
        assertTrue("coalesced to the spacing", daemon.presence.size <= 2)

        val fixture = DocumentFixtures.presence
        val frame = buildJsonObject {
            put("surfaceId", surfaceId); put("clientKey", "k1"); put("revision", 1); put("active", true)
            put("awarenessClientId", 31337); put("update", fixture["update"]!!.jsonPrimitive.content)
        }
        library.frame("document.presence", frame.toString())
        var peers = events.first { (it as? DocumentSyncEvent.Peers)?.peers }
        assertEquals(listOf("Steve"), peers.map { it.name })
        assertEquals("#ff6b6b", peers.first().color)
        assertEquals(YID(4242, 6), peers.first().anchor?.item)
        // Gone: an inactive frame with a newer revision.
        val leave = buildJsonObject { put("surfaceId", surfaceId); put("clientKey", "k1"); put("revision", 2); put("active", false) }
        library.frame("document.presence", leave.toString())
        peers = events.first { (it as? DocumentSyncEvent.Peers)?.peers }
        assertEquals(emptyList<DocumentPeer>(), peers)
    }

    @Test
    fun aRefusedChangeCatchesUpOnceThenTakesTheComputersCopy() = runBlocking {
        val daemon = object : Transport {
            val inner = Daemon(surfaceId, base)
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory): TransportResponse =
                if (method == "POST" && path.endsWith("/updates")) {
                    inner.posted += "refused"
                    TransportResponse(400, body = "{\"error\":\"Not that.\",\"code\":\"invalid_request\"}".toByteArray())
                } else {
                    inner.request(method, path, credential, body, headers, category)
                }
            override suspend fun close() {}
        }
        val library = library(AgentClient(daemon, "t"))
        daemon.inner.streams = library.streams
        library.opened(hello("s1"))
        val sync = library.document(surfaceId)
        sync.start()
        val events = sync.events()
        val editor = attach(sync)
        eventually { "s1" in daemon.inner.subscribed }
        type(editor, "?")
        val reset = events.first { (it as? DocumentSyncEvent.Reset)?.editor }
        assertEquals("the computer's copy, without the refused change", daemon.inner.markdown(), DocumentMarkdown.markdown(reset.blocks))
        assertEquals("Not that.", events.first { (it as? DocumentSyncEvent.Notice)?.text })
        assertTrue("asked twice, then gave up", daemon.inner.posted.size >= 2)
    }
}
