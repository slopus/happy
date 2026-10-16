package com.slopus.happy.diff

/**
 * happy-app engine/lru.ts: a small bounded cache, least recently read out
 * first, with an optional total weight. Thread-safe: documents are built
 * off the main thread.
 */
class DiffLruCache<T>(private val limit: Int, private val maxWeight: Long = Long.MAX_VALUE) {
    private class Entry<T>(val value: T, val weight: Long)

    private val entries = LinkedHashMap<String, Entry<T>>(16, 0.75f, true)
    private var weight = 0L

    @Synchronized
    fun get(key: String): T? = entries[key]?.value

    @Synchronized
    fun set(key: String, value: T, weight: Long = 1) {
        entries.remove(key)?.let { this.weight -= it.weight }
        if (weight > maxWeight) return
        entries[key] = Entry(value, weight)
        this.weight += weight
        val iterator = entries.entries.iterator()
        while ((entries.size > limit || this.weight > maxWeight) && iterator.hasNext()) {
            this.weight -= iterator.next().value.weight
            iterator.remove()
        }
    }

    @Synchronized
    fun clear() {
        entries.clear()
        weight = 0
    }
}
