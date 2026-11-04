package com.slopus.happy.monitor

import androidx.compose.runtime.Immutable
import kotlinx.serialization.Serializable
import java.math.BigDecimal
import java.math.RoundingMode
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.text.Normalizer
import java.util.Locale
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.pow

/**
 * One reading of the computer's System Monitor
 * (`GET /v0/surfaces/system-monitor/:surfaceId`, happy-agent API.md; iOS's
 * `SystemMonitorSample`): the host, CPU, memory, graphics, volumes, disk
 * traffic and busiest processes, with the sampler's recent history. Every
 * measurement the daemon can't take is null, never zero. Times are epoch ms.
 */
@Immutable
@Serializable
data class SystemMonitorSample(
    val sampledAt: Double,
    val intervalMs: Double = 1000.0,
    val host: Host,
    val cpu: Cpu,
    val memory: Memory,
    val gpus: List<Gpu> = emptyList(),
    val disks: List<Disk> = emptyList(),
    val diskIo: DiskIo? = null,
    val processes: Processes? = null,
    /** Oldest first, at most 300. */
    val history: List<Point> = emptyList(),
) {
    @Serializable data class Host(val hostname: String, val platform: String = "", val arch: String = "", val osName: String = "", val uptimeSeconds: Double = 0.0)
    @Serializable data class Cpu(
        val model: String = "",
        val logicalCores: Int = 0,
        val usagePercent: Double? = null,
        val perCoreUsagePercent: List<Double>? = null,
        val loadAverage: List<Double>? = null,
        val speedMhz: Double? = null,
        val temperatureCelsius: Double? = null,
    )
    @Serializable data class Memory(
        val totalBytes: Double = 0.0,
        val usedBytes: Double = 0.0,
        val availableBytes: Double = 0.0,
        val cachedBytes: Double? = null,
        val swapTotalBytes: Double? = null,
        val swapUsedBytes: Double? = null,
    )
    @Serializable data class Gpu(
        val name: String,
        val vendor: String? = null,
        val usagePercent: Double? = null,
        val memoryTotalBytes: Double? = null,
        val memoryUsedBytes: Double? = null,
        val temperatureCelsius: Double? = null,
        val powerWatts: Double? = null,
    )
    @Serializable data class Disk(val mountPoint: String, val device: String = "", val fileSystem: String? = null, val totalBytes: Double = 0.0, val usedBytes: Double = 0.0, val availableBytes: Double = 0.0)
    @Serializable data class DiskIo(val readBytesPerSecond: Double = 0.0, val writeBytesPerSecond: Double = 0.0)
    @Serializable data class Process(
        val pid: Int,
        val parentPid: Int? = null,
        val name: String,
        val user: String? = null,
        val state: String? = null,
        val cpuPercent: Double? = null,
        val memoryBytes: Double = 0.0,
        val threads: Int? = null,
        val startedAt: Double? = null,
    )
    @Serializable data class Processes(val total: Int = 0, val threads: Int? = null, val items: List<Process> = emptyList())
    @Serializable data class Point(
        val sampledAt: Double,
        val cpuPercent: Double? = null,
        val memoryUsedBytes: Double? = null,
        val gpuPercent: Double? = null,
        val diskReadBytesPerSecond: Double? = null,
        val diskWriteBytesPerSecond: Double? = null,
    )

    /** The busiest graphics device's use, as the history's `gpuPercent`. */
    val gpuPercent: Double? get() = gpus.mapNotNull { it.usagePercent }.maxOrNull()

    /** All volumes together. */
    val diskUsed: Double get() = disks.sumOf { it.usedBytes }
    val diskTotal: Double get() = disks.sumOf { it.totalBytes }
}

/** How busy something is, as the desktop colours it: calm under 60%, warm to 85%, hot above. */
enum class MonitorLevel {
    Calm, Warm, Hot, Unavailable;

    companion object {
        fun of(percent: Double?): MonitorLevel = when {
            percent == null -> Unavailable
            percent >= 85 -> Hot
            percent >= 60 -> Warm
            else -> Calm
        }
    }
}

