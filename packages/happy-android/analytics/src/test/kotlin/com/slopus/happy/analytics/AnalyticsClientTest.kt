package com.slopus.happy.analytics

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetSocketAddress
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.CoroutineContext

/** The send client: the envelope as posted, memory-only state, consent, the install id, opens, crashes and flags. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class AnalyticsClientTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val prefs = context.getSharedPreferences("analytics-test", Context.MODE_PRIVATE).also { it.edit().clear().commit() }

    private val posted = mutableListOf<JsonObject>()
    private val urls = mutableListOf<String>()
    private var status = 200
    private var flagsOn = """{"flags":{"direct-connection-migration-note":{"enabled":true},"other":{"enabled":false}}}"""
    private val http = OkHttpClient.Builder().addInterceptor { chain ->
        val url = chain.request().url.toString()
        synchronized(posted) {
            urls += url
            posted += Json.parseToJsonElement(Buffer().also { chain.request().body!!.writeTo(it) }.readUtf8()).jsonObject
        }
        val body = if ("/flags/" in url) flagsOn else "{\"status\":1}"
        Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(status).message("")
            .body(body.toResponseBody("application/json".toMediaType())).build()
    }.build()

    /** 01:00:00.734 on 2025-11-08: sent as whole seconds. */
    private var now = DAY * 20_400 + 3_600_000 + 734
    private val consent = MutableStateFlow<Boolean?>(true)
    private val foreground = MutableStateFlow(false)
    private var crash: AnalyticsEvent.AppCrashed? = null
    private var crashAsked = 0
    private val marks = mutableListOf<String?>()
    private val flags = mutableListOf<Set<String>>()

    private fun TestScope.client(
        asksFlags: Boolean = false,
        prefs: SharedPreferences = this@AnalyticsClientTest.prefs,
        posthog: PostHog = PostHog(http, "phc_test", "http://127.0.0.1:9"),
        lane: CoroutineContext = UnconfinedTestDispatcher(testScheduler),
    ) = AnalyticsClient(
        scope = backgroundScope,
        prefs = prefs,
        posthog = posthog,
        consent = consent,
        foreground = foreground,
        device = AnalyticsDevice(appVersion = "1.8.0", flavor = "standard", osVersion = "15", tablet = false),
        agent = { AnalyticsAgent(location = "remote", version = "0.40.1-preview.2") },
        configuration = { AnalyticsEvent.AppOpened.Configuration(notifications = Notifications.Granted, agentsConnected = Bucket.One) },
        crash = { crashAsked++; crash },
        mark = { marks += it },
        flags = if (asksFlags) ({ synchronized(flags) { flags += it } }) else null,
        clock = { now },
        lane = lane,
    ).also {
        it.start()
        runCurrent()
    }

    private fun batch(index: Int = posted.lastIndex) = posted[index]["batch"]!!.jsonArray.map { it.jsonObject }
    private fun names(index: Int = posted.lastIndex) = batch(index).map { it["event"]!!.jsonPrimitive.content }
    private fun JsonObject.distinctId() = this["properties"]!!.jsonObject["distinct_id"]!!.jsonPrimitive.content

    /** Waits for what goes on the IO pool, outside the test clock. */
    private suspend fun waitFor(done: () -> Boolean) =
        withContext(Dispatchers.Default) { withTimeout(5_000) { while (!synchronized(posted) { done() }) delay(10) } }

    @Test
    fun theEnvelopeIsOursAlone() = runTest {
        val client = client()
        client.errorShown(ErrorArea.MessageSend, ErrorCode.Timeout)
        client.record(AnalyticsEvent.MobilePairingFailed(PairingMethod.Direct, PairingStart.Scan, PairingError.Expired))
        client.flush()

        assertEquals(listOf("http://127.0.0.1:9/batch/"), urls)
        assertEquals(setOf("api_key", "batch"), posted.single().keys)
        assertEquals(JsonPrimitive("phc_test"), posted.single()["api_key"])
        val (error, pairing) = batch()
        assertEquals(setOf("event", "timestamp", "properties"), error.keys)
        assertEquals(JsonPrimitive("error_shown"), error["event"])
        assertEquals(JsonPrimitive("2025-11-08T01:00:00Z"), error["timestamp"])
        val properties = error["properties"]!!.jsonObject
        val common = mapOf(
            "client" to JsonPrimitive("android"),
            "app_version" to JsonPrimitive("1.8.0"),
            "flavor" to JsonPrimitive("standard"),
            "os" to JsonPrimitive("android"),
            "os_version" to JsonPrimitive("15"),
            "device_class" to JsonPrimitive("phone"),
            "agent_location" to JsonPrimitive("remote"),
            "agent_os" to JsonNull,
            // Numbers only: the agent's `-preview.2` is cut.
            "happy_agent_version" to JsonPrimitive("0.40.1"),
        )
        val own = mapOf("area" to JsonPrimitive("message_send"), "code" to JsonPrimitive("timeout"))
        val posthog = mapOf(
            "\$lib" to JsonPrimitive("happy-android"),
            "\$process_person_profile" to JsonPrimitive(false),
            "\$ip" to JsonNull,
            "\$geoip_disable" to JsonPrimitive(true),
        )
        assertEquals(common + own + posthog, properties - "distinct_id" - "\$insert_id")
        val distinct = properties["distinct_id"]!!.jsonPrimitive.content
        UUID.fromString(distinct)
        UUID.fromString(properties["\$insert_id"]!!.jsonPrimitive.content)
        val other = pairing["properties"]!!.jsonObject
        assertEquals(distinct, other["distinct_id"]!!.jsonPrimitive.content)
        assertNotEquals(properties["\$insert_id"], other["\$insert_id"])
        assertEquals(JsonPrimitive("scan"), other["start"])
        assertEquals(JsonPrimitive("expired"), other["error_code"])

        // Sent: nothing is left to send.
        client.flush()
        assertEquals(1, posted.size)
    }

    /** One conversation load seen failing twice at once (as it opens and on the resync after) is one event, with the most specific code. */
    @Test
    fun oneFailureSeenTwiceAtOnceIsOneErrorWithItsMostSpecificCode() = runTest {
        val client = client()
        val start = now
        fun at(millis: Long, area: ErrorArea, code: ErrorCode) {
            now = start + millis
            client.errorShown(area, code)
        }
        at(0, ErrorArea.ConversationLoad, ErrorCode.Offline)
        at(400, ErrorArea.ConversationLoad, ErrorCode.Unknown)
        at(1_000, ErrorArea.MessageSend, ErrorCode.Unknown)
        at(2_000, ErrorArea.MessageSend, ErrorCode.Timeout)
        at(3_000, ErrorArea.MessageSend, ErrorCode.Offline)
        at(20_000, ErrorArea.ConversationLoad, ErrorCode.Unknown)
        client.flush()
        assertEquals(
            listOf("conversation_load" to "offline", "message_send" to "timeout", "conversation_load" to "unknown"),
            batch().map { it["properties"]!!.jsonObject.let { p -> p["area"]!!.jsonPrimitive.content to p["code"]!!.jsonPrimitive.content } },
        )
    }

    @Test
    fun aMessageCarriesItsModelFamilyNeverTheModel() = runTest {
        val client = client()
        client.record(
            AnalyticsEvent.MessageSent(
                MessageSource.Chat, ChatTarget.Session, SessionClient.HappyAgent, "claude:anthropic/claude-opus-5-20261101",
                ProviderKind.Claude, Effort.entries.first(), taskDepth = null, hasAttachment = false, isSteering = true,
            ),
        )
        client.flush()
        val properties = batch().single()["properties"]!!.jsonObject
        assertEquals(JsonPrimitive("claude_opus"), properties["model_family"])
        assertNull(properties["model"])
        assertFalse(posted.single().toString().contains("anthropic/"))
    }

    @Test
    fun aFailedBatchGoesAgainWithTheSameIds() = runTest {
        val client = client()
        client.record(AnalyticsEvent.TaskCreated(null))
        status = 503
        client.flush()
        status = 200
        client.flush()
        assertEquals(2, posted.size)
        assertEquals(batch(0), batch(1))
        // A batch PostHog will never take is dropped rather than tried forever.
        client.record(AnalyticsEvent.TaskCreated(CreateError.Refused))
        status = 400
        client.flush()
        status = 200
        client.flush()
        assertEquals(3, posted.size)
    }

    @Test
    fun nothingButTheInstallIdIsKeptOnThePhone() = runTest {
        val client = client()
        client.errorShown(ErrorArea.ConversationLoad, ErrorCode.Offline)
        client.failureShown("m1", now - 1_000, AnalyticsEvent.ChatFailureShown(FailureKind.Network, null, isPool = false, ChatTarget.Session, SessionClient.Cli))
        status = 503
        client.flush()
        assertEquals(setOf("install_id"), prefs.all.keys)
        assertFalse(File(context.noBackupFilesDir, "analytics").exists())
    }

    @Test
    fun optingOutDeletesEverythingWithTheInstallIdAndOptingInMakesANewOne() = runTest {
        val client = client(asksFlags = true)
        client.record(AnalyticsEvent.TaskCreated(null))
        client.flush()
        val first = batch().single().distinctId()
        assertEquals(first, prefs.getString("install_id", null))

        status = 503
        client.record(AnalyticsEvent.TaskCreated(CreateError.Offline))
        client.flush()
        status = 200
        consent.value = false
        runCurrent()
        assertNull(prefs.getString("install_id", null))
        assertEquals(emptySet<String>(), prefs.all.keys)
        assertEquals(listOf("1.8.0", null), marks)
        assertEquals(listOf(emptySet<String>()), flags)
        // Off records nothing, and what waited is gone.
        client.record(AnalyticsEvent.TaskCreated(null))
        client.errorShown(ErrorArea.ConversationLoad, ErrorCode.Offline)
        client.flush()
        assertEquals(2, posted.size)

        consent.value = true
        runCurrent()
        // The throttle was forgotten with the rest: the same error goes again at once.
        client.errorShown(ErrorArea.ConversationLoad, ErrorCode.Offline)
        client.flush()
        assertEquals(listOf("error_shown"), names())
        val second = batch().single().distinctId()
        assertNotEquals(first, second)
        assertEquals(second, prefs.getString("install_id", null))
    }

    /**
     * Opting out while a batch is on its way: the request is cancelled, and
     * everything is deleted at once rather than after it. Analytics stays off
     * though [consent] hasn't caught up, until it is turned back on.
     */
    @Test
    fun anOptOutCancelsARequestOnItsWayAndDoesntWaitForIt() = runTest {
        val arrived = CountDownLatch(1)
        val release = CountDownLatch(1)
        val requests = AtomicInteger()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            executor = Executors.newCachedThreadPool()
            createContext("/batch/") { exchange ->
                requests.incrementAndGet()
                arrived.countDown()
                release.await(10, TimeUnit.SECONDS)
                exchange.sendResponseHeaders(200, -1)
                exchange.close()
            }
            start()
        }
        try {
            val client = client(asksFlags = true, posthog = PostHog(OkHttpClient(), "phc_test", "http://127.0.0.1:${server.address.port}"))
            client.record(AnalyticsEvent.TaskCreated(null))
            val sending = backgroundScope.launch(Dispatchers.Default) { client.flush() }
            withContext(Dispatchers.Default) { assertTrue(arrived.await(5, TimeUnit.SECONDS)) }

            client.revoke()
            assertNull("off before the request is answered", client.live())
            assertEquals("deleted before the request is answered", emptySet<String>(), prefs.all.keys)
            assertEquals(listOf("1.8.0", null), marks)
            assertEquals(listOf(emptySet<String>()), flags)
            waitFor { sending.isCompleted }

            // [consent] is still true, as the setting behind the opt-out may not have reached it: still off.
            runCurrent()
            assertNull(client.live())
            client.record(AnalyticsEvent.TaskCreated(CreateError.Offline))
            client.flush()
            assertEquals(1, requests.get())
            assertEquals(emptySet<String>(), prefs.all.keys)

            client.allow()
            runCurrent()
            assertNotNull(client.live())
        } finally {
            release.countDown()
            server.stop(0)
        }
    }

    /** Off and on again before the lane has run anything: nothing from before goes, and the new id is new. */
    @Test
    fun offAndOnBeforeTheLaneRunsStartsOverWithANewId() = runTest {
        val client = client(lane = StandardTestDispatcher(testScheduler))
        client.record(AnalyticsEvent.TaskCreated(null))
        runCurrent()
        val before = client.live()!!
        val first = prefs.getString("install_id", null)!!

        client.record(AnalyticsEvent.TaskCreated(CreateError.Offline))
        client.errorShown(ErrorArea.ConversationLoad, ErrorCode.Offline)
        client.failureShown("m1", now, AnalyticsEvent.ChatFailureShown(FailureKind.Network, null, isPool = false, ChatTarget.Session, SessionClient.Cli))
        client.revoke()
        client.record(AnalyticsEvent.TaskCreated(CreateError.Refused))
        client.allow()
        // Something lasting from before (a call) ends after.
        client.record(AnalyticsEvent.TaskCreated(CreateError.Unknown), before)
        runCurrent()

        client.record(AnalyticsEvent.ErrorShown(ErrorArea.MessageSend, ErrorCode.Timeout))
        runCurrent()
        client.flush()
        assertEquals(listOf("error_shown"), names())
        val second = batch().single().distinctId()
        assertNotEquals(first, second)
        assertEquals(second, prefs.getString("install_id", null))
    }

    /** Something lasting, such as a call: told only if analytics was on as it began and stayed on until it ended. */
    @Test
    fun aSpanBegunWhileOffOrRevokedSinceRecordsNothing() = runTest {
        consent.value = false
        val client = client()
        val begunOff = client.span()
        consent.value = true
        runCurrent()
        val revokedSince = client.span()
        client.revoke()
        client.allow()
        runCurrent()
        val whole = client.span()
        begunOff.record(AnalyticsEvent.VoiceSessionStopped(DurationBucket.of(1_000)))
        revokedSince.record(AnalyticsEvent.VoiceSessionError(VoiceError.Dropped, DurationBucket.of(1_000)))
        whole.record(AnalyticsEvent.VoiceSessionStopped(DurationBucket.of(90_000)))
        client.flush()
        assertEquals(listOf("voice_session_stopped"), names())
        assertEquals(1, posted.size)
    }

    /** An install id that can't be deleted keeps analytics off: nothing may go under the id of before. */
    @Test
    fun anInstallIdThatCantBeDeletedKeepsAnalyticsOff() = runTest {
        val stuck = Stuck(prefs)
        val client = client(prefs = stuck)
        client.record(AnalyticsEvent.TaskCreated(null))
        client.flush()
        val first = batch().single().distinctId()

        stuck.failing = true
        consent.value = false
        runCurrent()
        assertEquals(first, prefs.getString("install_id", null))
        consent.value = true
        runCurrent()
        assertNull(client.live())
        client.record(AnalyticsEvent.TaskCreated(null))
        client.flush()
        assertEquals(1, posted.size)

        // Deleting works again by the next time analytics would start: it deletes the id first.
        consent.value = false
        runCurrent()
        stuck.failing = false
        consent.value = true
        runCurrent()
        assertNull(prefs.getString("install_id", null))
        client.record(AnalyticsEvent.TaskCreated(null))
        client.flush()
        assertNotEquals(first, batch().single().distinctId())
    }

    /** Consent read as off, before its collector has run: nothing more is kept or sent. */
    @Test
    fun consentOffStopsEverythingBeforeItsCollectorRuns() = runTest {
        val client = client(lane = StandardTestDispatcher(testScheduler))
        client.record(AnalyticsEvent.TaskCreated(null))
        runCurrent()
        client.record(AnalyticsEvent.TaskCreated(CreateError.Offline))
        consent.value = false
        assertNull(client.live())
        client.record(AnalyticsEvent.TaskCreated(CreateError.Refused))
        client.errorShown(ErrorArea.ConversationLoad, ErrorCode.Offline)
        client.errorSeen("send:a", ErrorArea.MessageSend, ErrorCode.Timeout)
        client.flush()
        assertEquals(emptyList<String>(), urls)
    }

    /**
     * The account's switch off went through but the install id can't be
     * deleted: turning analytics back on is refused, so the setting stays
     * off, and a restart (a new client on the same prefs) stays off too and
     * never sends under that id. Once the id can go, it goes first.
     */
    @Test
    fun turningBackOnIsRefusedWhileTheLastIdCantBeDeleted() = runTest {
        val stuck = Stuck(prefs)
        val client = client(prefs = stuck)
        client.record(AnalyticsEvent.TaskCreated(null))
        client.flush()
        val first = batch().single().distinctId()

        stuck.failing = true
        client.revoke()
        consent.value = false
        runCurrent()
        assertEquals(first, prefs.getString("install_id", null))
        assertFalse(client.allow())
        val switchPrefs = context.getSharedPreferences("analytics-switch-refused", Context.MODE_PRIVATE).also { it.edit().clear().putBoolean("device_on", false).commit() }
        val switch = AnalyticsSwitch(switchPrefs).apply { onOn = client::allow }
        assertFalse("the device switch is refused too", switch.set(true))
        assertFalse(switch.on.value)
        assertFalse("and stays off written down", AnalyticsSwitch(switchPrefs).on.value)

        val restarted = client(prefs = stuck)
        assertNull(restarted.live())
        restarted.record(AnalyticsEvent.TaskCreated(CreateError.Offline))
        restarted.flush()
        assertFalse(restarted.allow())
        assertEquals(1, posted.size)

        stuck.failing = false
        assertTrue(restarted.allow())
        assertNull(prefs.getString("install_id", null))
        consent.value = true
        runCurrent()
        restarted.record(AnalyticsEvent.TaskCreated(null))
        restarted.flush()
        assertNotEquals(first, batch().single().distinctId())
    }

    /** A send's failed row: its error_shown the first time it is seen, not each time it comes back into view; forgotten with the rest on an opt-out. */
    @Test
    fun aFailureThatStaysOnScreenIsToldTheFirstTimeItIsSeen() = runTest {
        val client = client()
        client.errorSeen("send:a", ErrorArea.MessageSend, ErrorCode.Timeout)
        client.errorSeen("send:a", ErrorArea.MessageSend, ErrorCode.Timeout)
        now += 11 * 60_000
        client.errorSeen("send:a", ErrorArea.MessageSend, ErrorCode.Timeout)
        client.errorSeen("send:b", ErrorArea.MessageSend, ErrorCode.Refused)
        client.flush()
        assertEquals(
            listOf("timeout", "refused"),
            batch().map { it["properties"]!!.jsonObject["code"]!!.jsonPrimitive.content },
        )

        client.revoke()
        assertTrue(client.allow())
        runCurrent()
        client.errorSeen("send:a", ErrorArea.MessageSend, ErrorCode.Timeout)
        client.flush()
        assertEquals(listOf("error_shown"), names())

        val seen = SeenErrors()
        repeat(SeenErrors.MAX_SEEN + 1) { assertTrue(seen.first("k$it")) }
        assertTrue("the oldest goes first", seen.first("k0"))
        assertFalse(seen.first("k${SeenErrors.MAX_SEEN}"))
    }

    /** Prefs whose writes fail while [failing]. */
    private class Stuck(private val real: SharedPreferences) : SharedPreferences by real {
        var failing = false

        override fun edit(): SharedPreferences.Editor = if (!failing) real.edit() else object : SharedPreferences.Editor by real.edit() {
            override fun remove(key: String?) = this
            override fun putString(key: String?, value: String?) = this
            override fun commit() = false
            override fun apply() = Unit
        }
    }

    @Test
    fun nothingIsRecordedUntilTheAccountsHaveBeenRead() = runTest {
        consent.value = null
        foreground.value = true
        val client = client()
        client.record(AnalyticsEvent.TaskCreated(null))
        client.errorShown(ErrorArea.ConversationLoad, ErrorCode.Offline)
        assertEquals(emptyList<String?>(), marks)
        assertEquals("no crash read before consent", 0, crashAsked)
        consent.value = true
        runCurrent()
        client.flush()
        // Only the launch's own open goes; nothing from before is kept.
        assertEquals(listOf("app_opened"), names())
    }

    @Test
    fun aLaunchReadAsOptedOutTellsNothingLater() = runTest {
        consent.value = false
        foreground.value = true
        crash = AnalyticsEvent.AppCrashed(CrashProcess.App, CrashReason.Crash, "1.7.0")
        val client = client()
        consent.value = true
        runCurrent()
        client.flush()
        assertEquals("no crash, no cold start", emptyList<JsonObject>(), posted)
        assertEquals(0, crashAsked)
    }

    @Test
    fun optingBackInSendsAgainOnTheUsualBeat() = runTest {
        consent.value = false
        foreground.value = true
        val client = client()
        client.record(AnalyticsEvent.TaskCreated(CreateError.Unknown))
        advanceTimeBy(31_000)
        consent.value = true
        runCurrent()
        client.record(AnalyticsEvent.TaskCreated(null))
        advanceTimeBy(31_000)
        waitFor { posted.isNotEmpty() }
        assertEquals(listOf("task_created"), names(0))
        assertEquals(JsonPrimitive("ok"), batch(0).single()["properties"]!!.jsonObject["result"])
    }

    @Test
    fun anOpenCarriesTheSetupAndEachActionGoesAsItHappens() = runTest {
        val client = client()
        foreground.value = true
        runCurrent()
        client.record(AnalyticsEvent.TaskCreated(null))
        client.record(AnalyticsEvent.TaskCreated(CreateError.Offline))
        foreground.value = false
        runCurrent()
        // Back after half an hour: a warm open.
        now += 31 * 60_000
        foreground.value = true
        runCurrent()
        client.flush()
        val events = posted.flatMap { it["batch"]!!.jsonArray.map { e -> e.jsonObject } }
        assertEquals(listOf("app_opened", "task_created", "task_created", "app_opened"), events.map { it["event"]!!.jsonPrimitive.content })
        val own = events.first()["properties"]!!.jsonObject.filterKeys { it in AnalyticsSchema.events.getValue("app_opened") }
        assertEquals(
            mapOf("notifications" to JsonPrimitive("granted"), "agents_connected" to JsonPrimitive("1"), "is_cold_start" to JsonPrimitive(true)),
            own,
        )
        assertEquals(JsonPrimitive("offline"), events[2]["properties"]!!.jsonObject["error_code"])
        assertEquals(JsonPrimitive(false), events.last()["properties"]!!.jsonObject["is_cold_start"])
    }

    @Test
    fun aCrashIsToldAtTheNextStartWithTheVersionThatCrashed() = runTest {
        crash = AnalyticsEvent.AppCrashed(CrashProcess.App, CrashReason.NativeCrash, "1.7.9")
        val client = client()
        client.flush()
        val event = batch().single()
        assertEquals(JsonPrimitive("app_crashed"), event["event"])
        assertEquals(
            mapOf("process" to JsonPrimitive("app"), "reason" to JsonPrimitive("native_crash"), "crashed_version" to JsonPrimitive("1.7.9")),
            event["properties"]!!.jsonObject.filterKeys { it in setOf("process", "reason", "crashed_version") },
        )
        // Read once per launch, and this process marked as running with analytics on.
        consent.value = false
        runCurrent()
        consent.value = true
        runCurrent()
        assertEquals(1, crashAsked)
        assertEquals(listOf("1.8.0", null, "1.8.0"), marks)
    }

    @Test
    fun flagsAreAskedWithTheInstallIdOnlyWhileAnalyticsIsOn() = runTest {
        foreground.value = true
        consent.value = null
        client(asksFlags = true)
        assertEquals(emptyList<String>(), urls)
        consent.value = true
        runCurrent()
        waitFor { flags.isNotEmpty() }
        assertEquals(listOf(setOf("direct-connection-migration-note")), flags)
        fun asks() = synchronized(posted) { urls.indices.filter { "/flags/" in urls[it] } }
        val ask = posted[asks().single()]
        assertEquals("http://127.0.0.1:9/flags/?v=2", urls[asks().single()])
        assertEquals(setOf("api_key", "distinct_id"), ask.keys)
        assertEquals(prefs.getString("install_id", null), ask["distinct_id"]!!.jsonPrimitive.content)

        consent.value = false
        runCurrent()
        assertEquals(emptySet<String>(), flags.last())
        foreground.value = false
        runCurrent()
        foreground.value = true
        runCurrent()
        assertEquals("off asks nothing", 1, asks().size)
    }

    @Test
    fun anAnswerWithoutFlagsIsNothingOn() {
        assertEquals(emptySet<String>(), PostHog.parseFlags(Json.parseToJsonElement("""{"errorsWhileComputingFlags":true}""").jsonObject))
        assertEquals(
            setOf("direct-connection-migration-note"),
            PostHog.parseFlags(Json.parseToJsonElement(flagsOn).jsonObject),
        )
    }

    @Test
    fun aRedirectIsNeverFollowed() = runBlocking {
        val elsewhere = AtomicInteger()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/batch/") { exchange ->
                exchange.responseHeaders.add("Location", "/elsewhere/")
                exchange.sendResponseHeaders(307, -1)
                exchange.close()
            }
            createContext("/elsewhere/") { exchange ->
                elsewhere.incrementAndGet()
                exchange.sendResponseHeaders(200, -1)
                exchange.close()
            }
            start()
        }
        try {
            val posthog = PostHog(OkHttpClient(), "phc_test", "http://127.0.0.1:${server.address.port}")
            val event = QueuedEvent("task_created", now, JsonObject(mapOf("\$insert_id" to JsonPrimitive("e1"))))
            assertEquals(PostHog.Outcome.Failed, posthog.send(listOf(event)))
            assertEquals(0, elsewhere.get())
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun onlyAnHttpsHostOrThisMachineIsEverAsked() {
        assertTrue(PostHog.allowedHost(PostHog.HOST))
        assertTrue(PostHog.allowedHost("http://127.0.0.1:8787"))
        assertTrue(PostHog.allowedHost("http://localhost:8787/"))
        assertFalse(PostHog.allowedHost("http://us.i.posthog.com"))
        assertFalse(PostHog.allowedHost("http://10.0.2.2:8787"))
        assertFalse(PostHog.allowedHost("http://127.0.0.1.example.com"))
        assertFalse(PostHog.allowedHost("ftp://127.0.0.1"))
        assertTrue(AnalyticsTarget.isLoopback("http://127.0.0.1:8787"))
        assertFalse("a debug build sends only to this machine", AnalyticsTarget.isLoopback("https://us.i.posthog.com"))
        assertFalse(AnalyticsTarget.isLoopback("http://192.168.1.4:8787"))
    }

    @Test
    fun aTestRunSendsPostHogNothing() {
        assertNull(AnalyticsTarget.of(context, AnalyticsBuild(debug = false, buildType = "release", postHogKey = "phc_test", version = "1.8.0")))
    }

    @Test
    fun whatOlderBuildsKeptIsDeletedAndTheInstallIdStays() {
        val dir = File(context.noBackupFilesDir, "analytics").apply { mkdirs() }
        File(dir, "queue.json").writeText("[]")
        prefs.edit().putString("install_id", "kept").putInt("launch_count", 4).putString("daily_counts", "{}")
            .putLong("exits_checked_at", 1).putString("failures_seen", "[]").commit()
        Retired.delete(context, prefs)
        assertFalse(dir.exists())
        assertEquals(setOf("install_id"), prefs.all.keys)
    }

    @Test
    fun theSwitchIsOnForANewInstallAndOffWhenItCantBeRead() = runBlocking {
        val fresh = context.getSharedPreferences("analytics-switch-test", Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        assertTrue(AnalyticsSwitch(fresh).on.value)
        assertTrue(AnalyticsSwitch(fresh).set(false))
        assertFalse(AnalyticsSwitch(fresh).on.value)
        fresh.edit().clear().putString("device_on", "yes").commit()
        assertFalse(AnalyticsSwitch(fresh).on.value)
    }

    @Test
    fun theQueueKeepsTheNewest500ForAWeekInMemory() {
        val queue = AnalyticsQueue { now }
        fun event(i: Int, at: Long = now) = QueuedEvent("app_opened", at, JsonObject(mapOf("\$insert_id" to JsonPrimitive("e$i"))))
        queue.add(event(-1, at = now - AnalyticsQueue.MAX_AGE_MILLIS - 1))
        for (i in 0 until 501) queue.add(event(i))
        val kept = queue.pending()
        assertEquals(500, kept.size)
        assertEquals("e1", kept.first().insertId)
        assertEquals("e500", kept.last().insertId)
    }

    private companion object {
        const val DAY = 86_400_000L
    }
}
