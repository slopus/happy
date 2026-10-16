package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.model.AvatarHarness
import com.slopus.happy.model.ProviderIconKind
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HomeComponentsLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    // The generated avatars pick their art from the same JS hash happy-app
    // uses; these values were computed by running Avatar*.tsx's hashCode in Node.

    @Test
    fun avatarHashMatchesJavaScript() {
        assertEquals(269061190L, avatarHash("m1:/Users/dev/happy"))
        assertEquals(23692677L, avatarHash("session-123"))
        assertEquals(61901292L, avatarHash("é😀x"))
        assertEquals(1042809472L, avatarHash("a".repeat(40)))
        assertEquals("Brutalism-69", BrutalistArt.imageFor("m1:/Users/dev/happy")) // index 370 = 262 + 40 + 68
        assertEquals(BrutalistArt.colorPairs[5], BrutalistArt.colorsFor("m1:/Users/dev/happy"))
        assertEquals("Abstract-58", BrutalistArt.imageFor("session-123")) // index 57
        assertEquals(
            listOf(0, 1, 0, 1, 2, 3, 1, 0, 1, 2, 3, 4).map { PixelatedArt.colors[it] },
            PixelatedArt.cells("session-123", monochrome = false).take(12),
        )
    }

    @Test
    fun harnessBadgeGeometry() {
        assertEquals(25 to 16, harnessBadgeSizes(60, AvatarHarness.Rig))
        assertEquals(25 to 18, harnessBadgeSizes(60, AvatarHarness.Codex))
        assertEquals(25 to 20, harnessBadgeSizes(60, AvatarHarness.Claude))
        assertEquals(25 to 25, harnessBadgeSizes(60, AvatarHarness.Agy))
    }

    // Avatar.tsx: size x size; a list badge (when showFlavorIcons is on) of
    // round(0.42 size) sits 2 outside the bottom-right corner.
    @Test
    fun avatarWithAHarnessBadge() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalAvatarSettings provides AvatarSettings(showFlavorIcons = true)) {
                Box(Modifier.padding(10.dp)) {
                    Avatar(id = "s", size = 60.dp, flavor = "claude", badgeLocation = AvatarBadgeLocation.SessionList)
                }
            }
        }
        assertBox("avatar", rule.node(AvatarTags.AVATAR).bounds, 10.dp, 10.dp, 60.dp, 60.dp)
        assertBox("badge", rule.node(AvatarTags.BADGE).bounds, (10 + 60 + 2 - 25).dp, (10 + 60 + 2 - 25).dp, 25.dp, 25.dp)
    }

    @Test
    fun avatarBadgeFollowsItsSetting() {
        rule.setHappyContent {
            Avatar(id = "s", size = 48.dp, flavor = "codex", badgeLocation = AvatarBadgeLocation.SessionList)
        }
        rule.onAllNodesWithTag(AvatarTags.BADGE, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun everyStyleAndTheBotFillTheirBox() {
        for (style in AvatarStyle.entries) {
            assertEquals(style, AvatarStyle.normalize(style.key))
        }
        assertEquals(AvatarStyle.Brutalist, AvatarStyle.normalize("legacy"))
        rule.setHappyContent {
            CompositionLocalProvider(LocalAvatarSettings provides AvatarSettings(style = AvatarStyle.Pixelated)) {
                Avatar(id = "bot", size = 40.dp, bot = true)
            }
        }
        assertBox("bot avatar", rule.node(AvatarTags.AVATAR).bounds, 0.dp, 0.dp, 40.dp, 40.dp)
    }

    // StatusDot.tsx: 6 by default.
    @Test
    fun statusDotSizes() {
        rule.setHappyContent {
            Box {
                StatusDot(color = androidx.compose.ui.graphics.Color.Red, modifier = Modifier.then(Modifier).padding(0.dp).let { it }, pulsing = true)
                Box(Modifier.padding(start = 20.dp)) { StatusDot(color = androidx.compose.ui.graphics.Color.Blue, size = 20.dp, modifier = Modifier.padding(0.dp)) }
            }
        }
        rule.waitForIdle()
    }

    // Switch.tsx: the platform switch in a 48 target; toggles through its callback.
    @Test
    fun switchToggles() {
        rule.setHappyContent {
            var on by remember { mutableStateOf(false) }
            HappySwitch(checked = on, onCheckedChange = { on = it })
        }
        val switch = rule.node(SwitchTags.SWITCH)
        assertBox("switch", switch.bounds, 0.dp, 0.dp, 48.dp, 48.dp)
        switch.assertIsOff().performClick()
        rule.node(SwitchTags.SWITCH).assertIsOn()
        val thumb = rule.node(SwitchTags.THUMB).bounds
        assertDp("thumb", 20, thumb.right - thumb.left)
    }

    @Test
    fun providerIconIsSquare() {
        rule.setHappyContent {
            Box(Modifier.let { it }) { ProviderIcon(ProviderIconKind.Grok, Modifier.then(Modifier)) }
        }
        rule.waitForIdle()
    }

    // WebPromptModal.tsx: 270 wide; 20 top padding; 36 input 16 under the text; buttons split by a divider.
    @Test
    fun promptReturnsTheTextOrNull() {
        var result: String? = "unset"
        var shown by mutableStateOf(true)
        rule.setHappyContent {
            if (shown) {
                PromptModal(
                    Prompt(title = "Rename", message = "Pick a name", placeholder = "Name", defaultValue = "old", confirmText = "Save", onResult = { result = it }),
                    onDismiss = { shown = false },
                )
            }
        }
        val container = rule.node(PromptTags.CONTAINER).bounds
        assertDp("width", 270, container.right - container.left)
        val title = rule.node(PromptTags.TITLE).bounds
        assertDp("title 20 below the top", container.top + 20.dp, title.top)
        val message = rule.node(PromptTags.MESSAGE).bounds
        assertDp("message 4 + 4 under the title", title.bottom + 8.dp, message.top)
        val input = rule.node(PromptTags.INPUT).bounds
        assertDp("input 16 under the message", message.bottom + 16.dp, input.top)
        assertDp("input height", 36, input.bottom - input.top)
        assertDp("input inset 16", container.left + 16.dp + (1f / 3f).dp, input.left)
        val cancel = rule.node(PromptTags.CANCEL).bounds
        val confirm = rule.node(PromptTags.CONFIRM).bounds
        assertDp("buttons 16 + 1 under the input", input.bottom + 17.dp, cancel.top)
        assertDp("buttons split evenly", cancel.right - cancel.left, confirm.right - confirm.left)
        assertTrue("confirm right of cancel", confirm.left >= cancel.right)

        rule.node(PromptTags.INPUT).performTextReplacement("new name")
        rule.onNodeWithText("Save").performClick()
        assertEquals("new name", result)
    }

    @Test
    fun promptCancelResolvesNull() {
        var result: String? = "unset"
        rule.setHappyContent {
            var shown by remember { mutableStateOf(true) }
            if (shown) PromptModal(Prompt(title = "Paste", onResult = { result = it }), onDismiss = { shown = false })
        }
        rule.onNodeWithText("Cancel").performClick()
        assertEquals(null, result)
    }

    // NativeSettingsMenu.android.tsx: "Group: ✓ Option" rows.
    @Test
    fun settingsMenuPrefixesTheGroupAndChecksTheSelection() {
        var picked: String? = null
        rule.setHappyContent {
            SettingsMenu(
                groups = listOf(
                    MenuGroup("grouping", "Group sessions", listOf(MenuOption("flat", "Flat list"), MenuOption("project", "By project")), "flat") { picked = it },
                    MenuGroup("appearance", "", listOf(MenuOption("open", "Appearance settings")), null) {},
                ),
                expanded = true,
                onDismiss = {},
            ) { Box(Modifier.padding(4.dp)) }
        }
        rule.onNodeWithText("Group sessions: ✓ Flat list").assertExists()
        rule.onNodeWithText("Appearance settings").assertExists()
        rule.onNodeWithText("Group sessions: By project").performClick()
        assertEquals("project", picked)
    }
}
