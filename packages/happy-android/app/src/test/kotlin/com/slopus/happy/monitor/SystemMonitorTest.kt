package com.slopus.happy.monitor

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.Collections

/** The API's own example snapshot, with `sampledAt` and a process list the tests choose. */
internal fun systemMonitorJson(sampledAt: Double = 1_760_943_600_000.0, processes: String? = null, cpu: Double = 26.05): String {
    val items = processes ?: """[{"pid":1234,"parentPid":1,"name":"node","user":"steve","state":"running","cpuPercent":12.5,"memoryBytes":268435456,"threads":12,"startedAt":1760940000000}]"""
    return """
    {"sampledAt":$sampledAt,"intervalMs":1000,
     "host":{"hostname":"build-box","platform":"linux","arch":"x64","osName":"Ubuntu 24.04.1 LTS","uptimeSeconds":123456},
     "cpu":{"model":"AMD Ryzen 9 7950X","logicalCores":2,"usagePercent":$cpu,"perCoreUsagePercent":[12,40.1],"loadAverage":[1.2,0.9,0.7],"speedMhz":4500,"temperatureCelsius":null},
     "memory":{"totalBytes":34359738368,"usedBytes":8589934592,"availableBytes":25769803776,"cachedBytes":2147483648,"swapTotalBytes":0,"swapUsedBytes":0},
     "gpus":[{"name":"NVIDIA GeForce RTX 4090","vendor":"nvidia","usagePercent":12,"memoryTotalBytes":null,"memoryUsedBytes":null,"temperatureCelsius":45,"powerWatts":60.5}],
     "disks":[{"mountPoint":"/","device":"/dev/nvme0n1p2","fileSystem":"ext4","totalBytes":1000000000000,"usedBytes":400000000000,"availableBytes":600000000000}],
     "diskIo":{"readBytesPerSecond":0,"writeBytesPerSecond":0},
     "processes":{"total":123,"threads":456,"items":$items},
     "history":[{"sampledAt":$sampledAt,"cpuPercent":$cpu,"memoryUsedBytes":8589934592,"gpuPercent":12,"diskReadBytesPerSecond":0,"diskWriteBytesPerSecond":0}]}
    """
}

internal fun systemMonitorSample(sampledAt: Double = 1_760_943_600_000.0, processes: String? = null, cpu: Double = 26.05): SystemMonitorSample =
    AgentClient.json.decodeFromString(SystemMonitorSample.serializer(), systemMonitorJson(sampledAt, processes, cpu))

private fun process(pid: Int, name: String, cpu: Double?, memory: Double = 100.0, user: String? = "steve", state: String? = "running") =
    SystemMonitorSample.Process(pid = pid, parentPid = 1, name = name, user = user, state = state, cpuPercent = cpu, memoryBytes = memory, threads = 1, startedAt = null)

/** A port of iOS's SystemMonitorTests, with the same cases. */
class SystemMonitorTest {
    @Test fun theApisExampleDecodes() {
        val sample = systemMonitorSample()
        assertEquals("build-box", sample.host.hostname)
        assertEquals(listOf(12.0, 40.1), sample.cpu.perCoreUsagePercent)
        assertNull(sample.cpu.temperatureCelsius)
        assertEquals(12.0, sample.gpuPercent)
        assertNull(sample.gpus[0].memoryTotalBytes)
        assertEquals(400_000_000_000.0, sample.diskUsed, 0.0)
        assertEquals("node", sample.processes?.items?.first()?.name)
        assertEquals(1, sample.history.size)
    }

