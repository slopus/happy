package com.slopus.happy.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.components.avatar.AvatarPlaceholder
import com.slopus.happy.ui.components.avatar.AvatarShaderProgram
import com.slopus.happy.ui.components.avatar.LocalAnimatedAvatars
import com.slopus.happy.ui.components.avatar.PlaceholderAvatarTags
import com.slopus.happy.ui.components.avatar.PlaceholderIndexKey
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuButton
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * happy-ios's testSettingsAndTheSwitcherMoveWithAnimatedAvatars: with
 * Animated Avatars on, every account without a picture moves in Settings
 * (the big picture and each row of the accounts card) and in the account
 * menu's button, as the placeholder its seed picks; an account with a
 * picture of its own never does. Off, nothing there moves.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SettingsLiveAvatarsTest {
    @get:Rule val rule = createComposeRule()

    private val lives get() = rule.onAllNodesWithTag(PlaceholderAvatarTags.LIVE, useUnmergedTree = true)

    private val accounts = AccountMenu(
        listOf(
            AccountMenuEntry("me", "Me", active = true),
            AccountMenuEntry("agent", "Agent", agent = true, seed = "agent:10.0.0.2"),
            AccountMenuEntry("pictured", "Pictured", imageUrl = "https://example.com/p.jpg", thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"),
        ),
    )

    private fun livesWith(index: Int) = rule.onAllNodes(
        hasTestTag(PlaceholderAvatarTags.LIVE) and SemanticsMatcher.expectValue(PlaceholderIndexKey, index),
        useUnmergedTree = true,
    )

    @Test
    fun settingsAndTheMenuButtonMoveWithAnimatedAvatars() {
        assumeTrue("AGSL builds here", AvatarShaderProgram.available)
        var animated by mutableStateOf(false)
        rule.setHappyContent {
            CompositionLocalProvider(LocalAnimatedAvatars provides animated) {
                Column {
                    AccountMenuButton(accounts, onSwitch = {}, onAdd = {})
                    SettingsHeader(SettingsProfile("agent", "Agent", "Connected", seed = "agent:10.0.0.2"))
                    AccountsCard(accounts, AccountsCardActions(onSwitch = {}, onAdd = {}))
                }
            }
        }
        lives.assertCountEquals(0)

        rule.runOnIdle { animated = true }
        rule.waitForIdle()
        // The button (me), the big picture (agent), and the card's two rows without pictures.
        lives.assertCountEquals(4)
        livesWith(AvatarPlaceholder.index("me")).assertCountEquals(2)
        livesWith(AvatarPlaceholder.index("agent:10.0.0.2")).assertCountEquals(2)

        rule.runOnIdle { animated = false }
        rule.waitForIdle()
        lives.assertCountEquals(0)
    }

    /** A real picture is never covered: the big picture of an account with one stays its picture. */
    @Test
    fun aPictureNeverMoves() {
        rule.setHappyContent {
            CompositionLocalProvider(LocalAnimatedAvatars provides true) {
                SettingsHeader(SettingsProfile("me", "Me", "@me", thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"))
            }
        }
        lives.assertCountEquals(0)
        assertEquals(null, SettingsProfile("me", "Me", "@me", thumbhash = "x").liveSeed)
    }
}