/** The desktop's numbers, said the same way (`en-US`, its own rules), as iOS's `MonitorFormat`. */
object MonitorFormat {
    private val units = listOf("B", "KB", "MB", "GB", "TB", "PB")
    const val NONE = "—"

    /** Base 1024, one decimal past bytes: "1.5 GB", "0 B", "—" for null. */
    fun bytes(value: Double?): String {
        value ?: return NONE
        if (value <= 0) return "0 B"
        val power = floor(ln(value) / ln(1024.0)).toInt().coerceIn(0, units.size - 1)
        val scaled = value / 1024.0.pow(power)
        return "${number(scaled, if (power == 0) 0 else 1)} ${units[power]}"
    }

    fun rate(value: Double?): String = if (value == null) NONE else "${bytes(value)}/s"

    /** One decimal: "26.1%". */
    fun percent(value: Double?): String = value?.let { "${fixed(it, 1)}%" } ?: NONE

    fun temperature(value: Double?): String = value?.let { "${fixed(it, 0)} °C" } ?: NONE
    fun watts(value: Double?): String = value?.let { "${fixed(it, 1)} W" } ?: NONE
    fun gigahertz(mhz: Double?): String = mhz?.let { "${fixed(it / 1000, 2)} GHz" } ?: NONE

    /**
     * [places] decimals as JavaScript's `toFixed` gives them: halves up, from
     * the number as written (26.05 is "26.1"), not its binary value.
     */
    fun fixed(value: Double, places: Int): String {
        if (!value.isFinite()) return NONE
        return BigDecimal(value.toString()).setScale(places, RoundingMode.HALF_UP).toPlainString().let {
            if (it.startsWith("-") && it.trimStart('-').all { c -> c == '0' || c == '.' }) it.drop(1) else it
        }
    }

    /** "3d 4h" past a day, else "4h 12m". */
    fun uptime(seconds: Double): String {
        val total = seconds.coerceAtLeast(0.0).toLong()
        val days = total / 86_400
        val hours = total / 3600 % 24
        val minutes = total / 60 % 60
        return if (days > 0) "${days}d ${hours}h" else "${hours}h ${minutes}m"
    }

    /** Grouped thousands: "1,234". */
    fun count(value: Int): String = DecimalFormat("#,##0", DecimalFormatSymbols(Locale.US)).format(value)

    /** At most [decimals] places, trailing zeros dropped, thousands grouped. */
    fun number(value: Double, decimals: Int): String {
        val rounded = BigDecimal(value.toString()).setScale(decimals, RoundingMode.HALF_UP)
        val format = DecimalFormat(if (decimals > 0) "#,##0." + "#".repeat(decimals) else "#,##0", DecimalFormatSymbols(Locale.US))
        return format.format(rounded)
    }

    fun share(part: Double?, total: Double?): Double? = if (part == null || total == null || total <= 0) null else part / total * 100
}

/**
 * The process list as the desktop keeps it (iOS's `ProcessTable`): each
 * process's CPU over the last minute, filtered by name, user, state or PID,
 * and sorted by a column; the order moves at most every five seconds so a
 * row can be read before it jumps. Not thread-safe; owned by one deriver.
 */
class ProcessTable {
    enum class Column { Pid, Name, User, Cpu, Memory, State, Threads }

    data class Sort(val column: Column, val descending: Boolean) {
        /** A tap on [column]: the same one turns it round; another starts with the biggest numbers or A to Z. */
        fun choosing(column: Column): Sort = when {
            column == this.column -> Sort(column, !descending)
            column == Column.Cpu || column == Column.Memory || column == Column.Threads -> Sort(column, true)
            else -> Sort(column, false)
        }

        companion object {
            /** The desktop's: busiest first. */
            val STANDARD = Sort(Column.Cpu, true)
        }
    }

    @Immutable
    data class Row(val process: SystemMonitorSample.Process, /** Oldest first, at most [HISTORY_LENGTH]. */ val cpuHistory: List<Double?>)

