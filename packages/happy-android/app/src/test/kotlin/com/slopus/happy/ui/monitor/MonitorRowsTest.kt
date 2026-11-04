package com.slopus.happy.ui.monitor

import android.content.Context
import android.content.res.Configuration
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.monitor.ProcessTable
import com.slopus.happy.monitor.SystemMonitorFeed
import com.slopus.happy.monitor.systemMonitorSample
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Locale

@RunWith(AndroidJUnit4::class)
class MonitorRowsTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private fun rows(state: SystemMonitorFeed.State, filter: String = "", locale: String = "en") = monitorRows(state, filter, ProcessTable.Sort.STANDARD, ProcessTable(),
        context.createConfigurationContext(Configuration(context.resources.configuration).apply { setLocale(Locale.forLanguageTag(locale)) }).resources, dark = false)

    @Test fun unavailableStopsAtTheExplanationInsteadOfShowingOldReadings() {
        val rows = rows(SystemMonitorFeed.State(systemMonitorSample(), SystemMonitorFeed.Status.Missing))
        assertEquals(listOf(MonitorRow.Note("unavailable", "This System Monitor is no longer available.")), rows)
    }

    @Test fun unknownReadingsStayAbsentAndDoNotCreateEmptyZeroMeters() {
        val sample = systemMonitorSample().let { it.copy(cpu = it.cpu.copy(temperatureCelsius = null), gpus = emptyList(), diskIo = null, memory = it.memory.copy(swapTotalBytes = null, swapUsedBytes = null)) }
        val rows = rows(SystemMonitorFeed.State(sample, SystemMonitorFeed.Status.Ready))
        assertEquals("—", (rows.first { it.key == "cpu:temperature" } as MonitorRow.Detail).value)
        assertEquals("—", (rows.first { it.key == "disk:read" } as MonitorRow.Detail).value)
        val swap = rows.first { it.key == "memory:swap" } as MonitorRow.Detail
        assertEquals("—", swap.value)
        assertTrue(!swap.meter)
        assertTrue((rows.first { it.key == "gpu:empty" } as MonitorRow.Detail).quiet)
    }

    @Test fun reconnectKeepsTheReadingsAndMarksTheProcessesAsLastSample() {
        val rows = rows(SystemMonitorFeed.State(systemMonitorSample(), SystemMonitorFeed.Status.Reconnecting, failed = true))
        assertEquals("26.1%", (rows.first { it.key == "cpu" } as MonitorRow.Summary).value)
        assertTrue((rows.first { it.key == "processes" } as MonitorRow.Heading).trailing!!.endsWith("Last sample"))
        assertTrue(rows.any { it.key == "unreachable" })
    }

    @Test fun filteringMatchesPidAndAccentedNamesAndKeepsTheFooterCount() {
        val sample = systemMonitorSample(processes = """[{"pid":1234,"name":"Nóde","user":"steve","cpuPercent":10,"memoryBytes":100}]""")
        assertEquals(listOf(1234), rows(SystemMonitorFeed.State(sample), "node 1234").filterIsInstance<MonitorRow.Process>().map { it.pid })
        val none = rows(SystemMonitorFeed.State(sample), "python")
        assertEquals("No matching processes", (none.first { it.key == "processes:empty" } as MonitorRow.Detail).label)
        assertTrue((none.first { it.key == "processes:footer" } as MonitorRow.Note).text.startsWith("0 of 123 sampled"))
    }

    @Test fun processAndThreadCountsUseTheConfiguredLanguagesPluralRules() {
        val original = systemMonitorSample()
        val sample = original.copy(processes = original.processes!!.copy(total = 21, threads = 22))
        assertEquals("21 процесс · 22 потока", (rows(SystemMonitorFeed.State(sample, SystemMonitorFeed.Status.Ready), locale = "ru")
            .first { it.key == "processes" } as MonitorRow.Heading).trailing)
    }
}