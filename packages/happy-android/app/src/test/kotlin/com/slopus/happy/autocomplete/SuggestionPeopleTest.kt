package com.slopus.happy.autocomplete

import com.slopus.happy.agent.TeamUser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** happyAgentMentionPlaces.ts's people and composerDraft.ts's reading of a person's mention. */
class SuggestionPeopleTest {
    private val team = listOf(
        TeamUser("u_anna", "Anna Lee", role = "Billing engineer"),
        TeamUser("u_kirill", "Kirill"),
        TeamUser("u_max", "Max Anders"),
        TeamUser("u_steve", "Steve"),
        TeamUser("u_blank", ""),
    )

    @Test
    fun peopleMatchAnywhereInTheirNameInAnyCaseInTheTeamsOrder() {
        assertEquals(listOf("u_anna", "u_max"), searchPeople(team, "AN", self = null).map { it.id })
        assertEquals(listOf("u_kirill"), searchPeople(team, "kir", self = null).map { it.id })
        assertTrue(searchPeople(team, "zed", self = null).isEmpty())
    }

    @Test
    fun theReaderAndTheNamelessAreNeverOffered() {
        assertEquals(listOf("u_anna", "u_kirill", "u_max"), searchPeople(team, "", self = "u_steve").map { it.id })
    }

    @Test
    fun aBlankWordOffersTheFirstFive() {
        val many = (1..8).map { TeamUser("u$it", "Person $it") }
        assertEquals((1..5).map { "u$it" }, searchPeople(many, " ", self = null).map { it.id })
        assertEquals(PEOPLE_LIMIT, 5)
    }

    @Test
    fun aMentionIsTheirHappyUserLinkLabelledWithTheirName() {
        assertEquals("[Anna Lee](happy://users/u_anna)", mentionMarkdown(team[0]))
        // The chat's Markdown has no escapes: what would end the label goes.
        assertEquals("[Max (Ops)](happy://users/u_max)", mentionMarkdown(TeamUser("u_max", "Max [Ops]")))
        assertNull(mentionMarkdown(TeamUser("bad id", "Bad")))
        assertNull(mentionMarkdown(TeamUser("u_blank", " ")))
    }

    @Test
    fun aDraftShowsEachPersonItMentionsAsTheirName() {
        val draft = "ask [Anna Lee](happy://users/u_anna) and [Kirill](happy://users/u_kirill) about [the doc](happy://artifacts/a1)"
        val mentions = draftMentions(draft)
        assertEquals(listOf("@Anna Lee", "@Kirill"), mentions.map { it.shown })
        assertEquals(4, mentions[0].start)
        assertEquals(draft.indexOf(" and"), mentions[0].end)
        assertEquals("ask @Anna Lee and @Kirill about [the doc](happy://artifacts/a1)", shownDraft(draft))
    }

    @Test
    fun aMentionWithoutWordsOrInCodeStaysAsWritten() {
        assertEquals("[](happy://users/u_anna) `[Kirill](happy://users/u_kirill)`", shownDraft("[](happy://users/u_anna) `[Kirill](happy://users/u_kirill)`"))
        assertEquals("plain words @anna", shownDraft("plain words @anna"))
    }
}
