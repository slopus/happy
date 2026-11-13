package com.slopus.happy.ui.genui

import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import coil3.ImageLoader
import com.slopus.happy.genui.GenUi
import com.slopus.happy.genui.RenderDocument
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.components.LocalImageLoader
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Gen UI blocks as rows of a lazy list, as the chat draws them: a row's
 * first frame is its final height, a row scrolled away and back keeps its
 * height and its choices, and scrolling never measures a row again.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GenUiLazyListTest {
    @get:Rule val rule = createComposeRule()

    private val fixtures: List<Pair<String, RenderDocument>> =
        File("src/debug/assets/genui/fixtures").listFiles { f -> f.extension == "json" }.orEmpty().sortedBy { it.name }.map { it.nameWithoutExtension to GenUi.parse(it.readText()) }

    /** Pictures that never arrive: what a row has before any of its files are read. */
    private val pending = GenUiHost(cached = { null }, load = { kotlinx.coroutines.awaitCancellation() })

    private fun list(rows: List<RenderDocument>, states: List<GenUiState>, measured: IntArray, host: GenUiHost = pending): LazyListState {
        lateinit var state: LazyListState
        val pictures = ImageLoader.Builder(ApplicationProvider.getApplicationContext()).build()
        rule.setHappyContent {
            state = rememberLazyListState()
            CompositionLocalProvider(LocalImageLoader provides pictures) {
                LazyColumn(Modifier.fillMaxSize(), state) {
                    itemsIndexed(rows) { i, doc ->
                        GenUiView(
                            doc,
                            Modifier.testTag("row$i").layout { m, c -> measured[i]++; m.measure(c).let { p -> layout(p.width, p.height) { p.place(0, 0) } } },
                            host,
                            states[i],
                        )
                    }
                }
            }
        }
        rule.waitForIdle()
        return state
    }

    @Test fun eachFixturesFirstFrameIsItsHeight() {
        val pictures = ImageLoader.Builder(ApplicationProvider.getApplicationContext()).build()
        val png = File("src/debug/assets/genui/assets/coast.jpg").readBytes()
        // Pictures arrive a few frames after the row first shows, as they do from the computer.
        val host = GenUiHost(cached = { null }, load = { kotlinx.coroutines.delay(100); png })
        var shown by mutableIntStateOf(0)
        val first = IntArray(fixtures.size) { -1 }
        val last = IntArray(fixtures.size) { -1 }
        rule.setHappyContent {
            CompositionLocalProvider(LocalImageLoader provides pictures) {
                val i = shown
                key(i) {
                LazyColumn(Modifier.fillMaxSize()) {
                    item {
                        GenUiView(
                            fixtures[i].second,
                            Modifier.layout { m, c -> m.measure(c).let { p -> if (first[i] < 0) first[i] = p.height; last[i] = p.height; layout(p.width, p.height) { p.place(0, 0) } } },
                            host,
                        )
                    }
                }
                }
            }
        }
        for (i in fixtures.indices) {
            rule.runOnIdle { shown = i }
            repeat(8) { Thread.sleep(50); rule.waitForIdle() }
            assertTrue("${fixtures[i].first} measured", first[i] > 0)
            assertEquals("${fixtures[i].first}: its first frame is its height", first[i], last[i])
        }
    }

    @Test fun aRowScrolledAwayAndBackKeepsItsHeightAndChoice() {
        val choices = fixtures.first { it.first == "10-choices" }.second
        val rows = List(30) { choices }
        val states = List(30) { GenUiState() }
        val measured = IntArray(30)
        val list = list(rows, states, measured)
        val before = rule.node("row0").fetchSemanticsNode().size.height
        rule.onNode(hasText("Add a retry", substring = true) and hasAnyAncestor(hasTestTag("row0"))).performClick()
        rule.onNode(hasText("Fix the race", substring = true) and hasAnyAncestor(hasTestTag("row0"))).assertIsNotEnabled()
        rule.onNode(hasText("Fix the race", substring = true) and hasAnyAncestor(hasTestTag("row1"))).assertIsEnabled()
        rule.runOnIdle { runBlocking { list.scrollToItem(29) } }
        rule.waitForIdle()
        rule.node("row0").assertDoesNotExist()
        rule.runOnIdle { runBlocking { list.scrollToItem(0) } }
        rule.waitForIdle()
        assertEquals(before, rule.node("row0").fetchSemanticsNode().size.height)
        rule.onNode(hasText("Fix the race", substring = true) and hasAnyAncestor(hasTestTag("row0"))).assertIsNotEnabled()
    }

    @Test fun scrollingThroughManyBlocksMeasuresEachOnce() {
        val docs = fixtures.map { it.second }
        val rows = List(100) { docs[it % docs.size] }
        val states = List(100) { GenUiState() }
        val measured = IntArray(100)
        val list = list(rows, states, measured)
        // Small steps, as a finger moves: every frame shifts rows that stay on screen.
        repeat(1500) {
            rule.runOnIdle { runBlocking { list.scrollBy(80f) } }
        }
        rule.waitForIdle()
        val reached = list.firstVisibleItemIndex
        assertTrue("scrolled far: $reached", reached > 60)
        val shown = (0..reached).count { measured[it] > 0 }
        println("rows reached $reached, measured ${measured.take(reached + 1)}")
        // A row is measured when it comes in (and once more if prefetch measured it first); never per frame.
        assertTrue("re-measured while scrolling: ${measured.take(reached + 1)}", (0..reached).all { measured[it] <= 2 })
        assertEquals(reached + 1, shown)
    }
}
