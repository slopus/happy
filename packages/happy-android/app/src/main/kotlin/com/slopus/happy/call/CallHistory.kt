package com.slopus.happy.call

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.util.concurrent.Executors

/** How a call ended, as the next call's recap says it (iOS `CallEnding`). Only a call that went live has one. */
@Serializable
enum class CallEnding(val said: String) {
    /** The person tapped End, or the call went with its connection. */
    @SerialName("hungUp") HungUp("the person ended the call"),
    /** The agent hung up (its `end_call`). */
    @SerialName("agentHungUp") AgentHungUp("you ended the call"),
    /** The person agreed to a fresh call, this one carried over (`happy://call/restart`). */
    @SerialName("restarted") Restarted("the call restarted, carried over"),
    /** It dropped, or the provider ended it unasked. */
    @SerialName("dropped") Dropped("the call dropped (connection lost)"),
    /** One call can run an hour ([CallCues.Timing.callLimit]). */
    @SerialName("callLimit") CallLimit("the call reached its one-hour limit and ended"),
    /** The device's voice time ran out ([CallAllowance]). */
    @SerialName("timeUsed") TimeUsed("the call ended: the person's voice time ran out"),
    /** Nobody spoke for a while ([CallCues.Timing.silenceEnd]). */
    @SerialName("silence") Silence("the call ended after a long silence"),
    /** The phone took the audio (another call) and the call had to be made again. Said as iOS's says it: change both or neither. */
    @SerialName("interrupted") Interrupted("the call was cut off: the phone took the audio (another call)"),
    /** The app left the screen: only a call the background service couldn't keep ends there now. */
    @SerialName("background") Background("the call ended when the app left the screen");

    /** An end the person didn't ask for and may not have heard coming: the drop sound plays for these. */
    val isUnexpected: Boolean get() = this == Dropped || this == CallLimit || this == TimeUsed || this == Silence

    /** The person or the agent ended it as asked: worth a line only after words. */
    internal val isPlain: Boolean get() = this == HungUp || this == AgentHungUp || this == Background
}

/** One slot of what calls said: the person's words, the agent's, or how a call ended. Times are wall-clock millis. */
@Serializable
data class CallSlot(val kind: Kind, val text: String? = null, val ending: CallEnding? = null, val at: Long) {
    @Serializable
    enum class Kind {
        @SerialName("person") Person,
        @SerialName("assistant") Assistant,
        @SerialName("ended") Ended,
    }

    companion object {
        fun person(text: String, at: Long) = CallSlot(Kind.Person, text = text, at = at)
        fun assistant(text: String, at: Long) = CallSlot(Kind.Assistant, text = text, at = at)
        fun ended(ending: CallEnding, at: Long) = CallSlot(Kind.Ended, ending = ending, at = at)
    }
}

/** Where a connection's call history is kept: one file, read once and written whole after every change, in order. */
interface CallHistoryStore {
    fun read(): String?
    fun write(text: String)
}

/**
 * What the person and the agent said aloud on this connection's calls, and
 * where calls were cut off (iOS `CallHistory`): the last [SLOTS] of them,
 * kept on this phone only, for the next call's first context
 * ([CallContext.initial]). The person's final transcripts and the agent's
 * words as spoken (its correction when the person cut in), never context,
 * tools or their results, and never the app's cues. Nothing here is logged
 * or sent anywhere but into the next call. Main thread.
 */
class CallHistory(private val store: CallHistoryStore?) {
    @Serializable
    private data class Kept(val format: Int, val slots: List<CallSlot>)

    private val kept = ArrayList<CallSlot>()
    /** Slots added in all, for finding one again by its number. */
    private var added = 0
    /** This call's agent responses by their provider event, as numbered. */
    private val responses = HashMap<Int, Int>()

    val slots: List<CallSlot> get() = kept.toList()

    init {
        store?.read()?.let { text -> runCatching { JSON.decodeFromString<Kept>(text) }.getOrNull() }
            ?.takeIf { it.format == FORMAT }?.let { kept += it.slots.takeLast(SLOTS) }
    }

    /** A new call: its responses are numbered afresh. */
    fun began() = responses.clear()

    fun heard(text: String, at: Long) {
        val words = text.trim()
        if (words.isNotEmpty()) add(CallSlot.person(words, at))
    }

    fun said(text: String, event: Int, at: Long) {
        val words = text.trim()
        if (words.isEmpty()) return
        add(CallSlot.assistant(words, at))
        responses[event] = added
    }

    /** The agent's words for [event] as they were heard: the person cut in. */
    fun corrected(text: String, event: Int) {
        val number = responses[event] ?: return
        val index = kept.size - (added - number) - 1
        if (index !in kept.indices || kept[index].kind != CallSlot.Kind.Assistant) return
        val words = text.trim().ifEmpty { "…" }
        if (kept[index].text == words) return
        kept[index] = kept[index].copy(text = words)
        save()
    }

    fun ended(ending: CallEnding, at: Long) = add(CallSlot.ended(ending, at))

    private fun add(slot: CallSlot) {
        kept += slot
        added += 1
        while (kept.size > SLOTS) kept.removeAt(0)
        save()
    }

    private fun save() {
        store?.write(JSON.encodeToString(Kept.serializer(), Kept(FORMAT, kept.toList())))
    }

    companion object {
        const val SLOTS = 30
        private const val FORMAT = 1
        private val JSON = Json { ignoreUnknownKeys = true }
    }
}

/**
 * A connection's history beside what else is kept of it ([file], under
 * `noBackupFilesDir`): never backed up, and gone with the connection
 * (`AgentSessions.deleteCache`). Writes go one after another off the main
 * thread; a read waits for them.
 */
class FileCallHistoryStore(private val file: File) : CallHistoryStore {
    override fun read(): String? = WRITES.submit<String?> { runCatching { file.takeIf { it.isFile }?.readText() }.getOrNull() }.get()

    override fun write(text: String) {
        WRITES.execute {
            runCatching {
                file.parentFile?.mkdirs()
                val next = File(file.parentFile, file.name + ".tmp")
                next.writeText(text)
                if (!next.renameTo(file)) next.delete()
            }
        }
    }

    companion object {
        /** Every history's writes, one after another. */
        private val WRITES = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "call-history").apply { isDaemon = true } }
    }
}
