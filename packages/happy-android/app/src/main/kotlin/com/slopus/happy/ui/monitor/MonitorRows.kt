package com.slopus.happy.ui.monitor

import android.content.res.Resources
import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import com.slopus.happy.R
import com.slopus.happy.monitor.MonitorFormat as F
import com.slopus.happy.monitor.MonitorLevel
import com.slopus.happy.monitor.ProcessTable
import com.slopus.happy.monitor.SystemMonitorFeed
import com.slopus.happy.monitor.SystemMonitorSample
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.connection.RowTile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

@Immutable
internal sealed interface MonitorRow {
    val key: String
    data class Heading(override val key: String, val text: String, val trailing: String? = null) : MonitorRow
    data class Gap(override val key: String) : MonitorRow
    data class Note(override val key: String, val text: String) : MonitorRow
    data class Host(val title: String, val meta: String, val status: String, val description: String, val live: Boolean, val loading: Boolean) : MonitorRow { override val key = "host" }
    data class Summary(override val key: String, val title: String, val value: String, val subtitle: String, val icon: Ionicon, val tint: RowTile,
        val lines: List<MonitorChartLine>, val bars: List<Double?>? = null) : MonitorRow
    data class Detail(override val key: String, val label: String, val value: String, val last: Boolean, val meter: Boolean = false,
        val percent: Double? = null, val note: String? = null, val dot: Color? = null, val quiet: Boolean = false, val alone: Boolean = false) : MonitorRow
    data class Process(val pid: Int, val name: String, val cpu: String, val memory: String, val meta: String, val history: List<Double?>,
        val level: MonitorLevel, val description: String, val first: Boolean, val last: Boolean) : MonitorRow { override val key = "process:$pid" }
}

internal fun monitorStatus(status: SystemMonitorFeed.Status, short: Boolean = false): Int = when (status) {
    SystemMonitorFeed.Status.Loading -> if (short) R.string.monitor_short_loading else R.string.monitor_loading
    SystemMonitorFeed.Status.Ready -> R.string.monitor_live
    SystemMonitorFeed.Status.Reconnecting -> if (short) R.string.monitor_short_reconnecting else R.string.monitor_reconnecting
    SystemMonitorFeed.Status.Missing -> if (short) R.string.monitor_short_missing else R.string.monitor_missing
    SystemMonitorFeed.Status.Unsupported -> if (short) R.string.monitor_short_unsupported else R.string.monitor_unsupported
}

