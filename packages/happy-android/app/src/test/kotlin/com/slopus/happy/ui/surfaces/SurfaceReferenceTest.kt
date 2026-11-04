package com.slopus.happy.ui.surfaces

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentCatalog
import com.slopus.happy.agent.Surface
import com.slopus.happy.agent.SurfaceTarget
import com.slopus.happy.agent.SurfaceType
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.artifacts.ArtifactRoute
import com.slopus.happy.ui.conversation.ConversationRoute
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * An artifact, bot or task kept among the Surfaces (desktop e99d6805):
 * it opens where it always opens, the artifact viewer or the bot's or
 * task's chat; one the reader can't see says so quietly.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class SurfaceReferenceTest {
    @get:Rule val rule = createComposeRule()

    private val catalog = AgentCatalog(
        bots = mapOf("bot1" to buildJsonObject { put("id", "bot1"); put("agent", buildJsonObject { put("id", "agent-bot") }) }),
        tasks = mapOf("task1" to buildJsonObject { put("id", "task1"); put("agent", buildJsonObject { put("id", "agent-task") }) }),
    )

    private fun reference(type: String, id: String?, available: Boolean = true) =
        Surface("s-$type", type, "Kept $type", target = SurfaceTarget(type, id, "Its $type", available))

    @Test
    fun eachKindOpensWhereItAlwaysDoes() {
        assertEquals(ArtifactRoute("c", "a1", title = "Its artifact"), surfaceTarget("c", reference(SurfaceType.ARTIFACT, "a1"), catalog))
        assertEquals(ConversationRoute("c", "agent-bot"), surfaceTarget("c", reference(SurfaceType.BOT, "bot1"), catalog))
        assertEquals(ConversationRoute("c", "agent-task"), surfaceTarget("c", reference(SurfaceType.TASK, "task1"), catalog))
        assertNull("Not visible to the reader", surfaceTarget("c", reference(SurfaceType.ARTIFACT, null, available = false), catalog))
        assertNull("A task the phone doesn't hold", surfaceTarget("c", reference(SurfaceType.TASK, "task9"), catalog))
        assertNull("Not a reference", surfaceTarget("c", Surface("d", SurfaceType.DOCUMENT, "Notes"), catalog))
    }

    @Test
    fun itsPageOpensTheTargetOrSaysItIsGone() {
        var opened: Any? = null
        val route = ConversationRoute("c", "agent-bot")
        rule.setHappyContent { SurfaceReference("Kept bot", SurfaceType.BOT, route, "Helper", onBack = {}, open = { opened = it }) }
        rule.onNodeWithText("Helper").assertExists()
        rule.onNodeWithText("Open chat").performClick()
        assertEquals(route, opened)
    }

    @Test
    fun aGoneTargetIsSaidQuietly() {
        rule.setHappyContent { SurfaceReference("Spec", SurfaceType.ARTIFACT, null, null, onBack = {}, open = {}) }
        rule.node(SurfaceTags.EMPTY_TEXT).assertExists()
        rule.onNodeWithText("Spec isn’t available.\nIt was deleted, or you can’t see it. It stays here in case it comes back.").assertExists()
    }
}