    /** What a daemon without a measurement sends: nulls, empty lists. */
    @Test fun unmeasuredReadingsAreNull() {
        val json = """{"sampledAt":1,"intervalMs":1000,"host":{"hostname":"h","platform":"win32","arch":"arm64","osName":"Windows","uptimeSeconds":0},"cpu":{"model":"x","logicalCores":0,"usagePercent":null,"perCoreUsagePercent":null,"loadAverage":null,"speedMhz":null,"temperatureCelsius":null},"memory":{"totalBytes":1,"usedBytes":0,"availableBytes":1,"cachedBytes":null,"swapTotalBytes":null,"swapUsedBytes":null},"gpus":[],"disks":[],"diskIo":null,"processes":null,"history":[]}"""
        val sample = AgentClient.json.decodeFromString(SystemMonitorSample.serializer(), json)
        assertNull(sample.cpu.usagePercent)
        assertNull(sample.gpuPercent)
        assertNull(sample.diskIo)
        assertNull(sample.processes)
        assertEquals(0.0, sample.diskTotal, 0.0)
    }

    @Test fun theDesktopsNumbers() {
        assertEquals("—", MonitorFormat.bytes(null))
        assertEquals("0 B", MonitorFormat.bytes(0.0))
        assertEquals("500 B", MonitorFormat.bytes(500.0))
        assertEquals("1.5 KB", MonitorFormat.bytes(1536.0))
        assertEquals("8 GB", MonitorFormat.bytes(8_589_934_592.0))
        assertEquals("1.3 GB", MonitorFormat.bytes(1_073_741_824 * 1.25))
        assertEquals("931.3 GB", MonitorFormat.bytes(1_000_000_000_000.0))
        assertEquals("1 KB/s", MonitorFormat.rate(1024.0))
        assertEquals("—", MonitorFormat.rate(null))
        assertEquals("26.1%", MonitorFormat.percent(26.05))
        assertEquals("—", MonitorFormat.percent(null))
        assertEquals("45 °C", MonitorFormat.temperature(44.6))
        assertEquals("60.5 W", MonitorFormat.watts(60.5))
        assertEquals("4.50 GHz", MonitorFormat.gigahertz(4500.0))
        assertEquals("1d 10h", MonitorFormat.uptime(123_456.0))
        assertEquals("1h 1m", MonitorFormat.uptime(3700.0))
        assertEquals("12,345", MonitorFormat.count(12345))
        assertEquals(25.0, MonitorFormat.share(1.0, 4.0))
        assertNull(MonitorFormat.share(1.0, 0.0))
    }

    @Test fun levels() {
        assertEquals(MonitorLevel.Unavailable, MonitorLevel.of(null))
        assertEquals(MonitorLevel.Calm, MonitorLevel.of(59.9))
        assertEquals(MonitorLevel.Warm, MonitorLevel.of(60.0))
        assertEquals(MonitorLevel.Hot, MonitorLevel.of(85.0))
    }
}

/** A port of iOS's ProcessTableTests. */
class ProcessTableTest {
    private val items = listOf(
        process(3, "Safari", cpu = 5.0, memory = 900.0),
        process(1, "kernel_task", cpu = 20.0, memory = 10.0, user = "root"),
        process(2, "node", cpu = null, memory = 500.0),
        process(4, "zsh", cpu = 5.0, memory = 1.0, state = "sleeping"),
    )
    private val byPid = ProcessTable.Sort(ProcessTable.Column.Pid, false)

    @Test fun sortingPutsUnknownLastAndBreaksTiesByPid() {
        assertEquals(listOf(1, 3, 4, 2), ProcessTable.sorted(items, ProcessTable.Sort.STANDARD).map { it.pid })
        assertEquals(listOf(3, 4, 1, 2), ProcessTable.sorted(items, ProcessTable.Sort(ProcessTable.Column.Cpu, false)).map { it.pid })
        assertEquals(listOf(3, 2, 1, 4), ProcessTable.sorted(items, ProcessTable.Sort(ProcessTable.Column.Memory, true)).map { it.pid })
        assertEquals(listOf(1, 2, 3, 4), ProcessTable.sorted(items, ProcessTable.Sort(ProcessTable.Column.Name, false)).map { it.pid })
        assertEquals(listOf(4, 3, 2, 1), ProcessTable.sorted(items, ProcessTable.Sort(ProcessTable.Column.Pid, true)).map { it.pid })
    }

