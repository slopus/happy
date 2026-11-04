package com.slopus.happy.ui.connection

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentSharingState
import com.slopus.happy.agent.AutoJoinKind
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.ItemGroupTags
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentSharingTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private fun shot(name: String) {
        val file = File("build/outputs/sharing/$name.png")
        file.parentFile?.mkdirs()
        file.outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun togglesAreIndependentAndFollowTheConnectionsLiveState() {
        var state by mutableStateOf(AgentSharingState.Ready(true, false))
        val calls = mutableListOf<Pair<AutoJoinKind, Boolean>>()
        rule.setHappyContent { AgentSharingScreen(state, { kind, enabled -> calls += kind to enabled }, {}) }
        rule.node(AgentSharingTags.toggle(AutoJoinKind.Tasks)).assertIsOn().performClick()
        rule.node(AgentSharingTags.toggle(AutoJoinKind.Surfaces)).assertIsOff().performClick()
        assertEquals(listOf(AutoJoinKind.Tasks to false, AutoJoinKind.Surfaces to true), calls)
        rule.runOnIdle { state = AgentSharingState.Ready(false, true) }
        rule.node(AgentSharingTags.toggle(AutoJoinKind.Tasks)).assertIsOff()
        rule.node(AgentSharingTags.toggle(AutoJoinKind.Surfaces)).assertIsOn()
        rule.onNodeWithText("Except ones you left. Turning this off keeps the ones you joined.").assertExists()
        shot("phone-light")
    }

    @Test fun unsupportedAndLoadingHaveNoPretendPreferences() {
        var state by mutableStateOf<AgentSharingState>(AgentSharingState.Loading)
        rule.setHappyContent { AgentSharingScreen(state, { _, _ -> error("Unavailable") }, {}) }
        rule.onNodeWithText("Loading...").assertExists()
        rule.node(AgentSharingTags.toggle(AutoJoinKind.Tasks)).assertDoesNotExist()
        rule.runOnIdle { state = AgentSharingState.Unsupported }
        rule.onNodeWithText("This connection does not provide user settings.").assertExists()
        rule.node(AgentSharingTags.toggle(AutoJoinKind.Tasks)).assertDoesNotExist()
        rule.node(AgentSharingTags.toggle(AutoJoinKind.Surfaces)).assertDoesNotExist()
    }

    @Test fun oldAgentsOfferTasksAndExplainTheSurfaceUpgrade() {
        rule.setHappyContent { AgentSharingScreen(AgentSharingState.Ready(true, null), { _, _ -> }, {}) }
        rule.node(AgentSharingTags.toggle(AutoJoinKind.Tasks)).assertIsOn()
        rule.node(AgentSharingTags.toggle(AutoJoinKind.Surfaces)).assertDoesNotExist()
        rule.onNodeWithText("Update this connection’s Happy Agent to change this preference.").assertExists()
    }

    @Test fun darkSharingUsesTheNormalSettingsCard() {
        rule.setHappyContent(dark = true) { AgentSharingScreen(AgentSharingState.Ready(true, true), { _, _ -> }, {}) }
        rule.waitForIdle()
        shot("phone-dark")
    }

    @Test
    @Config(qualifiers = "ru-rRU-w411dp-h891dp-xxhdpi")
    fun longTranslatedTitlesRemainReadableAtLargeFontSize() {
        rule.setHappyContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 2f)) {
                AgentSharingScreen(AgentSharingState.Ready(true, true), { _, _ -> }, {})
            }
        }
        val layouts = mutableListOf<TextLayoutResult>()
        rule.onNodeWithText("Присоединяться к документам, спискам и календарям других людей", useUnmergedTree = true)
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        assertTrue(layouts.single().lineCount > 2)
        assertFalse(layouts.single().hasVisualOverflow)
        rule.node(AgentSharingTags.toggle(AutoJoinKind.Surfaces)).assertIsOn()
        shot("russian-large-font")
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-xhdpi")
    fun sharingUsesTheTabletContentColumn() {
        rule.setHappyContent {
            ProvideWindowLayout(Modifier.fillMaxSize()) {
                AgentSharingScreen(AgentSharingState.Ready(true, false), { _, _ -> }, {})
            }
        }
        rule.waitForIdle()
        val card = rule.node(ItemGroupTags.CARD).bounds
        assertTrue(card.width < 800.dp)
        assertEquals(640f, (card.left.value + card.right.value) / 2, 1f)
        shot("tablet-light")
    }
}