    /** Each process's CPU by PID, oldest first. */
    var histories: Map<Int, List<Double?>> = emptyMap()
        private set
    private var order: List<Int> = emptyList()
    private var orderedAt = Double.NEGATIVE_INFINITY
    private var orderedBy: Sort? = null
    private var orderedFor: String? = null
    private var lastSample: Double? = null

    /** Adds [sample]'s readings to each process's history, once per sample. */
    fun record(sample: SystemMonitorSample) {
        if (lastSample == sample.sampledAt) return
        lastSample = sample.sampledAt
        val next = HashMap<Int, List<Double?>>()
        for (process in sample.processes?.items.orEmpty()) {
            next[process.pid] = (histories[process.pid].orEmpty() + process.cpuPercent).takeLast(HISTORY_LENGTH)
        }
        histories = next
    }

    /**
     * The rows to show at [now] (seconds): the processes [filter] matches, in
     * [sort]'s order when it or the filter changed or the last order is five
     * seconds old, else in the order shown, newcomers last. [histories] are
     * this table's own unless the feed keeps them and the screen the order.
     */
    fun rows(items: List<SystemMonitorSample.Process>, filter: String, sort: Sort, now: Double, histories: Map<Int, List<Double?>> = this.histories): List<Row> {
        val shown = matching(filter, items)
        val byPid = LinkedHashMap<Int, SystemMonitorSample.Process>()
        for (process in shown) byPid.putIfAbsent(process.pid, process)
        if (orderedBy != sort || orderedFor != filter || now - orderedAt >= REORDER_INTERVAL || now < orderedAt) {
            order = sorted(shown, sort).map { it.pid }
            orderedAt = now
            orderedBy = sort
            orderedFor = filter
        } else {
            val kept = order.filter { it in byPid }
            val known = kept.toSet()
            order = kept + sorted(shown.filter { it.pid !in known }, sort).map { it.pid }
        }
        return order.mapNotNull { pid -> byPid[pid]?.let { Row(it, histories[pid] ?: listOf(it.cpuPercent)) } }
    }

    companion object {
        const val HISTORY_LENGTH = 60
        /** How long an order holds while the numbers under it change (s). */
        const val REORDER_INTERVAL = 5.0

        /** Every word of [filter] in the name, user, state or PID, case and accents aside. */
        fun matching(filter: String, items: List<SystemMonitorSample.Process>): List<SystemMonitorSample.Process> {
            val words = filter.split(Regex("\\s+")).filter { it.isNotEmpty() }.map(::fold)
            if (words.isEmpty()) return items
            return items.filter { process ->
                val haystack = fold(listOf(process.name, process.user.orEmpty(), process.state.orEmpty(), process.pid.toString()).joinToString(" "))
                words.all { it in haystack }
            }
        }

        private fun fold(text: String): String =
            Normalizer.normalize(text, Normalizer.Form.NFD).replace(Regex("\\p{Mn}+"), "").lowercase(Locale.ROOT)

        /** Unknown values last whichever way; PID breaks ties. */
        fun sorted(items: List<SystemMonitorSample.Process>, sort: Sort): List<SystemMonitorSample.Process> {
            fun <T : Comparable<T>> compare(a: T?, b: T?): Int? = when {
                a == null && b == null -> null
                a == null -> 1
                b == null -> -1
                a == b -> null
                else -> if (sort.descending) b.compareTo(a) else a.compareTo(b)
            }
            return items.sortedWith { a, b ->
                val decided = when (sort.column) {
                    Column.Pid -> compare(a.pid, b.pid)
                    Column.Name -> compare(a.name.lowercase(), b.name.lowercase())
                    Column.User -> compare(a.user?.lowercase(), b.user?.lowercase())
                    Column.Cpu -> compare(a.cpuPercent, b.cpuPercent)
                    Column.Memory -> compare(a.memoryBytes, b.memoryBytes)
                    Column.State -> compare(a.state, b.state)
                    Column.Threads -> compare(a.threads, b.threads)
                }
                decided ?: a.pid.compareTo(b.pid)
            }
        }
    }
}
