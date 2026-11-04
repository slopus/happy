package com.slopus.happy.ui.monitor

import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.monitor.MonitorLevel
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MonitorCardsTest {
    @get:Rule val rule = createComposeRule()

    @Test fun readingAlignsItsTileHistoryAndCoresToTheCardContent() {
        rule.setHappyContent {
            MonitorSummary("cpu", HomeCardPlace(true, false), "CPU", "26.1%", "Apple M3 Max", Ionicon.HardwareChipOutline,
                RowTile.Blue, emptyList(), listOf(26.1, 61.0))
        }
        assertBox("tile", rule.node("monitor.cpu.tile").bounds, 32.dp, 14.dp, 30.dp, 30.dp)
        assertDp("name starts after tile and gap", 72, rule.node("monitor.cpu.title").bounds.left)
        assertDp("value ends on content edge", 379, rule.node("monitor.cpu.value").bounds.right)
        assertBox("history", rule.node("monitor.cpu.chart").bounds, 32.dp, 80.dp, 347.dp, 72.dp)
        assertBox("cores", rule.node("monitor.cpu.bars").bounds, 32.dp, 162.dp, 347.dp, 28.dp)
        assertDp("reading card", 204, rule.node("monitor.cpu.body").bounds.height)
    }

    @Test fun detailsGrowForMetersAndNotesWithoutShrinkingTheirLine() {
        rule.setHappyContent {
            MonitorDetail("volume", HomeCardPlace(false, true), "/", "128 GB free", meter = true, percent = 60.0, note = "APFS · 1 TB")
        }
        assertBox("meter", rule.node("monitor.volume.meter").bounds, 32.dp, 36.dp, 347.dp, 4.dp)
        assertDp("detail card", 70, rule.node("monitor.volume.body").bounds.height)
    }

    @Test fun processesKeepTheSparkInAColumnBeforeCpu() {
        rule.setHappyContent {
            Column {
                MonitorProcess(1, HomeCardPlace(true, false), "Happy Agent", "26.1%", "512 MB", "PID 1 · steve", listOf(1.0, 26.1), MonitorLevel.Calm, "CPU 26.1%")
                MonitorProcess(2, HomeCardPlace(false, true), "A longer name", "1.0%", "32 MB", "PID 2 · steve", listOf(2.0, 1.0), MonitorLevel.Calm, "CPU 1.0%")
            }
        }
        assertDp("process height", 58, rule.node("monitor.process.1.body").bounds.height)
        assertDp("spark width", 44, rule.node("monitor.process.1.spark").bounds.width)
        assertDp("same spark column", rule.node("monitor.process.1.spark").bounds.left, rule.node("monitor.process.2.spark").bounds.left)
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun monitorUsesTheTabletReadableColumn() {
        rule.setHappyContent {
            ProvideWindowLayout { MonitorHost("Kirill’s Mac Mini", "macOS · arm64 · Uptime 3d 4h", "Live", "Live", live = true, loading = false) }
        }
        assertDp("tablet edge", 256, rule.node("monitor.host.body").bounds.left)
        assertDp("tablet card", 768, rule.node("monitor.host.body").bounds.width)
    }
}