    @Test fun choosingAColumn() {
        val standard = ProcessTable.Sort.STANDARD
        assertEquals(ProcessTable.Sort(ProcessTable.Column.Cpu, false), standard.choosing(ProcessTable.Column.Cpu))
        assertEquals(ProcessTable.Sort(ProcessTable.Column.Name, false), standard.choosing(ProcessTable.Column.Name))
        assertEquals(ProcessTable.Sort(ProcessTable.Column.Memory, true), standard.choosing(ProcessTable.Column.Memory))
    }

    @Test fun theFilterMatchesNameUserStateOrPid() {
        assertEquals(listOf(3), ProcessTable.matching("SAF", items).map { it.pid })
        assertEquals(listOf(1), ProcessTable.matching("root", items).map { it.pid })
        assertEquals(listOf(4), ProcessTable.matching("sleeping", items).map { it.pid })
        assertEquals(listOf(4), ProcessTable.matching("4", items).map { it.pid })
        assertEquals(listOf(3, 2), ProcessTable.matching("steve running", items).map { it.pid })
        assertEquals(4, ProcessTable.matching(" ", items).size)
    }

    /** The order holds while the numbers move, for five seconds; a new sort or filter applies at once; newcomers go last meanwhile. */
    @Test fun theOrderHoldsForFiveSeconds() {
        val table = ProcessTable()
        val standard = ProcessTable.Sort.STANDARD
        assertEquals(listOf(1, 3, 4, 2), table.rows(items, "", standard, 100.0).map { it.process.pid })
        val busier = items.toMutableList()
        busier[3] = busier[3].copy(cpuPercent = 90.0)
        busier += process(9, "new", cpu = 99.0)
        assertEquals(listOf(1, 3, 4, 2, 9), table.rows(busier, "", standard, 103.0).map { it.process.pid })
        assertEquals("a process gone leaves", listOf(1, 4, 2, 9), table.rows(busier.drop(1), "", standard, 104.0).map { it.process.pid })
        assertEquals(listOf(9, 4, 1, 3, 2), table.rows(busier, "", standard, 105.0).map { it.process.pid })
        assertEquals(listOf(1, 2, 3, 4, 9), table.rows(busier, "", byPid, 106.0).map { it.process.pid })
        assertEquals(listOf(4), table.rows(busier, "sleeping", byPid, 106.5).map { it.process.pid })
    }

    @Test fun eachProcessKeepsAMinuteOfCpu() {
        val table = ProcessTable()
        for (second in 0 until 70) {
            table.record(systemMonitorSample(second * 1000.0, """[{"pid":7,"parentPid":1,"name":"a","user":null,"state":null,"cpuPercent":$second,"memoryBytes":1,"threads":null,"startedAt":null}]"""))
        }
        assertEquals(60, table.histories[7]?.size)
        assertEquals(10.0, table.histories[7]?.first())
        assertEquals(69.0, table.histories[7]?.last())
        // The same sample twice counts once; a process gone is forgotten.
        table.record(systemMonitorSample(69_000.0, "[]"))
        assertEquals(60, table.histories[7]?.size)
        table.record(systemMonitorSample(70_000.0, "[]"))
        assertNull(table.histories[7])
    }

    /** The feed keeps the histories and the screen keeps the order: rows take the feed's. */
    @Test fun rowsTakeTheFeedsHistories() {
        val shown = ProcessTable()
        val fresh = ProcessTable()
        fresh.record(systemMonitorSample(1.0))
        val rows = shown.rows(systemMonitorSample().processes!!.items, "", ProcessTable.Sort.STANDARD, 10.0, fresh.histories)
        assertEquals(listOf(12.5), rows.single().cpuHistory)
    }
}

/** A port of iOS's SystemMonitorFeedTests. */
class SystemMonitorFeedTest {
    private sealed interface Answer {
        data class Sample(val sample: SystemMonitorSample) : Answer
        data class Fail(val error: Exception) : Answer
    }

