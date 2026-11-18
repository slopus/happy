package com.slopus.happy.call

import com.slopus.happy.call.CallTranscript.Kind
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.util.TimeZone

class MemoryTranscriptStore : CallTranscriptStore {
    var lines = ArrayList<String>()
    override fun replace(first: String) { lines = arrayListOf(first) }
    override fun append(line: String) { lines += line }
    override fun read() = lines.takeIf { it.isNotEmpty() }?.joinToString("\n")
}

/** The last call's exchange with the connection, for developer mode (iOS `CallTranscriptTests`). */
class CallTranscriptTest {
    private var clock = 1_700_000_000_000L
    private val events = CallEvents(activity = { _, _, _ -> }, disconnected = {}, hungUp = {}, tool = { CallToolResult("""{"ok":true}""") })

    /** Connects through the recorder, handing back what the connection was given. */
    private fun connect(transcript: CallTranscript, request: CallStart = CallStart("the context", "en", prompt = "the prompt")): Pair<CallConnection, CallEvents> = runBlocking {
        var given: CallEvents? = null
        val connection = transcript.record { _, _, events -> given = events; FakeCallConnection() }(CallGrant("g"), request, events)
        connection to given!!
    }

    /** Everything that goes to the connection and comes from it, in order, each at its time. */
    @Test
    fun everyKindIsRecordedInOrder() = runBlocking {
        val transcript = CallTranscript(MemoryTranscriptStore(), wallClock = { clock++ })
        val (connection, events) = connect(transcript)
        events.said("Hi, what's up?", 1)
        events.heard("what's new")
        val result = events.tool(CallToolCall("t1", "readConversation", buildJsonObject { put("ref", JsonPrimitive("s1")) }))
        assertEquals("""{"ok":true}""", result.text)
        connection.update("""{"event":"unfollowed","ref":"s4"}""")
        connection.cue("""{"event":"silence"}""")
        events.corrected("Hi", 1)
        events.disconnected()
        connection.end()
        val recording = transcript.read()!!
        assertEquals("en", recording.language)
        assertEquals(
            listOf(
                Kind.Prompt to "the prompt", Kind.Context to "the context", Kind.Agent to "Hi, what's up?", Kind.Person to "what's new",
                Kind.ToolCall to """{"ref":"s1"}""", Kind.ToolResult to """{"ok":true}""", Kind.Update to """{"event":"unfollowed","ref":"s4"}""",
                Kind.Cue to """[app] {"event":"silence"}""", Kind.Corrected to "Hi",
                Kind.Ended to "the connection dropped, or the provider ended it", Kind.Ended to "the app ended it",
            ),
            recording.entries.map { it.kind to it.text },
        )
        assertEquals(listOf("readConversation", "readConversation"), recording.entries.mapNotNull { it.name })
        assertEquals(recording.entries.map { it.at }.sorted(), recording.entries.map { it.at })
        assertEquals(recording.entries.last().at - recording.started, recording.duration)
        assertFalse(recording.truncated)
        val text = recording.text(TimeZone.getTimeZone("UTC"))
        assertTrue(text, text.startsWith("Last voice call, started 2023-11-14 22:13:20, 0:00 long, language en\n"))
        assertTrue(text, "22:13:20.005  tool call readConversation\n{\"ref\":\"s1\"}\n" in text)
    }

    /** Through a call: what [CallSession] sends goes through the one recorded connection. */
    @Test
    fun aCallsUpdatesAreRecorded() = runBlocking {
        val transcript = CallTranscript(MemoryTranscriptStore())
        val test = kotlinx.coroutines.test.TestScope()
        val call = CallSession(test, FakeGrants(CallGrantResult.Granted(CallGrant("g"))), { true }, now = { 0 },
            connect = transcript.record { _, _, _ -> FakeCallConnection() })
        call.start(null, { "first context" }, { CallToolResult("{}") })
        test.testScheduler.runCurrent()
        call.deliver(CallUpdate(listOf("""{"event":"focus"}""")))
        val entries = transcript.read()!!.entries
        assertEquals(Kind.Context to "first context", entries[1].kind to entries[1].text)
        assertEquals(Kind.Update to """{"event":"focus"}""", entries.last().kind to entries.last().text)
        call.stop()
    }

    /** A new call replaces the last; what the old one still says goes nowhere. */
    @Test
    fun aNewCallReplacesTheLast() = runBlocking {
        val transcript = CallTranscript(MemoryTranscriptStore())
        val (old, oldEvents) = connect(transcript, CallStart("first", prompt = "p"))
        oldEvents.heard("from the first call")
        connect(transcript, CallStart("second", prompt = "p"))
        oldEvents.heard("late")
        old.update("late update")
        val recording = transcript.read()!!
        assertNull(recording.language)
        assertEquals(listOf(Kind.Prompt to "p", Kind.Context to "second"), recording.entries.map { it.kind to it.text })
    }

    /** Kept on disk: the next launch reads it, after the writes asked for. */
    @Test
    fun itIsKeptAcrossLaunches() = runBlocking {
        val file = Files.createTempDirectory("transcript").resolve(CallTranscript.FILE).toFile()
        assertNull(CallTranscript(FileCallTranscriptStore(file)).read())
        val (connection, events) = connect(CallTranscript(FileCallTranscriptStore(file), wallClock = { clock++ }))
        events.heard("hello")
        connection.update("an update")
        val read = CallTranscript(FileCallTranscriptStore(file)).read()!!
        assertEquals(clock - 5, read.started)
        assertEquals(listOf(Kind.Prompt, Kind.Context, Kind.Person, Kind.Update), read.entries.map { it.kind })
        // A line a crash cut short is left out.
        file.appendText("{\"kind\":\"person\",\"at\":1")
        assertEquals(4, CallTranscript(FileCallTranscriptStore(file)).read()!!.entries.size)
    }

    /** Past its limit the rest isn't kept, once said so; how it ended still is. */
    @Test
    fun pastTheLimitItSaysItWasCut() = runBlocking {
        val store = MemoryTranscriptStore()
        val transcript = CallTranscript(store, limit = 1_000)
        val (connection, events) = connect(transcript)
        repeat(20) { connection.update("x".repeat(100)) }
        events.heard("too late")
        connection.end()
        val recording = transcript.read()!!
        assertTrue(recording.truncated)
        assertEquals(1, recording.entries.count { it.kind == Kind.Truncated })
        assertFalse(recording.entries.any { it.kind == Kind.Person })
        assertEquals(Kind.Ended, recording.entries.last().kind)
        assertTrue(store.lines.sumOf { it.length + 1 } < 1_400)
    }
}
