package com.slopus.happy.ui.connection

import androidx.compose.ui.test.assert
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.ActivityDay
import com.slopus.happy.agent.DailyUsage
import com.slopus.happy.agent.UsageAccount
import com.slopus.happy.agent.activityLevels
import com.slopus.happy.conversation.AccountUsage
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale

/** Settings › Usage, desktop's (HappyAgentUsageSettings, UsageActivityGrid). */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class AgentUsageTest {
    @get:Rule val rule = createComposeRule()

    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject

    @Test
    fun theDailyHistoryIsSparseAndCountsNoCacheReads() {
        val history = DailyUsage.parse(
            json(
                """{"since":"2026-11-01","days":[
                  {"date":"2026-11-03","byProvider":{"claude":{"opus":{"input":100,"output":20,"cacheRead":9000,"cacheWrite":30}},"codex":{"gpt-5":{"input":50,"output":0,"cacheRead":0,"cacheWrite":0}}}},
                  {"date":"2026-10-30","byProvider":{"claude":{"opus":{"input":999}}}},
                  {"date":"2026-11-01","byProvider":{"claude":{"opus":{"input":10}}}}
                ]}""",
            ),
        )!!
        // A day before `since` is dropped; the rest are oldest first.
        assertEquals(listOf(LocalDate.of(2026, 11, 1), LocalDate.of(2026, 11, 3)), history.days.map { it.date })
        val days = history.activity(LocalDate.of(2026, 10, 20), LocalDate.of(2026, 11, 4))
        // Nothing before `since`, and the unlisted days are zeros through today.
        assertEquals(LocalDate.of(2026, 11, 1), days.first().date)
        assertEquals(listOf(10L, 0L, 200L, 0L), days.map { it.tokens })
        assertEquals(listOf("opus" to 150L, "gpt-5" to 50L), days[2].models)
        assertEquals(listOf(10L, 0L, 150L, 0L), history.activity(LocalDate.of(2026, 10, 20), LocalDate.of(2026, 11, 4), "claude").map { it.tokens })
        assertEquals(mapOf("claude" to 160L, "codex" to 50L), history.accountTokens())
        // No `since`: no history at all.
        assertNull(DailyUsage.parse(json("""{"days":[]}""")))
    }

    @Test
    fun levelsAreQuartilesOfTheDaysThatSpent() {
        fun day(tokens: Long) = ActivityDay(LocalDate.of(2026, 1, 1), tokens, emptyList())
        val days = listOf(0L, 1L, 2L, 3L, 4L, 5L, 6L, 7L, 8L).map(::day)
        val level = activityLevels(days)
        assertEquals(listOf(0, 1, 1, 1, 2, 2, 3, 3, 4), days.map { level(it.tokens) })
        assertEquals(0, activityLevels(listOf(day(0)))(0))
    }

    @Test
    fun tokensReadAsDesktopsCompactNumbers() {
        assertEquals(
            listOf("950", "1.2K", "505K", "696.8K", "2M", "11.6M", "736.2M", "1.4B", "1M"),
            listOf(950L, 1_234L, 505_000L, 696_800L, 2_000_000L, 11_600_000L, 736_200_000L, 1_400_000_000L, 999_960L).map { usageTokens(it, Locale.US) },
        )
    }

    /** Errors are dropped and an account with nothing to show is left out; the rest group by service, most used first. */
    @Test
    fun onlyWhatExistsIsShownMostUsedFirst() {
        val accounts = UsageFixtures.accounts
        val grok = accounts.first { it.providerId == "grok" }
        assertNull(grok.limits)
        assertTrue(grok.models.isEmpty())
        val vendors = usageVendors(accounts, UsageFixtures.history)
        assertEquals(listOf("claude", "codex", "bedrock"), vendors.map { it.type })
        assertEquals(listOf("claude-max", "claude-team"), vendors[0].accounts.map { it.providerId })
        // Without a history, the server's order.
        assertEquals(listOf("claude", "codex", "bedrock"), usageVendors(accounts, null).map { it.type })
        val codex = accounts.first { it.providerId == "codex" }
        assertEquals(listOf("gpt-5-codex", "gpt-5"), codex.models.map { it.modelId })
        assertEquals(78, codex.limits!!.week!!.left)
    }

    private fun show(state: AgentUsageState = UsageFixtures.ready) = rule.setHappyContent {
        AgentUsageScreen(state, onBack = {}, now = UsageFixtures.now, today = UsageFixtures.today)
    }

    @Test
    fun thePageHasTheYearThenEachVendorsAccounts() {
        show()
        rule.onNodeWithText("ACTIVITY").assertExists()
        rule.onNodeWithText("tokens in the last year", substring = true).assertExists()
        rule.onNodeWithText("CLAUDE").assertExists()
        rule.onNodeWithText("CODEX").assertExists()
        rule.onNodeWithText("BEDROCK").assertExists()
        rule.onNodeWithText("GROK").assertDoesNotExist()
        rule.onNodeWithText("Unauthorized", substring = true).assertDoesNotExist()
        rule.onNodeWithText("Signed out").assertDoesNotExist()
        rule.onNodeWithText("Claude Max").assertExists()
        rule.onNodeWithText("Max 20x").assertExists()
        rule.node(AgentUsageTags.strip("claude-max")).assertExists()
        rule.node(AgentUsageTags.limit("claude-max", AccountUsage.Window.Kind.Week)).assert(hasAnyDescendant(hasText("27% left")))
        rule.node(AgentUsageTags.limit("claude-max", AccountUsage.Window.Kind.Session)).assert(hasAnyDescendant(hasText("59% left")))
        rule.onNodeWithText("Updated 4 min ago").assertExists()
        rule.node(AgentUsageTags.model("claude-max", "claude-opus-4-1")).assert(hasAnyDescendant(hasText("day", substring = true)))
        // Bedrock has no plan: its models alone.
        rule.node(AgentUsageTags.limit("bedrock", AccountUsage.Window.Kind.Week)).assertDoesNotExist()
        rule.node(AgentUsageTags.model("bedrock", "anthropic.claude-sonnet-4")).assertExists()
    }

    /** Desktop's geometry: 10 cells on a 12 pitch, a week a column, Monday on top, opened at today. */
    @Test
    fun theYearIsWeeksOfTenDpCells() {
        show()
        val days = UsageFixtures.history.activity(UsageFixtures.today.minusDays(DailyUsage.YEAR_DAYS), UsageFixtures.today)
        // Nov 12 2025, a Wednesday, to today: 365 days from the third row, 53 columns.
        assertEquals(LocalDate.of(2025, 11, 12), days.first().date)
        assertEquals(365, days.size)
        val grid = rule.onNodeWithContentDescription("Tokens used each day").fetchSemanticsNode()
        val density = grid.layoutInfo.density.density
        assertEquals("7 rows", (7 * 12 - 2) * density, grid.size.height.toFloat(), 1f)
        assertEquals("53 weeks", (53 * 12 - 2) * density, grid.size.width.toFloat(), 1f)
        // Wider than the phone: it opens on today, its right edge at the card's.
        val card = rule.node(AgentUsageTags.ACTIVITY).bounds
        assertDp("today's week at the end", card.right - 4.dp - 12.dp - 16.dp, rule.onNodeWithContentDescription("Tokens used each day").bounds.right)
        rule.onNodeWithText("Mon").assertExists()
        rule.onNodeWithText("Wed").assertExists()
        rule.onNodeWithText("Fri").assertExists()
        rule.onNodeWithText("Tue").assertDoesNotExist()
    }

    /** Desktop's rule: the first column and each 1st are labelled, and a label with the next under three columns away gives way. */
    @Test
    fun monthLabelsNeedThreeColumns() {
        fun labels(from: LocalDate, to: LocalDate): List<Pair<Int, String>> {
            val days = generateSequence(from) { it.plusDays(1) }.takeWhile { !it.isAfter(to) }.map { ActivityDay(it, 0, emptyList()) }.toList()
            val offset = from.dayOfWeek.value - 1
            return usageMonthLabels(days) { (it + offset) / 7 }.map { (col, date) -> col to date.month.name.take(3) }
        }
        // Nov 12 2025, a Wednesday: Nov in column 0, Dec 1 in column 3, three apart, so both stay.
        assertEquals(listOf(0 to "NOV", 3 to "DEC", 7 to "JAN"), labels(LocalDate.of(2025, 11, 12), LocalDate.of(2026, 1, 20)))
        // Nov 26: Dec 1 is one column on, so the first column's Nov gives way.
        assertEquals(listOf(1 to "DEC", 5 to "JAN"), labels(LocalDate.of(2025, 11, 26), LocalDate.of(2026, 1, 20)))
    }

    /** On both of the Fold's screens the year opens on today, and no month label is cut at the grid's left edge. */
    @Test
    @Config(qualifiers = "w411dp-h900dp-xxhdpi")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun noMonthIsCutOnTheCoverScreen() = noMonthIsCut()

    @Test
    @Config(qualifiers = "w673dp-h900dp-xhdpi")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun noMonthIsCutOnTheInnerScreen() = noMonthIsCut()

    private fun noMonthIsCut() {
        show()
        rule.waitForIdle()
        val grid = rule.onNodeWithContentDescription("Tokens used each day").fetchSemanticsNode()
        // Scrolled to today: the grid runs past the left edge.
        assertTrue(grid.boundsInWindow.width < grid.size.width)
        val months = rule.onAllNodes(hasTestTag(AgentUsageTags.MONTH)).fetchSemanticsNodes()
        assertTrue(months.size >= 6)
        // Real text widths: a label cut at the edge shows narrower than it is.
        for (month in months) {
            val text = month.config[androidx.compose.ui.semantics.SemanticsProperties.Text].joinToString()
            assertEquals("$text shows whole", month.size.width.toFloat(), month.boundsInWindow.width, 1f)
            assertTrue("$text starts in view", month.boundsInWindow.left >= grid.boundsInWindow.left - 1f)
        }
    }

    /** A history that starts inside the year says since when, and nothing is drawn before it. */
    @Test
    fun aShortHistorySaysSinceWhen() {
        val since = LocalDate.of(2026, 10, 7)
        val full = UsageFixtures.history
        val history = DailyUsage(since, full.days.filter { !it.date.isBefore(since) })
        show(AgentUsageState.Ready(UsageFixtures.accounts, history, UsageFixtures.names))
        rule.onNodeWithText("tokens since Oct 7", substring = true).assertExists()
        rule.onNodeWithText("in the last year", substring = true).assertDoesNotExist()
        // Oct 7 is a Wednesday: six columns to Nov 11.
        val grid = rule.onNodeWithContentDescription("Tokens used each day").fetchSemanticsNode()
        assertEquals((6 * 12 - 2) * grid.layoutInfo.density.density, grid.size.width.toFloat(), 1f)
    }

    /** A tapped cell's callout: the day with its year, its tokens and top three models; a day with nothing says so. */
    @Test
    fun aTappedDaySaysWhatItSpent() {
        show()
        UsageFixtures.tapDay(rule, UsageFixtures.today)
        rule.node(AgentUsageTags.CALLOUT).assertExists()
        rule.onNodeWithText("Wed, Nov 11, 2026").assertExists()
        rule.onNode(hasTestTag(AgentUsageTags.CALLOUT) and hasAnyDescendant(hasText("tokens", substring = true))).assertExists()
        rule.onNode(hasTestTag(AgentUsageTags.CALLOUT) and hasAnyDescendant(hasText("claude-opus-4-1"))).assertExists()
        UsageFixtures.tapDay(rule, UsageFixtures.quietDay)
        rule.onNodeWithText("Sun, Nov 8, 2026").assertExists()
        rule.onNodeWithText("No usage").assertExists()
    }
    /** No daily history: no grid and no word of it; the accounts still show. */
    @Test
    fun withoutAHistoryThereIsNoGrid() {
        show(AgentUsageState.Ready(UsageFixtures.accounts, history = null, names = UsageFixtures.names))
        rule.node(AgentUsageTags.ACTIVITY).assertDoesNotExist()
        rule.node(AgentUsageTags.strip("claude-max")).assertDoesNotExist()
        rule.onNodeWithText("Claude Max").assertExists()
        rule.onNodeWithText("CODEX").assertExists()
    }

    @Test
    fun nothingAtAllSaysNoUsageYet() {
        show(AgentUsageState.Ready(listOf(UsageAccount("grok", "grok")), history = null))
        rule.node(AgentUsageTags.EMPTY).assertExists()
        rule.onNodeWithText("No usage yet").assertExists()
    }

    /** The adapter: the fixture parses, and a server without the route gives nothing. */
    @Test
    fun theSourceGivesTheHistoryOrNothing() = runBlocking {
        assertEquals(UsageFixtures.since, UsageFixtures.source().read(DailyUsage.DAYS, ZoneId.of("UTC"))?.since)
        assertNull(UsageFixtures.source(null).read(DailyUsage.DAYS, ZoneId.of("UTC")))
    }
}