    private class Daemon {
        private val answers = ArrayList<Answer>()
        @Volatile var reads = 0
        @Volatile var kept: JsonObject? = null
        @Synchronized fun answer(list: List<Answer>) { answers.clear(); answers += list }
        @Synchronized fun read(): SystemMonitorSample {
            reads += 1
            val next = if (answers.size > 1) answers.removeAt(0) else answers.firstOrNull() ?: Answer.Fail(IOException("can't connect"))
            return when (next) {
                is Answer.Sample -> next.sample
                is Answer.Fail -> throw next.error
            }
        }
    }

    private val scopes = ArrayList<CoroutineScope>()

    @After fun tearDown() { scopes.forEach { it.cancel() } }

    private fun make(daemon: Daemon, kept: JsonObject? = null): Pair<SystemMonitorFeed, MutableList<SystemMonitorFeed.State>> {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        val feed = SystemMonitorFeed(
            scope = scope,
            fetch = { daemon.read() },
            keep = { daemon.kept = it },
            kept = { kept },
            sleep = { delay(5) },
        )
        val states = Collections.synchronizedList(ArrayList<SystemMonitorFeed.State>())
        scope.launch { feed.state.collect { states += it } }
        return feed to states
    }

    private fun eventually(condition: () -> Boolean) = runBlocking {
        withTimeout(3000) { while (!condition()) delay(5) }
    }

    @Test fun itReadsWhileResumedAndStopsWhenPaused() = runBlocking {
        val daemon = Daemon()
        daemon.answer(listOf(Answer.Sample(systemMonitorSample())))
        val (feed, _) = make(daemon)
        feed.resume()
        eventually { daemon.reads >= 3 }
        assertEquals(SystemMonitorFeed.Status.Ready, feed.state.value.status)
        assertEquals("build-box", feed.state.value.sample?.host?.hostname)
        feed.pause().join()
        eventually { daemon.kept != null }
        val paused = daemon.reads
        delay(80)
        assertEquals("nothing is read while paused", paused, daemon.reads)
        assertEquals("the last sample is written down", "build-box", daemon.kept?.get("host")?.jsonObject?.get("hostname")?.jsonPrimitive?.content)
        feed.resume()
        eventually { daemon.reads > paused }
    }

    @Test fun aComputerAwayKeepsTheLastSampleAndRetries() {
        val daemon = Daemon()
        daemon.answer(listOf(Answer.Fail(IOException("can't connect")), Answer.Sample(systemMonitorSample()), Answer.Fail(IOException("timed out"))))
        val (feed, states) = make(daemon)
        feed.resume()
        eventually { synchronized(states) { states.any { it.status == SystemMonitorFeed.Status.Loading && it.failed } } }
        eventually { feed.state.value.status == SystemMonitorFeed.Status.Reconnecting }
        assertTrue(feed.state.value.failed)
        assertEquals("build-box", feed.state.value.sample?.host?.hostname)
    }

    @Test fun aMissingOrUnsupportedMonitorStopsReading() = runBlocking {
        for ((code, status) in listOf(404 to SystemMonitorFeed.Status.Missing, 501 to SystemMonitorFeed.Status.Unsupported)) {
            val daemon = Daemon()
            daemon.answer(listOf(Answer.Fail(AgentApiException(code, null, null))))
            val (feed, _) = make(daemon)
            feed.resume()
            eventually { feed.state.value.status == status }
            delay(50)
            assertEquals(1, daemon.reads)
        }
    }

    @Test fun itOpensOnTheSampleKept() {
        val daemon = Daemon()
        daemon.answer(listOf(Answer.Fail(IOException("can't connect"))))
        val kept = AgentClient.json.parseToJsonElement(systemMonitorJson()).jsonObject
        val (feed, _) = make(daemon, kept)
        feed.resume()
        eventually { feed.state.value.sample != null }
        assertEquals(SystemMonitorFeed.Status.Reconnecting, feed.state.value.status)
    }
}
