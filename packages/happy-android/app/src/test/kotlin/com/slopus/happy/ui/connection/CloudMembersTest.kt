package com.slopus.happy.ui.connection

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.ServerTeam
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

/** The Members page as the server lists its people: names, their teams and owner flag (or a pre-teams server's roles), a retry, and Leave with why it couldn't. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class CloudMembersTest {
    @get:Rule val rule = createComposeRule()

    private var retries = 0
    private var leaves = 0
    private val opened = mutableListOf<String>()

    private fun show(team: TeamSource.State, footer: String? = null) = rule.setHappyContent {
        CloudMembersScreen("@acme", team, footer, leaving = false, onRetry = { retries++ }, onLeave = { leaves++ }, onBack = {}, onOpenMember = { opened += it })
    }

    @Test
    fun membersShowTheirNameTheirTeamsAndWhetherTheyOwnTheServer() {
        show(
            TeamSource.State.Loaded(
                Team(
                    listOf(
                        TeamMember("a1", name = "Ada", role = "owner", owner = true, teams = emptyList()),
                        TeamMember("a2", name = "Bo", role = "design", owner = false, teams = listOf("design", "ops")),
                        TeamMember("a3", name = "Cy", role = "member", owner = false, teams = emptyList()),
                        TeamMember("a4", name = "Di", owner = true, teams = listOf("gone")),
                    ),
                    listOf(ServerTeam("owners", "Owners", "owners"), ServerTeam("members", "Members", "members"), ServerTeam("design", "Design"), ServerTeam("ops", "Ops")),
                ),
            ),
        )
        rule.onNodeWithText("Owner").assertIsDisplayed()
        rule.onNodeWithText("Design, Ops").assertIsDisplayed()
        // In no custom team: in members alone.
        rule.onNodeWithText("Member").assertIsDisplayed()
        // A team the server didn't name reads as its id.
        rule.onNodeWithText("Owner, gone").assertIsDisplayed()
    }

    @Test
    fun aServerBeforeTeamsShowsItsRolesAsItNamesThem() {
        show(
            TeamSource.State.Loaded(
                Team(
                    listOf(TeamMember("a1", name = "Ada", role = "owner"), TeamMember("a2", role = "reviewer"), TeamMember("a3", name = "Vi", role = "viewer")),
                    roles = listOf(TeamRole("owner", "Owner", builtIn = true), TeamRole("reviewer", "Reviewers")),
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
    fun aMemberWithAUserOpensTheirProfileAndOneWithoutOpensNothing() {
        show(TeamSource.State.Loaded(Team(listOf(TeamMember("a1", userId = "u1", name = "Ada", role = "owner"), TeamMember("a2", name = "Invited", role = "member")))))
        rule.onNodeWithTag(CloudTags.member("a1")).performClick()
        rule.onNodeWithTag(CloudTags.member("a2")).performClick()
        assertEquals(listOf("u1"), opened)
    }

    @Test
    fun aFailedReadOffersARetryAndLeavingSaysWhyItCouldnt() {
        show(TeamSource.State.Failed, footer = "You're its only owner, so you can't leave it.")
        rule.onNodeWithText("Something went wrong. Try again.").performClick()
        assertEquals(1, retries)
        rule.onNodeWithText("You're its only owner, so you can't leave it.").assertIsDisplayed()
    }
}
