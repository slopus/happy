package com.slopus.happy.diagnostics

import android.os.Trace

/**
 * [block] as a section of the system trace (Perfetto's app slices), named
 * [name]: the steps of a cold start (research/cold-start.md). Costs nothing
 * while no trace is recording.
 */
inline fun <T> traced(name: String, block: () -> T): T {
    Trace.beginSection(name)
    try {
        return block()
    } finally {
        Trace.endSection()
    }
}
