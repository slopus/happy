package com.slopus.happy.ui.usage

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.chat.ContextUsage
import com.slopus.happy.chat.UsageLimits
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.chat.ChatComposer
import com.slopus.happy.ui.chat.ComposerTags
import com.slopus.happy.ui.chat.PrimaryAction
import com.slopus.happy.ui.components.OptionMenuTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * AgentInputUsageRow under the composer card. Spec: right-aligned 18 in
 * from the composer's inner edge (8 + 18 = 26 from the screen edge), 6
 * below the card, at least 18 high; "N% week" then, 10 apart, "N% context"
 * 5 before a 14 gauge. Tapping the context swaps in "used / total
 * context"; tapping the week opens the Session/Week popup. Nothing shows
 * with plenty of context left unless `alwaysShowContextSize`.
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

    private fun setComposer(usage: ContextUsage?, limits: UsageLimits? = week, display: UsageDisplay = UsageDisplay()) {
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
                        bottom = { ComposerUsageRow(usage, limits) },
                    )
                }
            }
        }
    }

    @Test
    fun nearTheLimitTheRowSitsUnderTheCard() {
        setComposer(ContextUsage(0, 0, 0, 0, contextSize = 185_000, contextWindow = 200_000))
        val panel = rule.node(ComposerTags.PANEL).bounds
        val row = rule.node(UsageRowTags.ROW).bounds
        assertDp("the row starts at the card", 0, row.top - panel.bottom)
        assertDp("8 under the row (the composer's padding)", 8, rule.node(ComposerTags.COMPOSER).bounds.bottom - row.bottom)
        val gauge = rule.node(UsageRowTags.GAUGE).bounds
        assertBox("gauge", gauge, 411.dp - 26.dp - 14.dp, gauge.top, 14.dp, 14.dp)
        val text = rule.node(UsageRowTags.CONTEXT_TEXT).bounds
        assertDp("5 before the gauge", 5, gauge.left - text.right)
        assertDp("content 6 below the card", 6, minOf(text.top, gauge.top) - panel.bottom)
        val weekText = rule.node(UsageRowTags.WEEK).bounds
        assertDp("10 between week and context", 10, text.left - weekText.right)
        rule.onNode(hasText("93% context"), useUnmergedTree = true).assertExists()
        rule.onNode(hasText("61% week"), useUnmergedTree = true).assertExists()
    }

    @Test
    fun tappingTheContextShowsExactCounts() {
        setComposer(ContextUsage(0, 0, 0, 0, contextSize = 192_400, contextWindow = 200_000))
        rule.node(UsageRowTags.CONTEXT).performClick()
        rule.onNode(hasText("192k / 200k context"), useUnmergedTree = true).assertExists()
        rule.node(UsageRowTags.CONTEXT).performClick()
        rule.onNode(hasText("96% context"), useUnmergedTree = true).assertExists()
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
    fun plentyOfContextShowsNothing() {
        setComposer(ContextUsage(0, 0, 0, 0, contextSize = 20_000, contextWindow = 200_000))
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
