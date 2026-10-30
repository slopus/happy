package com.slopus.happy.ui.protocolv2

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.protocolv2.ProtocolV2Account
import com.slopus.happy.protocolv2.ProtocolV2PairingState
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
class ProtocolV2PairingScreenTest {
    @get:Rule val rule = createComposeRule()

    private val emoji = listOf("🌀", "👗", "⏳", "👟")

    @Test
    fun eachStateShowsWhatToDoNext() {
        var state by mutableStateOf<ProtocolV2PairingState?>(ProtocolV2PairingState.Connecting("Steve's Mac"))
        var confirmed = 0
        var rejected = 0
        var done = 0
        var back = 0
        rule.setHappyContent {
            ProtocolV2PairingScreen(state, onConfirm = { confirmed++ }, onReject = { rejected++ }, onBack = { back++ }, onDone = { done++ })
        }
        rule.onNode(isHeading(), useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Pair computer").assertExists()
        rule.node(ProtocolV2PairingTags.SPINNER).assertExists()
        rule.onNodeWithText("Steve's Mac", substring = true).assertExists()

        state = ProtocolV2PairingState.Compare("Steve's Mac", emoji)
        rule.node(ProtocolV2PairingTags.EMOJI).assertContentDescriptionEquals("🌀 👗 ⏳ 👟")
        rule.assertActionsLabelled()
        rule.node(ProtocolV2PairingTags.MATCH).performClick()
        rule.node(ProtocolV2PairingTags.MISMATCH).performClick()
        assertEquals(1, confirmed)
        assertEquals(1, rejected)

        state = ProtocolV2PairingState.Confirming("Steve's Mac", emoji)
        rule.node(ProtocolV2PairingTags.EMOJI).assertExists()
        rule.node(ProtocolV2PairingTags.SPINNER).assertExists()
        rule.node(ProtocolV2PairingTags.MATCH).assertDoesNotExist()

        state = ProtocolV2PairingState.Paired(ProtocolV2Account(id = "c1", name = "Studio", addedAt = 0))
        rule.onNodeWithText("Studio", substring = true).assertExists()
        rule.node(ProtocolV2PairingTags.DONE).performClick()

        state = ProtocolV2PairingState.Failed("Steve's Mac", "This pairing code has expired.")
        rule.onNodeWithText("This pairing code has expired.").assertExists()
        rule.node(ProtocolV2PairingTags.DONE).performClick()
        assertEquals(2, done)
        assertEquals(0, back)
    }
}
