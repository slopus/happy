package com.slopus.happy.ui.monitor

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.testTag as semanticTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.monitor.MonitorLevel
import com.slopus.happy.ui.cards.CardBlock
import com.slopus.happy.ui.components.HomeCardPlace
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.connection.RowTile
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

/**
 * iOS MonitorSummaryLayout: 14 vertical/16 horizontal padding; a 30 tile
 * with a 17 glyph, 10 before 15 sp semibold name, 22 sp value at the end.
 * Subtitle is 8 below the tile, history 12 below that (72 high), per-core
 * bars 10 below history (28 high). Text grows with Android's font scale.
 */
@Composable
internal fun MonitorSummary(
    id: String,
    place: HomeCardPlace,
    title: String,
    value: String,
    subtitle: String,
    icon: Ionicon,
    tint: RowTile,
    lines: List<MonitorChartLine>?,
    bars: List<Double?>? = null,
) {
    val colors = HappyTheme.colors
    CardBlock(place, tag = "monitor.$id") {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(30.dp).clip(RoundedCornerShape(8.dp)).background(tint.fill(colors.dark)).testTag("monitor.$id.tile"), contentAlignment = Alignment.Center) {
                    Icon(icon, 17.dp, tint.ink(colors.dark))
                }
                Spacer(Modifier.width(10.dp))
                Text(title, style = happyTextStyle(15, 20, weight = FontWeight.SemiBold), color = colors.text,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).testTag("monitor.$id.title"))
                Spacer(Modifier.width(8.dp))
                Text(value, style = happyTextStyle(22, 27, weight = FontWeight.SemiBold), color = colors.text, maxLines = 1,
                    modifier = Modifier.testTag("monitor.$id.value"))
            }
            Text(subtitle, style = happyTextStyle(13, 16), color = colors.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 8.dp).testTag("monitor.$id.subtitle"))
            if (lines != null) {
                Spacer(Modifier.height(12.dp))
                MonitorChart(lines, "$title $value", Modifier.fillMaxWidth().height(72.dp).testTag("monitor.$id.chart"))
            }
            if (!bars.isNullOrEmpty()) {
                Spacer(Modifier.height(10.dp))
                MonitorCoreBars(bars, Modifier.fillMaxWidth().height(28.dp).testTag("monitor.$id.bars"))
            }
        }
    }
}

/** 40 minimum, 10 vertical padding; optional 4 dp meter 6 below, note 4 below. */
@Composable
internal fun MonitorDetail(
    id: String,
    place: HomeCardPlace,
    label: String,
    value: String,
    meter: Boolean = false,
    percent: Double? = null,
    note: String? = null,
    dot: Color? = null,
    quiet: Boolean = false,
) {
    val colors = HappyTheme.colors
    CardBlock(place, tag = "monitor.$id") {
        Column(Modifier.fillMaxWidth().heightIn(min = 40.dp).padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.Center) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (dot != null) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(dot))
                    Spacer(Modifier.width(6.dp))
                }
                Text(label, style = happyTextStyle(15, 20), color = if (quiet) colors.textSecondary else colors.text,
                    maxLines = if (quiet) Int.MAX_VALUE else 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (value.isNotEmpty()) {
                    Spacer(Modifier.width(8.dp))
                    Text(value, style = happyTextStyle(15, 20), color = colors.textSecondary, maxLines = 1)
                }
            }
            if (meter) {
                Spacer(Modifier.height(6.dp))
                MonitorMeter(percent, Modifier.fillMaxWidth().height(4.dp).testTag("monitor.$id.meter"))
            }
            if (note != null) {
                Text(note, style = happyTextStyle(13, 16), color = colors.textSecondary,
                    modifier = Modifier.padding(top = 4.dp).testTag("monitor.$id.note"))
            }
        }
    }
}

/** Unknown is an empty track; known readings clamp to 0–100, rounded 2 dp ends. */
@Composable
internal fun MonitorMeter(percent: Double?, modifier: Modifier = Modifier) {
    val dark = HappyTheme.colors.dark
    val fill = MonitorLevel.of(percent).ink(dark)
    val track = if (dark) Color(0xff38383c) else Color(0xffe6e6ea)
    Canvas(modifier) {
        val radius = CornerRadius(size.height / 2)
        drawRoundRect(track, cornerRadius = radius)
        val share = percent?.takeIf(Double::isFinite)?.coerceIn(0.0, 100.0)?.div(100)?.toFloat() ?: 0f
        if (share > 0f) drawRoundRect(fill, size = Size(size.width * share, size.height), cornerRadius = radius)
    }
}

