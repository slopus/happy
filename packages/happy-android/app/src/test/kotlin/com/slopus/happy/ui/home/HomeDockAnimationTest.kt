package com.slopus.happy.ui.home

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.HomeModelFixtures.cliAvailability
import com.slopus.happy.model.HomeModelFixtures.machine
import com.slopus.happy.model.HomeModelFixtures.machineMetadata
import com.slopus.happy.model.NewSessionDraft
import com.slopus.happy.model.NewSessionLabels
import com.slopus.happy.model.resolveNewSessionOptions
import com.slopus.happy.model.settings.AgentDefaultOverrides
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs
import kotlin.math.pow

/**
 * The composer opening and closing, frame by frame on the paused clock,
 * against HomeDock.tsx's focusPresentation (openFocusMode, closeFocusMode,
 * focusedComposerAnimationStyle and the two reveal styles):
 * - Opening waits a 16 ms timer, then runs 0→1 in 340 ms with
 *   Easing.out(Easing.cubic).
 * - The shell is 56 high at 0 and the composer's height at 1, with the
 *   composer anchored to its bottom; it is 0.96 wide at 0.
 * - The input rises 8 into place over 22-60%, the action row 7 over 46-82%.
 * - Closing runs 1→0 in 180 ms with Easing.in(Easing.cubic), and only then
 *   hands the dock back.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HomeDockAnimationTest {
    @get:Rule
    val rule = createComposeRule()

    private val focusChanges = mutableListOf<Boolean>()

    private val studio = machine("m1", machineMetadata { put("displayName", "Studio"); cliAvailability(claude = true) })
    private val state = HomeDockState(
        prompt = "",
        options = resolveNewSessionOptions(NewSessionDraft(selectedMachineId = "m1"), listOf(studio), emptyList(), AgentDefaultOverrides()),
        labels = NewSessionLabels(),
        phase = null,
        focused = true,
    )
    private val actions = HomeDockActions(
        onPromptChange = {}, onFocusChange = { focusChanges += it }, onSubmit = {}, onCancel = {}, onSelect = { _, _ -> },
        onOpenPicker = {}, onHarnessHelp = {}, onAddImage = {}, onRemoveImage = {},
    )

    /** One frame's composer: the shell's height and bottom, and where the input and action row are drawn. */
    private data class Frame(val time: Long, val shell: Dp, val bottom: Dp, val inputTop: Dp, val sendTop: Dp, val rowLeft: Dp, val centre: Dp)

    private fun frame(): Frame {
        val composer = rule.node(HomeDockTags.COMPOSER).bounds
        val input = rule.node(HomeDockTags.INPUT).bounds
        // The row's own bounds sit outside its reveal layer; the send button inside it moves with it.
        val send = rule.node(HomeDockTags.PRIMARY).bounds
        val row = rule.node(HomeDockTags.ACTION_ROW).bounds
        // Bounds in root carry a layer's offset but not its scale: the row's start shows the shell's width.
        val centre = (composer.left + composer.right) / 2
        return Frame(rule.mainClock.currentTime, composer.bottom - composer.top, composer.bottom, input.top, send.top, row.left, centre)
    }

    private fun reveal(p: Float, start: Float, end: Float) = ((p - start) / (end - start)).coerceIn(0f, 1f)

    /** Each frame is where focusPresentation [p] puts it, against the settled composer [full]. */
    private fun assertFrameAt(p: Float, f: Frame, full: Frame) {
        val shell = 56.dp + (full.shell - 56.dp) * p
        assertTrue("shell at $p: $shell, was ${f.shell}", abs((f.shell - shell).value) <= 1f)
        assertTrue("anchored to its bottom", abs((f.bottom - full.bottom).value) <= 0.5f)
        val inputDrop = 8.dp * (1 - reveal(p, 0.22f, 0.6f))
        val inputAt = f.bottom - (full.bottom - full.inputTop) + inputDrop
        assertTrue("input at $p: $inputAt, was ${f.inputTop}", abs((f.inputTop - inputAt).value) <= 1f)
        val rowDrop = 7.dp * (1 - reveal(p, 0.46f, 0.82f))
        val rowAt = f.bottom - (full.bottom - full.sendTop) + rowDrop
        assertTrue("action row at $p: $rowAt, was ${f.sendTop}", abs((f.sendTop - rowAt).value) <= 1f)
        val left = full.centre - (full.centre - full.rowLeft) * (0.96f + 0.04f * p)
        assertTrue("action row start at $p: $left, was ${f.rowLeft}", abs((f.rowLeft - left).value) <= 1f)
    }

    /** The presentation a frame shows, read off the shell's height. */
    private fun presentation(f: Frame, full: Frame) = (f.shell - 56.dp) / (full.shell - 56.dp)

    /**
     * The frame the animation took as its start: of the frames up to the first
     * visible move, the one [curve] fits best (an ease-in barely moves at first).
     */
    private fun startOf(frames: List<Frame>, full: Frame, firstMove: Int, curve: (Long) -> Float): Long =
        frames.take(firstMove).map { it.time }.minBy { start ->
            frames.maxOf { f -> abs(presentation(f, full) - curve(f.time - start)) }
        }

    private fun open(): List<Frame> {
        rule.mainClock.autoAdvance = false
        rule.setHappyContent { HomeDockFocus(state, actions) }
        val frames = mutableListOf(frame())
        repeat(30) {
            rule.mainClock.advanceTimeByFrame()
            frames += frame()
        }
        return frames
    }

    @Test
    fun opensFromTheRestingCapsuleOver340msOutCubic() {
        val frames = open()
        val full = frames.last()
        assertEquals("settled: 8 + 44 + 42 + 8", 102f, full.shell.value, 0.5f)
        assertEquals("starts at the resting capsule's 56", 56f, frames.first().shell.value, 0.5f)

        val moving = frames.indexOfFirst { it.shell > 56.5.dp }
        assertTrue("the 16 ms timer: still closed a frame in", moving >= 2)
        val curve = { elapsed: Long -> 1 - (1 - (elapsed / 340f).coerceIn(0f, 1f)).pow(3) }
        val start = startOf(frames, full, moving, curve)
        frames.forEach { f -> assertFrameAt(curve(f.time - start), f, full) }
        // Out-cubic settles to the pixel well before its end, so the middle pins the length.
        val middle = frames.minBy { abs(it.time - start - 170) }
        assertEquals("half the time, 87.5% open", 0.875f, curve(middle.time - start), 0.03f)
        assertEquals("and the shell shows it", 0.875f, presentation(middle, full), 0.03f)
    }

    @Test
    fun closesOver180msInCubicThenHandsTheDockBack() {
        val full = open().last()
        rule.node(HomeDockTags.BACKDROP).performClick()
        val frames = mutableListOf(frame())
        repeat(16) {
            rule.mainClock.advanceTimeByFrame()
            frames += frame()
        }
        val moving = frames.indexOfFirst { it.shell < full.shell - 0.5.dp }
        val curve = { elapsed: Long -> 1 - (elapsed / 180f).coerceIn(0f, 1f).pow(3) }
        val start = startOf(frames, full, moving, curve)
        frames.forEach { f -> assertFrameAt(curve(f.time - start), f, full) }
        val closed = frames.indexOfFirst { presentation(it, full) < 0.01f }
        assertTrue("closed by 180 ms", frames[closed].time - start in 170..200)
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeByFrame()
        assertEquals("handed back once the shell is the capsule again", listOf(false), focusChanges)
    }

    @Test
    fun theDockStaysOpenWhileItCloses() {
        open()
        rule.node(HomeDockTags.BACKDROP).performClick()
        rule.mainClock.advanceTimeBy(96)
        assertEquals("half-way through closing", emptyList<Boolean>(), focusChanges)
    }
}
