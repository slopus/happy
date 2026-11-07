package com.slopus.happy.ui.connection

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.Team
import com.slopus.happy.agent.TeamMember
import com.slopus.happy.agent.TeamRole
import com.slopus.happy.agent.TeamSource
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The Members page as the server lists its team: names, roles as the team calls them, a retry, and Leave with why it couldn't. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class CloudMembersTest {
    @get:Rule val rule = createComposeRule()

    private var retries = 0
    private var leaves = 0

    private fun show(team: TeamSource.State, footer: String? = null) = rule.setHappyContent {
        CloudMembersScreen("@acme", team, footer, leaving = false, onRetry = { retries++ }, onLeave = { leaves++ }, onBack = {})
    }

    @Test
    fun membersShowTheirNameAndTheTeamsNameForTheirRole() {
        show(
            TeamSource.State.Loaded(
                Team(
                    listOf(TeamMember("a1", name = "Ada", role = "owner"), TeamMember("a2", role = "reviewer"), TeamMember("a3", name = "Vi", role = "viewer")),
                    listOf(TeamRole("owner", "Owner", builtIn = true), TeamRole("reviewer", "Reviewers")),
                ),
            ),
        )
        rule.onNodeWithText("Ada").assertIsDisplayed()
        rule.onNodeWithText("Owner").assertIsDisplayed()
        // No name: the account's id. A role the team named: its name.
        rule.onNodeWithText("a2").assertIsDisplayed()
        rule.onNodeWithText("Reviewers").assertIsDisplayed()
        // A built-in role the team didn't list reads in the app's words.
        rule.onNodeWithText("Viewer").assertIsDisplayed()
        rule.onNodeWithTag(CloudTags.LEAVE).performClick()
        assertEquals(1, leaves)
    }

    @Test
    fun aFailedReadOffersARetryAndLeavingSaysWhyItCouldnt() {
        show(TeamSource.State.Failed, footer = "You're its only owner, so you can't leave it.")
        rule.onNodeWithText("Something went wrong. Try again.").performClick()
        assertEquals(1, retries)
        rule.onNodeWithText("You're its only owner, so you can't leave it.").assertIsDisplayed()
    }
}
