package com.slopus.happy.guest

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The guest chat end to end against a local bridge (happy-ios
 * GuestLiveUITests, without a live bridge): name, join, the chat, a send,
 * a restart that skips the name, and Leave wiping the session.
 */
class GuestChatTest {
    private val link = "https://app.happy.engineering/bot/invite/abcdefghijklmnop"
    private val main = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + main)
    private val server = MockWebServer()
    private val storage = GuestSessionVaultTest.MemoryStorage()
    private val vault = GuestSessionVault(storage)
    private val requests = CopyOnWriteArrayList<String>()
    @Volatile private var full = false

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                requests += "${request.method} $path"
                return when {
                    full -> MockResponse.Builder().code(410).body("""{"code":"invite_full"}""").build()
                    path == "/v1/bot-invites/redeem" -> MockResponse.Builder().body(GuestClientTest.SESSION).build()
                    request.method == "GET" && request.url.queryParameter("after") == null ->
                        MockResponse.Builder().body("""{"messages":[{"id":"m1","role":"assistant","text":"Hello Ada","createdAt":1}],"cursor":"1","status":"online"}""").build()
                    request.method == "GET" -> MockResponse.Builder().body("""{"messages":[],"cursor":"1","status":"online"}""").headersDelay(200, TimeUnit.MILLISECONDS).build()
                    else -> MockResponse.Builder().code(204).build()
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        scope.cancel()
        server.close()
        main.close()
    }

    private fun chat() = GuestChat(vault, scope, apiOrigin = { server.url("/").toString().trimEnd('/') })

    private suspend fun GuestChat.until(test: (GuestChatState) -> Boolean) = withTimeout(10_000) { state.first(test) }

    @Test
    fun aGuestNamesThemselvesJoinsChatsAndLeaves() = runBlocking {
        val chat = chat()
        withContext(main) { chat.open(link) }
        chat.until { it.naming && it.status == GuestStatus.EnterName }
        withContext(main) { chat.join("<Ada>") }
        assertEquals(GuestStatus.NameInvalid, chat.state.value.status)
        withContext(main) { chat.join("  Ada  ") }
        val live = chat.until { it.status == GuestStatus.Live }
        assertEquals("Helper", live.botName)
        assertEquals("Ada Lovelace", live.displayName)
        assertEquals(listOf(GuestLine("m1", GuestSender.Bot("Helper"), "Hello Ada")), live.lines)
        assertFalse(live.naming)
        withContext(main) { chat.send("  Hi there ") }
        chat.until { !it.sending && it.draft.isEmpty() && !it.pending }
        assertTrue("POST /v1/bot-guest/sessions/s_1/messages" in requests)

        // Opened again (a new screen, a new process): the kept session, no name asked.
        val again = chat()
        withContext(main) { again.open(link) }
        again.until { it.joined && it.botName == "Helper" }
        assertEquals(1, requests.count { it == "POST /v1/bot-invites/redeem" })

        withContext(main) { chat.leave() }
        val left = chat.until { it.status == GuestStatus.Left }
        assertTrue(left.ended)
        assertTrue("POST /v1/bot-guest/sessions/s_1/block" in requests)
        // The session is wiped just after the screen says so.
        withTimeout(5_000) { while (storage.value != null) kotlinx.coroutines.delay(20) }
        assertNull(storage.value)
    }

    @Test
    fun aFullInviteEndsWithoutKeepingAnything() = runBlocking {
        full = true
        val chat = chat()
        withContext(main) { chat.open(link) }
        chat.until { it.naming }
        withContext(main) { chat.join("Ada") }
        val ended = chat.until { it.status == GuestStatus.InviteFull }
        assertTrue(ended.ended)
        assertFalse(ended.naming)
        withTimeout(5_000) { while (storage.value != null) kotlinx.coroutines.delay(20) }
        assertNull(storage.value)
    }

    @Test
    fun aLinkThatIsNotAnInvitationSaysSo() = runBlocking {
        val chat = chat()
        withContext(main) { chat.open("https://app.happy.engineering/bot/invite/short") }
        assertEquals(GuestStatus.Invalid, chat.state.value.status)
        assertTrue(chat.state.value.ended)
    }
}
