package com.slopus.happy.ui.settings

/**
 * hooks/useMultiClick.ts: true on the [required]th click when each came
 * within [resetMs] of the one before; the count then starts over.
 */
class MultiClick(private val required: Int, private val resetMs: Long = 2000, private val clock: () -> Long = System::currentTimeMillis) {
    private var count = 0
    private var last = 0L

    fun click(): Boolean {
        val now = clock()
        if (count > 0 && now - last > resetMs) count = 0
        last = now
        count++
        if (count < required) return false
        count = 0
        return true
    }
}
