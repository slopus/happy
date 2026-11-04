package com.slopus.happy.ui.monitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MonitorChartTest {
    @Test fun unavailableReadingsBreakLinesAndKeepTheirTimePositions() {
        val runs = chartRuns(listOf(.2, .4, null, .6, .8))
        assertEquals(listOf(listOf(ChartPoint(0f, .8f), ChartPoint(.25f, .6f)), listOf(ChartPoint(.75f, .4f), ChartPoint(1f, .2f))), runs)
    }

    @Test fun loneReadingsDoNotInventAHistory() {
        assertTrue(chartRuns(emptyList()).isEmpty())
        assertTrue(chartRuns(listOf(.5)).isEmpty())
        assertTrue(chartRuns(listOf(.5, null, .7)).isEmpty())
    }

    @Test fun valuesOutsideTheScaleClampAndNonfiniteValuesBreakTheLine() {
        assertEquals(listOf(listOf(ChartPoint(0f, 1f), ChartPoint(.25f, 0f)), listOf(ChartPoint(.75f, .5f), ChartPoint(1f, .25f))),
            chartRuns(listOf(-.5, 1.5, Double.NaN, .5, .75)))
    }
}