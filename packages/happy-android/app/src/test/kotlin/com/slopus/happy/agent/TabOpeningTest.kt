package com.slopus.happy.agent

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class TabOpeningTest {
    private fun snapshot(tabs: String = "[]", user: String = "\"me\"") = AgentClient.json.parseToJsonElement(
        """{"profile":{"userId":$user},"bots":[{"id":"bot1","name":"Bot","agent":{"id":"a1"}}],"surfaces":$tabs}""",
    ) as JsonObject

    private fun tab(member: String, creator: String, id: String = "tab1") =
        """{"id":"$id","creatorUserId":$creator,"members":[{"userId":$member}],"target":{"state":"available","type":"bot","botId":"bot1"}}"""

    @Test fun openingAddsReferenceButNotForUnownedSubagent() {
        assertEquals(TabOpening.Action.Create(TabOpening.Reference("bot", "bot1", "Bot")), TabOpening.action("agent", "a1", snapshot()))
        assertEquals(TabOpening.Action.None, TabOpening.action("agent", "child", snapshot()))
        assertEquals(TabOpening.Action.Join("monitor1"), TabOpening.action("surface", "monitor1", snapshot()))
    }

    @Test fun reopenKeepsJoinedIdentityAndDoesNotTakeAnotherMembersTab() {
        val other = tab("\"other\"", "\"other\"")
        assertEquals(TabOpening.Action.Create(TabOpening.Reference("bot", "bot1", "Bot")), TabOpening.action("agent", "a1", snapshot("[$other]")))
        val mine = tab("\"me\"", "\"other\"", "mine")
        assertEquals(TabOpening.Action.None, TabOpening.action("agent", "a1", snapshot("[$other,$mine]")))
        val left = tab("\"other\"", "\"me\"", "left")
        assertEquals(TabOpening.Action.Join("left"), TabOpening.action("agent", "a1", snapshot("[$other,$left]")))
    }

    @Test fun standaloneMembershipAndUnavailableTargets() {
        assertEquals(TabOpening.Action.None, TabOpening.action("agent", "a1", snapshot("[${tab("null", "null")}]", "null")))
        assertEquals(TabOpening.Action.Create(TabOpening.Reference("artifact", "a", "Untitled")), TabOpening.action("artifact", "a", snapshot("""[{"target":{"state":"unavailable","type":"artifact"}}]""")))
    }
}