package com.slopus.happy.media

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * One account's media downloads into its [MediaStore] (iOS
 * `MediaDownloads`, after Telegram's fetch manager): one reader per file, a
 * range at a time, into the partial file, resumable from whatever an
 * earlier run kept.
 *
 * - [download] reads the whole file; [pause] stops it, keeping the rest.
 * - [read] is a player's: the ranges it asks for are fetched first, so a
 *   recording plays from what is here and a seek waits only for its own
 *   range, while a download carries on after it.
 * - Background downloads (automatic ones) run at most [BACKGROUND_LIMIT]
 *   at a time; one a person asked for runs at once.
 *
 * Its state is touched on one lane only; fetches run beside it. Progress
 * goes to [board] under each file's ID.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MediaDownloads(
    val store: MediaStore,
    val board: DownloadBoard,
    dispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) {
    enum class Priority { Background, User }

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val lane = dispatcher.limitedParallelism(1)
    private val jobs = HashMap<String, Fetch>()
    private val waiting = ArrayList<String>()
    private var stopped = false

    private class Fetch(val id: String, var source: MediaSource) {
        var running: Job? = null
        /** The whole file is wanted, not only what players ask. */
        var full = false
        var priority = Priority.Background
        val readers = ArrayList<Reader>()
        val finished = ArrayList<CompletableDeferred<Unit>>()
        /** Where the last range ended: the next one follows on from it. */
        var cursor = 0L
        var failures = 0
    }

    /** A player waiting on these ranges. */
    private class Reader(val ranges: List<ByteSpan>, val done: CompletableDeferred<Unit> = CompletableDeferred())

    // State

    /** Where the file is, from the disk, also put on the board. */
    suspend fun phase(id: String, source: MediaSource): DownloadPhase = withContext(lane) { publish(id, source) }

    private fun publish(id: String, source: MediaSource): DownloadPhase = current(id, source).also { board.set(id, it) }

    private fun current(id: String, source: MediaSource): DownloadPhase {
        store.completeLength(id)?.let { return DownloadPhase.Complete(it) }
        val partial = if (store.hasPartial(id)) store.partial(id) else null
        val total = partial?.total ?: source.length
        val done = partial?.downloaded ?: 0
        jobs[id]?.let { job ->
            if (job.failures >= ATTEMPTS) return DownloadPhase.Failed(done, total)
            if (job.full || job.readers.isNotEmpty()) return DownloadPhase.Downloading(done, total)
        }
        return if (done > 0) DownloadPhase.Paused(done, total) else DownloadPhase.Remote(total)
    }

    // Whole files

    /** Reads the whole file, from where an earlier read stopped; a person's ([Priority.User]) lifts one queued behind others. */
    suspend fun download(id: String, source: MediaSource, priority: Priority = Priority.User) {
        withContext(lane) {
            if (stopped || store.isComplete(id)) {
                publish(id, source)
                return@withContext
            }
            want(fetch(id, source), priority)
            publish(id, source)
        }
    }

    /** Stops a whole-file read; a player's ranges are still served. */
    suspend fun pause(id: String) {
        withContext(lane) {
            val job = jobs[id] ?: return@withContext
            job.full = false
            if (job.readers.isEmpty() && job.finished.isEmpty()) {
                job.running?.cancel()
                job.running = null
                waiting.remove(id)
                jobs.remove(id)
            }
            publish(id, job.source)
        }
    }

    /** A tap on the ring: pause what is going, else start or resume. */
    suspend fun toggle(id: String, source: MediaSource) {
        val going = withContext(lane) { jobs[id]?.let { it.full && it.failures < ATTEMPTS } == true }
        if (going) pause(id) else download(id, source, Priority.User)
    }

    /** The whole file, read first where it isn't here yet. */
    suspend fun data(id: String, source: MediaSource, priority: Priority = Priority.User): ByteArray {
        complete(id, source, priority)
        return withContext(Dispatchers.IO) { store.completeFile(id).readBytes() }
    }

    /** Waits until the whole file is here, reading it where it isn't. */
    suspend fun complete(id: String, source: MediaSource, priority: Priority = Priority.User) {
        val done = withContext(lane) {
            if (store.isComplete(id)) return@withContext null
            if (stopped) throw MediaError.Stopped()
            val job = fetch(id, source)
            CompletableDeferred<Unit>().also {
                job.finished += it
                want(job, priority)
                publish(id, source)
            }
        } ?: return
        done.await()
    }

    private fun want(job: Fetch, priority: Priority) {
        job.full = true
        if (job.failures >= ATTEMPTS) job.failures = 0
        if (priority > job.priority) job.priority = priority
        run(job)
    }

    // Streaming

    /** The length, from the disk or the first range read. */
    suspend fun length(id: String, source: MediaSource): Long {
        val known = withContext(lane) {
            store.completeLength(id) ?: (if (store.hasPartial(id)) store.partial(id).total else null) ?: source.length
        }
        if (known != null) return known
        wait(id, source, listOf(ByteSpan(0, 1)))
        return withContext(lane) { store.completeLength(id) ?: store.partial(id).total } ?: throw MediaError.InvalidResponse()
    }

    /** The bytes of [span], fetched first where they aren't here: a player's read. */
    suspend fun read(id: String, source: MediaSource, span: ByteSpan): ByteArray {
        withContext(Dispatchers.IO) { store.read(id, span) }?.let { return it }
        wait(id, source, listOf(span))
        val total = withContext(lane) { store.completeLength(id) ?: store.partial(id).total }
        val clamped = total?.let { span.clamped(it) } ?: span
        return withContext(Dispatchers.IO) { store.read(id, clamped) } ?: throw MediaError.OutOfRange()
    }

    /** How many bytes run on from [offset] without a hole, up to [limit]. */
    suspend fun available(id: String, from: Long, limit: Long): Long = withContext(lane) {
        store.completeLength(id)?.let { return@withContext maxOf(0, minOf(limit, it - from)) }
        if (!store.hasPartial(id)) 0L else store.partial(id).contiguous(from, limit)
    }

    private suspend fun wait(id: String, source: MediaSource, ranges: List<ByteSpan>) {
        val reader = withContext(lane) {
            if (stopped) throw MediaError.Stopped()
            val job = fetch(id, source)
            val reader = Reader(ranges)
            if (satisfied(id, reader)) return@withContext null
            job.readers += reader
            // A player waits: never behind automatic downloads.
            job.priority = Priority.User
            if (job.failures >= ATTEMPTS) job.failures = 0
            run(job)
            publish(id, source)
            reader
        } ?: return
        try {
            reader.done.await()
        } catch (e: CancellationException) {
            withContext(NonCancellable) { withContext(lane) { cancelReader(id, reader) } }
            throw e
        }
    }

    /** A player that stopped waiting: its ranges are no longer fetched first, and a read nothing else wants stops. */
    private fun cancelReader(id: String, reader: Reader) {
        val job = jobs[id] ?: return
        if (!job.readers.remove(reader)) return
        if (!job.full && job.readers.isEmpty() && job.finished.isEmpty()) {
            job.running?.cancel()
            jobs.remove(id)
            publish(id, job.source)
            startWaiting()
        }
    }

    // Running

    private fun fetch(id: String, source: MediaSource): Fetch {
        jobs[id]?.let { job ->
            if (job.source.length == null && source.length != null) job.source = source
            return job
        }
        return Fetch(id, source).also { jobs[id] = it }
    }

    private val runningBackground: Int get() = jobs.values.count { it.running != null && it.priority == Priority.Background }

    private fun run(job: Fetch) {
        if (job.running != null || stopped) return
        if (job.priority == Priority.Background && runningBackground >= BACKGROUND_LIMIT) {
            if (job.id !in waiting) waiting += job.id
            return
        }
        waiting.remove(job.id)
        job.running = scope.launch { loop(job) }
    }

    private fun startWaiting() {
        while (waiting.isNotEmpty() && runningBackground < BACKGROUND_LIMIT) {
            val next = waiting.removeAt(0)
            jobs[next]?.let(::run)
        }
    }

    private suspend fun loop(job: Fetch) {
        val id = job.id
        while (true) {
            val next = withContext(lane) {
                if (jobs[id] !== job || stopped) return@withContext null
                val partial = store.partial(id)
                if (store.isComplete(id) || partial.isComplete) {
                    finish(job)
                    return@withContext null
                }
                nextRange(job, partial) ?: run {
                    // Nothing wanted now: what players ask later starts it again.
                    job.running = null
                    if (!job.full && job.readers.isEmpty() && job.finished.isEmpty()) jobs.remove(id)
                    startWaiting()
                    null
                }
            } ?: return
            try {
                val piece = job.source.fetch(next)
                withContext(lane) {
                    if (jobs[id] !== job) throw CancellationException("Replaced")
                    val partial = store.partial(id)
                    piece.total?.let(partial::setTotal)
                    if (piece.data.isEmpty() && partial.total != 0L) throw MediaError.InvalidResponse()
                    partial.write(piece.data, piece.offset)
                    job.cursor = piece.offset + piece.data.size
                    job.failures = 0
                    serveReaders(job)
                    publish(id, job.source)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val again = withContext(lane) {
                    if (jobs[id] !== job) return@withContext false
                    job.failures++
                    if (job.failures >= ATTEMPTS || e is MediaError) {
                        job.failures = ATTEMPTS
                        fail(job, e)
                        false
                    } else true
                }
                if (!again) return
                sleep(1000L shl (job.failures - 1))
            }
        }
    }

    /** The next range to fetch: what a reader waits on first, else on from where the last one ended, else the first hole. */
    private fun nextRange(job: Fetch, partial: PartialFile): ByteSpan? {
        val total = partial.total ?: job.source.length
        for (reader in job.readers) {
            for (range in reader.ranges) {
                val clamped = total?.let { range.clamped(it) } ?: range
                val hole = partial.missing(clamped).firstOrNull() ?: continue
                // A little ahead of what it asked, as a player reads on, short of bytes already here.
                val end = minOf(hole.start + STREAM_CHUNK, total ?: Long.MAX_VALUE)
                val last = partial.missing(ByteSpan(hole.start, end)).lastOrNull()?.end ?: end
                return ByteSpan(hole.start, last)
            }
        }
        if (!job.full) return null
        if (total == null) return ByteSpan(0, CHUNK)
        val hole = partial.missing(ByteSpan(minOf(job.cursor, total), total)).firstOrNull() ?: partial.missing(ByteSpan(0, total)).firstOrNull()
        return hole?.let { ByteSpan(it.start, minOf(it.end, it.start + CHUNK)) }
    }

    private fun serveReaders(job: Fetch) {
        val ready = job.readers.filter { satisfied(job.id, it) }
        if (ready.isEmpty()) return
        job.readers.removeAll(ready.toSet())
        ready.forEach { it.done.complete(Unit) }
    }

    private fun satisfied(id: String, reader: Reader): Boolean {
        if (store.isComplete(id)) return true
        if (!store.hasPartial(id)) return false
        val partial = store.partial(id)
        val total = partial.total
        return reader.ranges.all { range -> partial.contains(total?.let { range.clamped(it) } ?: range) }
    }

    private fun finish(job: Fetch) {
        jobs.remove(job.id)
        try {
            if (!store.isComplete(job.id)) store.finish(job.id)
            job.readers.forEach { it.done.complete(Unit) }
            job.finished.forEach { it.complete(Unit) }
            publish(job.id, job.source)
        } catch (e: Exception) {
            // Kept as failed, so its ring says so until a tap.
            job.failures = ATTEMPTS
            jobs[job.id] = job
            fail(job, e)
        }
        startWaiting()
    }

    private fun fail(job: Fetch, error: Exception) {
        val readers = job.readers.toList()
        val finished = job.finished.toList()
        job.readers.clear()
        job.finished.clear()
        job.full = false
        job.running = null
        readers.forEach { it.done.completeExceptionally(error) }
        finished.forEach { it.completeExceptionally(error) }
        board.set(job.id, current(job.id, job.source))
        startWaiting()
    }

    // Lifetime

    /** Stops every read; what each kept stays for the next run. */
    suspend fun stop() {
        withContext(lane) {
            stopped = true
            dropAll()
        }
        scope.cancel()
    }

    /** Stops every read and forgets every file (Clear Media). */
    suspend fun removeAll() {
        withContext(lane) {
            dropAll()
            store.removeAll()
            board.clear()
        }
    }

    private fun dropAll() {
        for (job in jobs.values) {
            job.running?.cancel()
            job.readers.forEach { it.done.completeExceptionally(MediaError.Stopped()) }
            job.finished.forEach { it.completeExceptionally(MediaError.Stopped()) }
        }
        jobs.clear()
        waiting.clear()
    }

    /** Whether a read is going, for tests. */
    internal suspend fun isRunning(id: String): Boolean = withContext(lane) { jobs[id]?.running != null }

    companion object {
        /** A range asked for at a time while a player waits on it. */
        const val STREAM_CHUNK = 256L * 1024
        /** A range asked for at a time while nothing waits. */
        const val CHUNK = 1024L * 1024
        const val BACKGROUND_LIMIT = 2
        /** Failed fetches in a row before the file is given up on, until a tap. */
        const val ATTEMPTS = 3
    }
}
