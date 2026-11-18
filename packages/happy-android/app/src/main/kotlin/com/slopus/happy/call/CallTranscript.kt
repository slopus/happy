package com.slopus.happy.call

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors

/**
 * Everything the last call exchanged with the voice connection, in order
 * (iOS `CallTranscript`), for developer mode's "Last voice call transcript":
 * the prompt and context it started with, every contextual update and cue
 * as sent, each tool call with its result, and the words both sides said.
 * Recorded at the connection itself ([record]), so nothing that goes to it
 * or comes from it is missed. Only the last call is kept, on this phone:
 * a new one replaces it, and past [limit] bytes the rest isn't kept, and
 * the transcript says so. Never logged, uploaded or counted. Main thread.
 */
class CallTranscript(
    private val store: CallTranscriptStore,
    private val wallClock: () -> Long = System::currentTimeMillis,
    private val limit: Int = LIMIT_BYTES,
) {
    @Serializable
    enum class Kind(val label: String) {
        @SerialName("prompt") Prompt("system prompt sent"),
        @SerialName("context") Context("context sent"),
        @SerialName("update") Update("update"),
        /** The app's own turn for the agent ([CallCue]). */
        @SerialName("cue") Cue("app cue"),
        @SerialName("toolCall") ToolCall("tool call"),
        @SerialName("toolResult") ToolResult("tool result"),
        @SerialName("agent") Agent("agent said"),
        /** The agent's words as they were heard: the person cut in. */
        @SerialName("corrected") Corrected("agent said, as heard"),
        @SerialName("person") Person("you said"),
        @SerialName("ended") Ended("ended"),
        @SerialName("truncated") Truncated("truncated"),
    }

    /** One thing sent or received; [name] is a tool's. Times are wall-clock millis. */
    @Serializable
    data class Entry(val kind: Kind, val at: Long, val text: String, val name: String? = null, val isError: Boolean = false) {
        /** Its local time and what it is. */
        fun heading(zone: TimeZone = TimeZone.getDefault()): String =
            "${format("HH:mm:ss.SSS", at, zone)}  ${kind.label}" + name?.let { " $it" }.orEmpty() + if (isError) " (error)" else ""
    }

    @Serializable
    private data class Header(val format: Int, val started: Long, val language: String? = null)

    /** The last call as kept. */
    data class Recording(val started: Long, val language: String?, val entries: List<Entry>) {
        val truncated: Boolean get() = entries.any { it.kind == Kind.Truncated }
        val duration: Long get() = maxOf(0L, (entries.lastOrNull()?.at ?: started) - started)

        /** All of it as plain text, times local, for copying elsewhere. */
        fun text(zone: TimeZone = TimeZone.getDefault()): String = buildString {
            append("Last voice call, started ").append(format("yyyy-MM-dd HH:mm:ss", started, zone))
            append(", ").append(CallController.clock(duration / 1000)).append(" long")
            language?.let { append(", language ").append(it) }
            append('\n')
            for (entry in entries) append('\n').append(entry.heading(zone)).append('\n').append(entry.text).append('\n')
        }
    }

    /** This call's number: what an earlier call still says after it is let go. */
    private var call = 0
    private var bytes = 0L
    private var truncated = false

    /** [connect], with everything that goes to the connection and comes from it recorded as this call's. */
    fun record(connect: suspend (CallGrant, CallStart, CallEvents) -> CallConnection): suspend (CallGrant, CallStart, CallEvents) -> CallConnection =
        { grant, request, events ->
            val current = began(request)
            fun add(kind: Kind, text: String, name: String? = null, isError: Boolean = false) {
                if (current == call) keep(Entry(kind, wallClock(), text, name, isError))
            }
            val recorded = CallEvents(
                activity = events.activity,
                disconnected = { add(Kind.Ended, "the connection dropped, or the provider ended it"); events.disconnected() },
                hungUp = { add(Kind.Ended, "hung up"); events.hungUp() },
                tool = { call ->
                    add(Kind.ToolCall, call.parameters.toString(), call.name)
                    events.tool(call).also { add(Kind.ToolResult, it.text, call.name, it.isError) }
                },
                heard = { text -> add(Kind.Person, text); events.heard(text) },
                said = { text, event -> add(Kind.Agent, text); events.said(text, event) },
                corrected = { text, event -> add(Kind.Corrected, text); events.corrected(text, event) },
            )
            val connection = connect(grant, request, recorded)
            object : CallConnection {
                override suspend fun end() {
                    add(Kind.Ended, "the app ended it")
                    connection.end()
                }
                override suspend fun setMuted(muted: Boolean) = connection.setMuted(muted)
                override fun update(context: String) {
                    add(Kind.Update, context)
                    connection.update(context)
                }
                override fun cue(facts: String) {
                    add(Kind.Cue, CallCue.MARK + facts)
                    connection.cue(facts)
                }
            }
        }

    /** A new call: the last one's transcript goes, and this one starts with what it was started with. */
    private fun began(request: CallStart): Int {
        call += 1
        val header = JSON.encodeToString(Header.serializer(), Header(FORMAT, wallClock(), request.language))
        bytes = header.utf8Size() + 1L
        truncated = false
        store.replace(header)
        keep(Entry(Kind.Prompt, wallClock(), request.prompt))
        keep(Entry(Kind.Context, wallClock(), request.context))
        return call
    }

    /** Past [limit], only how the call ended is kept, after a line saying the rest wasn't. */
    private fun keep(entry: Entry) {
        val line = JSON.encodeToString(Entry.serializer(), entry)
        val size = line.utf8Size() + 1L
        if ((truncated || bytes + size > limit) && entry.kind != Kind.Ended) {
            if (truncated) return
            truncated = true
            val note = Entry(Kind.Truncated, entry.at, "The rest of the call isn't kept: its transcript reached ${limit / 1024 / 1024} MB.")
            store.append(JSON.encodeToString(Entry.serializer(), note))
            return
        }
        bytes += size
        store.append(line)
    }

    /** The last call, or null before there was one; off the main thread. */
    fun read(): Recording? {
        val lines = store.read()?.lineSequence()?.filter { it.isNotBlank() }?.toList() ?: return null
        val header = lines.firstOrNull()?.let { runCatching { JSON.decodeFromString(Header.serializer(), it) }.getOrNull() }
        if (header?.format != FORMAT) return null
        // A line a crash cut short is left out.
        val entries = lines.drop(1).mapNotNull { runCatching { JSON.decodeFromString(Entry.serializer(), it) }.getOrNull() }
        return Recording(header.started, header.language, entries)
    }

    companion object {
        /** The most of one call kept: an hour of updates fits. */
        const val LIMIT_BYTES = 4 * 1024 * 1024
        /** The file, under `noBackupFilesDir`: never backed up. */
        const val FILE = "call-transcript.jsonl"
        private const val FORMAT = 1
        private val JSON = Json { ignoreUnknownKeys = true; encodeDefaults = false }

        private fun format(pattern: String, at: Long, zone: TimeZone): String =
            SimpleDateFormat(pattern, Locale.US).apply { timeZone = zone }.format(Date(at))
    }
}

/** Where the last call's transcript is kept: one file of lines, replaced whole, then added to. */
interface CallTranscriptStore {
    fun replace(first: String)
    fun append(line: String)
    fun read(): String?
}

/**
 * The transcript in [file], under `noBackupFilesDir`. Writes go one after
 * another off the main thread; a read waits for them.
 */
class FileCallTranscriptStore(private val file: File) : CallTranscriptStore {
    override fun replace(first: String) = write { file.writeText(first + "\n") }
    override fun append(line: String) = write { file.appendText(line + "\n") }
    override fun read(): String? = WRITES.submit<String?> { runCatching { file.takeIf { it.isFile }?.readText() }.getOrNull() }.get()

    private fun write(change: () -> Unit) {
        WRITES.execute {
            runCatching {
                file.parentFile?.mkdirs()
                change()
            }
        }
    }

    companion object {
        private val WRITES = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "call-transcript").apply { isDaemon = true } }
    }
}
