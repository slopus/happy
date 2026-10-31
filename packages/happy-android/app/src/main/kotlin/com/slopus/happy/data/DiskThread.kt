package com.slopus.happy.data

import android.os.Looper
import android.os.StrictMode

/**
 * Disk work never runs on the main thread: a screen waits for the disk with
 * a loader, never with a frozen frame (iOS's `ThreadRules.assertOffMain`).
 * Every read and write of the account store, the agent catalogs and the
 * kept conversations passes [check].
 *
 * Debug builds also turn on StrictMode's disk detection for the whole
 * process ([watch]), which logs what [check] can't see (preferences, the
 * framework's own reads) as `StrictMode policy violation` in logcat.
 */
object DiskThread {
    /** Throw on disk work on the main thread. Tests turn it on around the paths they guard. */
    @Volatile var strict = false

    fun check() {
        if (strict && Looper.getMainLooper().isCurrentThread) throw MainThreadDiskException()
    }

    /** StrictMode's disk read and write detection, logged; debug builds only. */
    fun watch() {
        StrictMode.setThreadPolicy(
            StrictMode.ThreadPolicy.Builder(StrictMode.getThreadPolicy())
                .detectDiskReads()
                .detectDiskWrites()
                .penaltyLog()
                .build(),
        )
    }
}

class MainThreadDiskException : IllegalStateException("Disk IO on the main thread")