/** All number/date formatting, list filtering and ordering stays off the UI thread. */
internal fun monitorRows(state: SystemMonitorFeed.State, filter: String, sort: ProcessTable.Sort, table: ProcessTable, words: Resources, dark: Boolean): List<MonitorRow> = buildList {
    fun s(id: Int, vararg values: Any) = words.getString(id, *values)
    fun quantity(id: Int, count: Int) = words.getQuantityString(id, count, F.count(count))
    if (state.status == SystemMonitorFeed.Status.Missing || state.status == SystemMonitorFeed.Status.Unsupported) {
        add(MonitorRow.Note("unavailable", s(monitorStatus(state.status))))
        return@buildList
    }
    val sample = state.sample
    val history = sample?.history.orEmpty()
    fun line(values: (SystemMonitorSample.Point) -> Double?, maximum: Double, percent: Double?, fills: Boolean = true) =
        MonitorChartLine(history.map { values(it)?.div(maxOf(1.0, maximum)) }, MonitorLevel.of(percent).ink(dark), fills)
    fun gap(id: String) { add(MonitorRow.Gap("gap:$id")) }
    fun detail(id: String, label: Int, value: String, last: Boolean = false, meter: Boolean = false, percent: Double? = null, note: String? = null, dot: Color? = null) {
        add(MonitorRow.Detail(id, s(label), value, last, meter, percent, note, dot))
    }
    add(MonitorRow.Heading("overview", s(R.string.monitor_overview)))
    add(MonitorRow.Host(sample?.host?.hostname ?: s(R.string.monitor_title), sample?.host?.let {
        s(R.string.monitor_host_meta, it.osName, it.arch, F.uptime(it.uptimeSeconds))
    } ?: s(R.string.monitor_waiting_host), s(monitorStatus(state.status, true)), s(monitorStatus(state.status)),
        live = state.status == SystemMonitorFeed.Status.Ready, loading = state.status == SystemMonitorFeed.Status.Loading))
    if (state.failed) add(MonitorRow.Note("unreachable", s(R.string.monitor_unreachable)))
    gap("cpu")
    add(MonitorRow.Summary("cpu", s(R.string.monitor_cpu), F.percent(sample?.cpu?.usagePercent), sample?.cpu?.model ?: s(R.string.monitor_waiting_cpu),
        Ionicon.HardwareChipOutline, RowTile.Blue, listOf(line({ it.cpuPercent }, 100.0, sample?.cpu?.usagePercent)), sample?.cpu?.perCoreUsagePercent))
    detail("cpu:cores", R.string.monitor_logical_cores, sample?.cpu?.logicalCores?.toString() ?: F.NONE)
    detail("cpu:frequency", R.string.monitor_frequency, F.gigahertz(sample?.cpu?.speedMhz))
    detail("cpu:temperature", R.string.monitor_temperature, F.temperature(sample?.cpu?.temperatureCelsius), last = true)
    gap("gpu")
    val gpus = sample?.gpus.orEmpty()
    add(MonitorRow.Summary("gpu", s(R.string.monitor_gpu), F.percent(sample?.gpuPercent), when {
        sample == null -> s(R.string.monitor_waiting_gpu)
        gpus.isEmpty() -> s(R.string.monitor_no_gpu)
        else -> gpus.joinToString(" · ") { it.name }
    }, Ionicon.CubeOutline, RowTile.Purple, listOf(line({ it.gpuPercent }, 100.0, sample?.gpuPercent))))
    gpus.forEachIndexed { index, gpu ->
        if (gpus.size > 1) add(MonitorRow.Detail("gpu:$index:name", gpu.name, F.percent(gpu.usagePercent), last = false))
        detail("gpu:$index:memory", R.string.monitor_video_memory, if (gpu.memoryTotalBytes == null) F.NONE else "${F.bytes(gpu.memoryUsedBytes)} / ${F.bytes(gpu.memoryTotalBytes)}")
        detail("gpu:$index:temperature", R.string.monitor_temperature, F.temperature(gpu.temperatureCelsius))
        detail("gpu:$index:power", R.string.monitor_power, F.watts(gpu.powerWatts), last = index == gpus.lastIndex)
    }
    if (gpus.isEmpty()) add(MonitorRow.Detail("gpu:empty", s(if (sample == null) R.string.monitor_gpu_waiting else R.string.monitor_gpu_unavailable), "", last = true, quiet = true))
    gap("memory")
    val memory = sample?.memory
    val used = F.share(memory?.usedBytes, memory?.totalBytes)
    add(MonitorRow.Summary("memory", s(R.string.monitor_memory), F.bytes(memory?.usedBytes), memory?.let { s(R.string.monitor_memory_subtitle, F.bytes(it.totalBytes)) } ?: s(R.string.monitor_waiting_memory),
        Ionicon.LayersOutline, RowTile.Indigo, listOf(line({ it.memoryUsedBytes }, memory?.totalBytes ?: 1.0, used))))
    detail("memory:used", R.string.monitor_physical_used, used?.let { "${it.roundToInt()}%" } ?: F.NONE, meter = true, percent = used)
    detail("memory:available", R.string.monitor_available, F.bytes(memory?.availableBytes))
    memory?.cachedBytes?.let { detail("memory:cached", R.string.monitor_cached, F.bytes(it), meter = true, percent = F.share(it, memory.totalBytes)) }
    detail("memory:swap", R.string.monitor_swap, if (memory?.swapTotalBytes == null) F.NONE else "${F.bytes(memory.swapUsedBytes)} / ${F.bytes(memory.swapTotalBytes)}", last = true,
        meter = memory?.swapTotalBytes != null && memory.swapUsedBytes != null, percent = F.share(memory?.swapUsedBytes, memory?.swapTotalBytes) ?: 0.0)
    gap("disk")
    val disks = sample?.disks.orEmpty()
    val diskUsed = if (disks.isEmpty()) null else F.share(sample?.diskUsed, sample?.diskTotal)
    val peak = history.flatMap { listOfNotNull(it.diskReadBytesPerSecond, it.diskWriteBytesPerSecond) }.maxOrNull() ?: 1.0
    add(MonitorRow.Summary("disk", s(R.string.monitor_disk), F.percent(diskUsed), if (disks.isEmpty()) s(R.string.monitor_no_volumes) else s(R.string.monitor_disk_subtitle, F.bytes(sample?.diskUsed), F.bytes(sample?.diskTotal)),
        Ionicon.ServerOutline, RowTile.Teal, listOf(line({ it.diskReadBytesPerSecond }, peak, 0.0),
            line({ it.diskWriteBytesPerSecond }, peak, 60.0, fills = false))))
    detail("disk:read", R.string.monitor_read_io, F.rate(sample?.diskIo?.readBytesPerSecond), dot = RowTile.Blue.ink(dark))
    detail("disk:write", R.string.monitor_write_io, F.rate(sample?.diskIo?.writeBytesPerSecond), last = disks.isEmpty(), dot = RowTile.Orange.ink(dark))
    disks.forEachIndexed { index, disk -> add(MonitorRow.Detail("disk:volume:$index", disk.mountPoint, s(R.string.monitor_free, F.bytes(disk.availableBytes)), last = index == disks.lastIndex,
        meter = true, percent = F.share(disk.usedBytes, disk.totalBytes), note = "${disk.fileSystem ?: s(R.string.monitor_unknown_filesystem)} · ${F.bytes(disk.totalBytes)}")) }
    val processes = sample?.processes
    val count = processes?.let { quantity(R.plurals.monitor_process_count, it.total) + (it.threads?.let { threads -> " · ${quantity(R.plurals.monitor_thread_count, threads)}" } ?: "") +
        if (state.status == SystemMonitorFeed.Status.Ready) "" else " · ${s(R.string.monitor_last_sample)}" }
    add(MonitorRow.Heading("processes", s(R.string.monitor_processes), count))
    if (processes == null) {
        add(MonitorRow.Detail("processes:unavailable", s(if (sample == null) R.string.monitor_waiting_processes else R.string.monitor_processes_unavailable), "", last = true,
            note = if (sample == null) null else s(R.string.monitor_processes_unavailable_note), quiet = true, alone = true))
    } else {
        val rows = table.rows(processes.items, filter, sort, sample.sampledAt / 1000, state.histories)
        if (rows.isEmpty()) add(MonitorRow.Detail("processes:empty", s(if (filter.isBlank()) R.string.monitor_no_processes else R.string.monitor_no_matches), "", last = true, quiet = true, alone = true))
        rows.forEachIndexed { index, row ->
            val process = row.process
            val meta = buildList {
                add("${s(R.string.monitor_pid)} ${process.pid}")
                process.user?.let(::add)
                process.state?.let(::add)
                process.threads?.let { add(quantity(R.plurals.monitor_thread_count, it)) }
            }.joinToString(" · ")
            val cpu = F.percent(process.cpuPercent)
            val bytes = F.bytes(process.memoryBytes)
            val peak = maxOf(1.0, row.cpuHistory.filterNotNull().maxOrNull() ?: 0.0)
            add(MonitorRow.Process(process.pid, process.name, cpu, bytes, meta, row.cpuHistory.map { it?.div(peak) }, MonitorLevel.of(process.cpuPercent),
                "${s(R.string.monitor_cpu)} $cpu, ${s(R.string.monitor_memory)} $bytes, $meta", first = index == 0, last = index == rows.lastIndex))
        }
        add(MonitorRow.Note("processes:footer", s(R.string.monitor_shown, rows.size, maxOf(processes.total, processes.items.size))))
    }
    val seconds = if (history.size > 1) ((history.last().sampledAt - history.first().sampledAt) / 1000).roundToInt() else null
    val activity = seconds?.let { words.getQuantityString(R.plurals.monitor_activity, it, it) } ?: s(R.string.monitor_collecting)
    val sampled = sample?.let { s(R.string.monitor_sampled, SimpleDateFormat("h:mm:ss a", Locale.US).format(Date(it.sampledAt.toLong())), F.number(it.intervalMs / 1000, 3)) } ?: s(R.string.monitor_waiting_sample)
    add(MonitorRow.Note("footer", "$activity · $sampled"))
}