package com.slopus.happy.ui.connection

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.connection.AgentConnection
import com.slopus.happy.connection.PairingState
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The pairing screen through each state, under the standard header. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PairingScreenTest {
    @get:Rule val rule = createComposeRule()

    private val emoji = listOf("🌀", "👗", "⏳", "👟")

    @Test
    fun eachStateShowsWhatToDoNext() {
        var state by mutableStateOf<PairingState?>(PairingState.Connecting("Steve's Mac"))
        var confirmed = 0
        var rejected = 0
        var done = 0
        var back = 0
        rule.setHappyContent {
            PairingScreen(state, onConfirm = { confirmed++ }, onReject = { rejected++ }, onBack = { back++ }, onDone = { done++ })
        }
        rule.onNode(isHeading(), useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Connect Agent").assertExists()
        rule.node(PairingTags.SPINNER).assertExists()
        rule.onNodeWithText("Steve's Mac", substring = true).assertExists()

        state = PairingState.Compare("Steve's Mac", emoji)
        rule.node(PairingTags.EMOJI).assertContentDescriptionEquals("🌀 👗 ⏳ 👟")
        rule.assertActionsLabelled()
        rule.node(PairingTags.MATCH).performClick()
        rule.node(PairingTags.MISMATCH).performClick()
        assertEquals(1, confirmed)
        assertEquals(1, rejected)

        state = PairingState.Confirming("Steve's Mac", emoji)
        rule.node(PairingTags.EMOJI).assertExists()
        rule.node(PairingTags.SPINNER).assertExists()
        rule.node(PairingTags.MATCH).assertDoesNotExist()

        state = PairingState.Paired(AgentConnection(id = "c1", name = "Studio", addedAt = 0))
        rule.onNodeWithText("Studio", substring = true).assertExists()
        rule.node(PairingTags.DONE).performClick()

        state = PairingState.Failed("Steve's Mac", "This pairing code has expired.")
        rule.onNodeWithText("This pairing code has expired.").assertExists()
        rule.node(PairingTags.DONE).performClick()
        assertEquals(2, done)
        assertEquals(0, back)
    }
}
