package com.slopus.happy.ui.usage

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.BackgroundTask
import com.slopus.happy.chat.BackgroundTaskKind
import com.slopus.happy.chat.BackgroundTaskStatus
import com.slopus.happy.chat.ContextUsage
import com.slopus.happy.chat.UsageLimits
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.BackgroundTaskTags
import com.slopus.happy.ui.chat.ChatComposer
import com.slopus.happy.ui.chat.ComposerInfoRow
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.chat.PrimaryAction
import com.slopus.happy.ui.components.OptionMenuTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * The context usage indicator and the background-task pill share the one row
 * above the composer card ([ComposerInfoRow]). Spec: the pill at the start,
 * on the card's left edge; the week figure and then "N% context" 5 before a
 * 14 gauge at the end, the gauge's right edge on Send's; the row is at least
 * 32 high and 8 above the card. Tapping the context opens its detail popup
 * (percent left, used / window and the token breakdown); tapping the week
 * opens the Session/Week popup. With neither tasks nor usage there is no row.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class UsageRowLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private val week = UsageLimits(
        1.0,
        listOf(UsageLimits.Window("five_hour", utilization = 32.0), UsageLimits.Window("seven_day", utilization = 61.0)),
    )

    private val running = BackgroundTask(
        id = "call:1", kind = BackgroundTaskKind.Command, title = "Build the app", command = "npm run build",
        startedAt = 1_000, status = BackgroundTaskStatus.Running,
    )
    private val runningSecond = BackgroundTask(
        id = "call:2", kind = BackgroundTaskKind.Subagent, title = "Research the API", startedAt = 2_000,
        status = BackgroundTaskStatus.Running,
    )

    private fun setComposer(
        usage: ContextUsage?,
        limits: UsageLimits? = week,
        display: UsageDisplay = UsageDisplay(),
        tasks: List<BackgroundTask> = emptyList(),
    ) {
        rule.setHappyContent {
            CompositionLocalProvider(LocalUsageDisplay provides display) {
                Column(Modifier.fillMaxSize()) {
                    Spacer(Modifier.weight(1f))
                    ChatComposer(
                        text = "",
                        onTextChange = {},
                        status = null,
                        primary = PrimaryAction.Idle,
                        onPrimary = {},
                        above = { ComposerInfoRow(tasks, usage, limits, "s1") },
                    )
                }
            }
        }
    }

    @Test
    fun theRowSitsAboveTheCardWithTheGaugeOnSendsEdge() {
        setComposer(ContextUsage(0, 0, 0, 0, contextSize = 185_000, contextWindow = 200_000))
        val panel = rule.node(ComposerTags.PANEL).bounds
        val row = rule.node(UsageRowTags.ROW).bounds
        assertDp("the row ends at the card", 0, row.bottom - panel.top)
        val gauge = rule.node(UsageRowTags.GAUGE).bounds
        assertDp("the gauge is 14 wide", 14, gauge.right - gauge.left)
        assertDp("the gauge ends on Send's right edge", 0, gauge.right - rule.node(ComposerTags.PRIMARY).bounds.right)
        val text = rule.node(UsageRowTags.CONTEXT_TEXT).bounds
        assertDp("5 before the gauge", 5, gauge.left - text.right)
        val weekText = rule.node(UsageRowTags.WEEK).bounds
        assertDp("10 between week and context", 10, text.left - weekText.right)
        rule.onNode(hasText("93% context"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("61% week"), useUnmergedTree = true).assertExists()
    }

    @Test
    fun thePillAndTheUsageShareOneRowPillLeftUsageRight() {
        setComposer(
            ContextUsage(0, 0, 0, 0, contextSize = 185_000, contextWindow = 200_000),
            tasks = listOf(running, runningSecond),
        )
        val panel = rule.node(ComposerTags.PANEL).bounds
        val chip = rule.node(BackgroundTaskTags.CHIP).bounds
        val gauge = rule.node(UsageRowTags.GAUGE).bounds
        assertDp("the pill starts on the card's left edge", 0, chip.left - panel.left)
        assertDp("the gauge ends on Send's right edge", 0, gauge.right - rule.node(ComposerTags.PRIMARY).bounds.right)
        assertTrue("the pill and the usage are one row", chip.top < gauge.bottom && gauge.top < chip.bottom)
        assertDp("8 above the card", 8, panel.top - chip.bottom)
        rule.onNode(hasText("2 running"), useUnmergedTree = true).assertExists()
    }

    @Test
    fun withNoTasksTheUsageStillShowsAtTheEnd() {
        setComposer(ContextUsage(0, 0, 0, 0, contextSize = 40_000, contextWindow = 200_000))
        rule.node(BackgroundTaskTags.CHIP).assertDoesNotExist()
        rule.node(UsageRowTags.ROW).assertExists()
        assertDp("the gauge ends on Send's right edge", 0, rule.node(UsageRowTags.GAUGE).bounds.right - rule.node(ComposerTags.PRIMARY).bounds.right)
    }

    @Test
    fun withOnlyTasksThePillShowsOnTheLeft() {
        setComposer(null, limits = null, tasks = listOf(running))
        rule.node(UsageRowTags.ROW).assertExists()
        rule.node(BackgroundTaskTags.CHIP).assertExists()
        rule.node(UsageRowTags.CONTEXT).assertDoesNotExist()
        rule.node(UsageRowTags.WEEK).assertDoesNotExist()
    }

    @Test
    fun withNeitherTasksNorUsageThereIsNoRow() {
        setComposer(null, limits = null)
        rule.node(UsageRowTags.ROW).assertDoesNotExist()
        val panel = rule.node(ComposerTags.PANEL).bounds
        assertDp("the composer ends 8 under the card", 8, rule.node(ComposerTags.COMPOSER).bounds.bottom - panel.bottom)
    }

    @Test
    fun tappingTheContextOpensTheWindowDetails() {
        setComposer(
            ContextUsage(12_000, 4_000, 8_000, 60_000, contextSize = 80_000, contextWindow = 200_000, model = "claude-sonnet-4-5"),
        )
        rule.node(UsageRowTags.CONTEXT_TEXT).assertTextEquals("40% context")
        rule.node(UsageRowTags.CONTEXT).performClick()
        rule.node(UsageRowTags.CONTEXT_DETAIL).assertExists()
        rule.onNode(hasText("60% left"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("80k / 200k context"), useUnmergedTree = true).assertExists()
        rule.node(UsageRowTags.contextDetail("input")).assertExists()
        rule.node(UsageRowTags.contextDetail("cacheRead")).assertExists()
        rule.node(UsageRowTags.contextDetail("cacheCreation")).assertExists()
        rule.node(UsageRowTags.contextDetail("output")).assertExists()
        rule.onNode(hasText("12k"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("60k"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("8k"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("4k"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("claude-sonnet-4-5"), useUnmergedTree = true).assertExists()
    }

    @Test
    fun unknownWindowShowsTheTokenCountAndSaysTheWindowIsUnknown() {
        setComposer(ContextUsage(0, 0, 0, 0, contextSize = 150_000, contextWindow = null))
        rule.node(UsageRowTags.CONTEXT_TEXT).assertTextEquals("150k tokens")
        rule.node(UsageRowTags.CONTEXT).performClick()
        rule.node(UsageRowTags.CONTEXT_TOKENS).assertTextEquals("150k tokens")
        rule.node(UsageRowTags.CONTEXT_PERCENT_LEFT).assertDoesNotExist()
        rule.onNode(hasText("Window unknown"), useUnmergedTree = true).assertExists()
    }

    @Test
    fun tappingTheWeekOpensSessionAndWeek() {
        setComposer(null, display = UsageDisplay(alwaysShowContextSize = true, showRemaining = true))
        rule.onNode(hasText("39% week"), useUnmergedTree = true).assertExists()
        rule.node(UsageRowTags.WEEK).performClick()
        rule.node(OptionMenuTags.item("usage", "session")).assertExists()
        rule.onNode(hasText("Session · 68%"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("Week · 39%"), useUnmergedTree = true).assertExists()
    }

    @Test
    fun plentyOfContextShowsByDefault() {
        setComposer(ContextUsage(0, 0, 0, 0, contextSize = 20_000, contextWindow = 200_000))
        rule.onNode(hasText("10% context"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("61% week"), useUnmergedTree = true).assertExists()
    }

    @Test
    fun plentyOfContextShowsNothingWhenTurnedOff() {
        setComposer(
            ContextUsage(0, 0, 0, 0, contextSize = 20_000, contextWindow = 200_000),
            display = UsageDisplay(alwaysShowContextSize = false),
        )
        rule.node(UsageRowTags.ROW).assertDoesNotExist()
        val panel = rule.node(ComposerTags.PANEL).bounds
        assertDp("the composer ends 8 under the card", 8, rule.node(ComposerTags.COMPOSER).bounds.bottom - panel.bottom)
    }

    @Test
    fun alwaysShowingUsesTheSecondaryColourAndNoWeekWithoutLimits() {
        setComposer(ContextUsage(0, 0, 0, 0, contextSize = 20_000, contextWindow = 200_000), limits = null, display = UsageDisplay(alwaysShowContextSize = true))
        rule.onNode(hasText("10% context"), useUnmergedTree = true).assertExists()
        rule.node(UsageRowTags.WEEK).assertDoesNotExist()
    }
}
