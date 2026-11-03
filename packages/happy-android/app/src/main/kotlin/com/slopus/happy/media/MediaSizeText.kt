package com.slopus.happy.media

import java.util.Locale
import kotlin.math.pow
import kotlin.math.roundToLong

/**
 * What Telegram's media badge says (iOS `MediaSizeText`, Telegram's
 * `dataSizeString`): a size in binary units, "840 KB" or "8.4 MB", and a
 * download's progress against it, "1.2 / 8.4 MB", the unit said once where
 * both share it.
 */
object MediaSizeText {
    private enum class Unit(val label: String) { B("B"), KB("KB"), MB("MB"), GB("GB") }

    private fun unitOf(bytes: Long): Unit = when {
        bytes < 1024 -> Unit.B
        bytes < 1024L * 1024 -> Unit.KB
        bytes < 1024L * 1024 * 1024 -> Unit.MB
        else -> Unit.GB
    }

    fun size(bytes: Long): String {
        val unit = unitOf(bytes)
        return "${number(bytes, unit)} ${unit.label}"
    }

    fun progress(done: Long, total: Long): String {
        val unit = unitOf(total)
        val doneUnit = unitOf(done)
        // Under a megabyte of a bigger file reads as "0.4 / 8.4 MB".
        if (doneUnit == unit || (unit >= Unit.MB && doneUnit < unit)) return "${number(done, unit)} / ${number(total, unit)} ${unit.label}"
        return "${size(done)} / ${size(total)}"
    }

    /** A badge's words for [phase]: the size, or how far it is; null while the size isn't known. */
    fun text(phase: DownloadPhase): String? = when (phase) {
        is DownloadPhase.Remote -> phase.total?.let(::size)
        is DownloadPhase.Complete -> size(phase.total)
        is DownloadPhase.Downloading -> moving(phase.done, phase.total, going = true)
        is DownloadPhase.Paused -> moving(phase.done, phase.total, going = false)
        is DownloadPhase.Failed -> moving(phase.done, phase.total, going = false)
    }

    private fun moving(done: Long, total: Long?, going: Boolean): String? {
        if (total == null) return if (done > 0) size(done) else null
        // Nothing here yet and nothing coming: only the size.
        if (done == 0L && !going) return size(total)
        return progress(done, total)
    }

    private fun number(bytes: Long, unit: Unit): String = when (unit) {
        Unit.B -> "$bytes"
        Unit.KB -> "${(bytes / 1024.0).roundToLong()}"
        else -> {
            val tenths = (bytes / 1024.0.pow(unit.ordinal) * 10).roundToLong()
            if (tenths % 10 == 0L) "${tenths / 10}" else String.format(Locale.US, "%.1f", tenths / 10.0)
        }
    }
}
