package com.slopus.happy.media

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.io.RandomAccessFile

/**
 * A file read a range at a time (iOS `PartialFile`, after Telegram's
 * `MediaBoxPartialFile`): the bytes so far at their own offsets in
 * `<name>.part`, holes where nothing came yet, and beside it
 * `<name>.part.meta`, which ranges those are and the file's whole length
 * once an answer said it. Both outlive the app, so a download picks up
 * where it stopped after a relaunch. Thread-safe; every call reads or
 * writes the disk, so none is made on the main thread.
 */
class PartialFile(val data: File, val meta: File) {
    private val lock = Any()
    /** Disjoint and in order. */
    private var ranges = ArrayList<ByteSpan>()
    private var length: Long? = null
    private var handle: RandomAccessFile? = null

    @Serializable
    private class Meta(val format: Int = FORMAT, val total: Long? = null, val ranges: List<List<Long>> = emptyList())

    init {
        // A missing or unreadable record starts empty, and the data it described goes with it.
        val record = runCatching { json.decodeFromString<Meta>(meta.readText()) }.getOrNull()
        if (record == null || record.format != FORMAT || !data.isFile) {
            data.delete()
            meta.delete()
        } else {
            val size = data.length()
            length = record.total
            for (pair in record.ranges) {
                if (pair.size == 2 && pair[0] >= 0 && pair[0] < pair[1] && pair[1] <= size) insert(ByteSpan(pair[0], pair[1]))
            }
        }
    }

    /** The whole file's length, once known. */
    val total: Long? get() = synchronized(lock) { length }

    /** How many of its bytes are here. */
    val downloaded: Long get() = synchronized(lock) { ranges.sumOf { it.length } }

    /** Every byte is here. */
    val isComplete: Boolean get() = synchronized(lock) { length?.let { it == 0L || covers(ByteSpan(0, it)) } ?: false }

    /** The ranges held, in order. */
    val held: List<ByteSpan> get() = synchronized(lock) { ranges.toList() }

    fun contains(span: ByteSpan): Boolean = synchronized(lock) { span.isEmpty || covers(span) }

    /** The parts of [span] not here yet, in order. */
    fun missing(span: ByteSpan): List<ByteSpan> = synchronized(lock) {
        if (span.isEmpty) return@synchronized emptyList()
        val out = ArrayList<ByteSpan>()
        var at = span.start
        for (range in ranges) {
            if (range.end <= at) continue
            if (range.start >= span.end) break
            if (range.start > at) out += ByteSpan(at, range.start)
            at = maxOf(at, range.end)
            if (at >= span.end) break
        }
        if (at < span.end) out += ByteSpan(at, span.end)
        out
    }

    /** The bytes that run on from [offset] without a hole, up to [limit]. */
    fun contiguous(offset: Long, limit: Long): Long = synchronized(lock) {
        val run = ranges.firstOrNull { offset >= it.start && offset < it.end } ?: return@synchronized 0L
        minOf(limit, run.end - offset)
    }

    /**
     * Records the whole length, as an answer's `Content-Range` gave it. A
     * different length than before means the file changed under it: what
     * was kept goes.
     */
    fun setTotal(total: Long): Unit = synchronized(lock) {
        if (length == total) return@synchronized
        if (length != null) reset()
        length = total
        save()
    }

    /** Writes [bytes] at [offset] and records them, the bytes first, so the record never names bytes that aren't there. */
    fun write(bytes: ByteArray, offset: Long): Unit = synchronized(lock) {
        if (bytes.isEmpty()) return@synchronized
        val file = open()
        file.seek(offset)
        file.write(bytes)
        insert(ByteSpan(offset, offset + bytes.size))
        save()
    }

    /** The bytes of [span], when all of them are here. */
    fun read(span: ByteSpan): ByteArray? = synchronized(lock) {
        if (span.isEmpty) return@synchronized ByteArray(0)
        if (!covers(span)) return@synchronized null
        val file = runCatching { open() }.getOrNull() ?: return@synchronized null
        val out = ByteArray(span.length.toInt())
        file.seek(span.start)
        runCatching { file.readFully(out) }.getOrNull() ?: return@synchronized null
        out
    }

    /** Closes the file, which [MediaStore] then moves or removes. */
    fun close(): Unit = synchronized(lock) {
        runCatching { handle?.close() }
        handle = null
    }

    /** Forgets everything kept. */
    fun remove(): Unit = synchronized(lock) { reset() }

    private fun covers(span: ByteSpan): Boolean = ranges.any { it.start <= span.start && it.end >= span.end }

    private fun insert(span: ByteSpan) {
        var start = span.start
        var end = span.end
        val kept = ArrayList<ByteSpan>(ranges.size + 1)
        for (range in ranges) {
            if (range.end < start || range.start > end) kept += range
            else {
                start = minOf(start, range.start)
                end = maxOf(end, range.end)
            }
        }
        kept += ByteSpan(start, end)
        kept.sortBy { it.start }
        ranges = kept
    }

    private fun open(): RandomAccessFile {
        handle?.let { return it }
        data.parentFile?.mkdirs()
        return RandomAccessFile(data, "rw").also { handle = it }
    }

    private fun reset() {
        runCatching { handle?.close() }
        handle = null
        ranges = ArrayList()
        length = null
        data.delete()
        meta.delete()
    }

    private fun save() {
        meta.parentFile?.mkdirs()
        val staging = File(meta.path + ".in")
        staging.writeText(json.encodeToString(Meta.serializer(), Meta(total = length, ranges = ranges.map { listOf(it.start, it.end) })))
        if (!staging.renameTo(meta)) {
            meta.delete()
            staging.renameTo(meta)
        }
    }

    private companion object {
        const val FORMAT = 1
        val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    }
}
