package com.slopus.happy.ui.connection

import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.MemberProfile
import com.slopus.happy.agent.MemberProfileSource
import com.slopus.happy.agent.MemberProfileTask
import com.slopus.happy.agent.MemberProfileUser
import com.slopus.happy.agent.MemberUsage
import com.slopus.happy.agent.TeamRole
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.GlassBarTags
import com.slopus.happy.ui.components.GlassSpec
import com.slopus.happy.ui.components.ProfileHeaderTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * A Happy Cloud member's profile on the 411 phone, laid out as the agent
 * page (iOS ProfileHeaderLayout): the 88 picture centred 12 under the
 * feather, the name and the job title with the team's name for their role,
 * Usage's and Tokens' tiles two to a row, and their recent tasks, each
 * opening its conversation.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class MemberProfileTest {
    @get:Rule val rule = createComposeRule()

    private val now = 1_767_225_600_000L
    private val opened = mutableListOf<String>()
    private var retries = 0

    private val profile = MemberProfile(
        user = MemberProfileUser("u1", "Ada Lovelace", role = "Staff engineer", teamRole = "reviewer"),
        totalTasks = 12,
        activeTasks = 3,
        lastActivityAt = now - 3_600_000,
        activeDays = 9,
        usage = mapOf("hour" to MemberUsage(0, 0), "day" to MemberUsage(1_200, 300), "week" to MemberUsage(10_500, 2_500), "month" to MemberUsage(1_000_000, 200_000)),
        recentTasks = listOf(
            MemberProfileTask("t1", "a1", "Fix login redirect", now - 60_000, working = true),
            MemberProfileTask("t2", "a2", "Write release notes", now - 86_400_000, archived = true),
        ),
    )

    private fun show(state: MemberProfileSource.State) {
        rule.setHappyContent {
            MemberProfileScreen(state, listOf(TeamRole("reviewer", "Reviewers")), onOpenTask = { opened += it }, onRetry = { retries++ }, onBack = {}, now = now)
        }
        rule.waitForIdle()
    }

    @Test fun `the picture, name and title with the team role sit centred under the feather`() {
        show(MemberProfileSource.State.Loaded(profile))
        val bar = rule.node(GlassBarTags.BAR).bounds
        val mark = rule.node(ProfileHeaderTags.AVATAR).bounds
        val name = rule.node(ProfileHeaderTags.NAME).bounds
        assertDp("the picture rests 12 under the feather", bar.bottom + GlassSpec.feather + 12.dp, mark.top)
        assertDp("the picture is 88", 88, mark.width)
        assertDp("the picture is 88 high", 88, mark.height)
        assertDp("the picture is centred", (PHONE_WIDTH.dp - 88.dp) / 2, mark.left)
        assertDp("the name is 14 under the picture", mark.bottom + 14.dp, name.top)
        // The bar's title is the name too, faded in only as it scrolls under.
        rule.node(ProfileHeaderTags.NAME).assert(hasAnyDescendant(hasText("Ada Lovelace")))
        // A custom role reads as the team names it.
        rule.onNodeWithText("Staff engineer · Reviewers").assertIsDisplayed()
    }

    @Test fun `usage and tokens are tiles two to a row, tokens summed and said short`() {
        show(MemberProfileSource.State.Loaded(profile))
        val tiles = rule.onAllNodesWithTag(ProfileHeaderTags.TILE, useUnmergedTree = true).fetchSemanticsNodes()
        assertEquals(8, tiles.size)
        val width = with(rule.density) { tiles.first().boundsInRoot.width.toDp() }
        assertDp("two to a row, 10 apart in the 16-inset column", ((PHONE_WIDTH - 32 - 10) / 2.0).dp, width)
        for (text in listOf("12", "3", "9", "Tasks", "Active tasks", "Active days, last 30", "Last active")) rule.onNodeWithText(text).assertIsDisplayed()
        for (text in listOf("0", "1.5K", "13K", "1.2M")) rule.onNodeWithText(text).performScrollTo().assertIsDisplayed()
    }

    @Test fun `a recent task opens its conversation`() {
        show(MemberProfileSource.State.Loaded(profile))
        rule.onNodeWithText("Working").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Archived").performScrollTo().assertIsDisplayed()
        rule.node(MemberProfileTags.task("t2")).performScrollTo().performClick()
        assertEquals(listOf("a2"), opened)
    }

    @Test fun `no tasks says so, and a member never at work reads a dash`() {
        show(MemberProfileSource.State.Loaded(profile.copy(recentTasks = emptyList(), lastActivityAt = null)))
        rule.node(MemberProfileTags.EMPTY).performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("—").assertIsDisplayed()
    }

    @Test fun `an unknown member says they aren't on the team`() {
        show(MemberProfileSource.State.Unknown)
        rule.onNodeWithText("This person isn’t on this team.").assertIsDisplayed()
    }

    @Test fun `a failed read offers a retry`() {
        show(MemberProfileSource.State.Failed)
        rule.node(MemberProfileTags.RETRY).performClick()
        assertEquals(1, retries)
    }

    @Test fun `while it reads the header and tiles shimmer in place`() {
        show(MemberProfileSource.State.Loading)
        rule.node(ProfileHeaderTags.AVATAR).assertIsDisplayed()
        assertEquals(true, rule.onAllNodesWithTag(ProfileHeaderTags.PLACEHOLDER, useUnmergedTree = true).fetchSemanticsNodes().size >= 9)
        rule.node(MemberProfileTags.TASKS).assertDoesNotExist()
    }
}