/** iOS CardDrawing bars: 2 dp gaps, level colours, each core scaled to 100%. */
@Composable
internal fun MonitorCoreBars(values: List<Double?>, modifier: Modifier = Modifier) {
    val dark = HappyTheme.colors.dark
    val track = if (dark) Color(0xff38383c) else Color(0xffe6e6ea)
    Canvas(modifier) {
        if (values.isEmpty()) return@Canvas
        val gap = 2.dp.toPx()
        val width = ((size.width - gap * (values.size - 1)) / values.size).coerceAtLeast(0f)
        values.forEachIndexed { index, percent ->
            val x = index * (width + gap)
            drawRoundRect(track, Offset(x, 0f), Size(width, size.height), CornerRadius(1.dp.toPx()))
            val share = percent?.takeIf(Double::isFinite)?.coerceIn(0.0, 100.0)?.div(100)?.toFloat() ?: 0f
            if (share > 0) drawRoundRect(MonitorLevel.of(percent).ink(dark), Offset(x, size.height * (1 - share)), Size(width, size.height * share), CornerRadius(1.dp.toPx()))
        }
    }
}

/**
 * iOS MonitorProcessLayout: 10 vertical/16 horizontal padding, 44 minimum;
 * 15/20 name and CPU, 13/16 metadata and memory 2 below. CPU keeps a
 * fixed-width percentage column; its 44×16 spark is 8 before it.
 */
@Composable
internal fun MonitorProcess(
    id: Int,
    place: HomeCardPlace,
    name: String,
    cpu: String,
    memory: String,
    meta: String,
    history: List<Double?>,
    level: MonitorLevel,
    description: String,
) {
    val colors = HappyTheme.colors
    CardBlock(place, Modifier.clearAndSetSemantics {
        semanticTag = "monitor.process.$id"
        contentDescription = name
        stateDescription = description
    }, tag = "monitor.process.$id") {
        Column(Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(horizontal = 16.dp, vertical = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(name, style = happyTextStyle(15, 20), color = colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                val maximum = maxOf(1.0, history.filterNotNull().maxOrNull() ?: 0.0)
                MonitorChart(listOf(MonitorChartLine(history.map { it?.div(maximum) }, level.ink(colors.dark))), description,
                    Modifier.width(44.dp).height(16.dp).testTag("monitor.process.$id.spark"))
                Spacer(Modifier.width(8.dp))
                Box(contentAlignment = Alignment.CenterEnd) {
                    Text("100.0%", style = happyTextStyle(15, 20), color = Color.Transparent, modifier = Modifier.clearAndSetSemantics {})
                    Text(cpu, style = happyTextStyle(15, 20), color = colors.text)
                }
            }
            Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(meta, style = happyTextStyle(13, 16), color = colors.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                Text(memory, style = happyTextStyle(13, 16), color = colors.textSecondary, maxLines = 1)
            }
        }
    }
}

/** iOS MonitorHostLayout: 22 sp title, 13 sp status/meta, 14 vertical inset. */
@Composable
internal fun MonitorHost(title: String, meta: String, status: String, statusDescription: String, live: Boolean, loading: Boolean) {
    val colors = HappyTheme.colors
    val statusColor = if (live) RowTile.Green.ink(colors.dark) else colors.textSecondary
    CardBlock(HomeCardPlace(true, true), Modifier.clearAndSetSemantics {
        semanticTag = "monitor.host"
        contentDescription = title
        stateDescription = "$statusDescription, $meta"
    }, tag = "monitor.host") {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Text(title, style = happyTextStyle(22, 27, weight = FontWeight.SemiBold), color = colors.text, maxLines = 2,
                    overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                Row(Modifier.heightIn(min = 27.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(
                        if (live) statusColor else if (loading) colors.textSecondary else RowTile.Orange.ink(colors.dark)))
                    Spacer(Modifier.width(6.dp))
                    Text(status, style = happyTextStyle(13, 16), color = statusColor, maxLines = 1)
                }
            }
            Text(meta, style = happyTextStyle(13, 16), color = colors.textSecondary, maxLines = 2,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
        }
    }
}