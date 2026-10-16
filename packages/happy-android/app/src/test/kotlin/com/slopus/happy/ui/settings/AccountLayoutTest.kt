package com.slopus.happy.ui.settings

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.NativeClipboard
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.assertIsDisplayed
import com.slopus.happy.model.GitHubProfile
import androidx.compose.ui.unit.dp
import com.slopus.happy.model.ImageRef
import com.slopus.happy.model.Profile
import com.slopus.happy.model.settings.PushPermission
import com.slopus.happy.model.settings.PushToken
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
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
class AccountLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun accountSecretKeyRevealAndAnalyticsSwitch() {
        var optOut = false
        rule.setHappyContent {
            AccountScreen(
                anonId = "0123456789abcdef",
                publicId = "cmabc",
                formattedSecretKey = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-IIIII-JJJJJ-KKKKK-LLLLL-M",
                analyticsOptOut = optOut,
                onAnalyticsOptOutChange = { optOut = it },
                onLogout = {},
                onBack = {},
            )
        }
        rule.onAllNodesWithTag(AccountTags.SECRET_KEY, useUnmergedTree = true).assertCountEquals(0)
        rule.onNodeWithText("Secret Key").performClick()
        val block = rule.node(AccountTags.SECRET_KEY).bounds
        val text = rule.node(AccountTags.SECRET_KEY_TEXT).bounds
        assertDp("secret text inset 16", block.left + 16.dp, text.left)
        assertDp("14 under the secret text", text.bottom + 14.dp, block.bottom)
        assertDp("secret text lines are 20", 0f.dp, ((text.bottom - text.top).value % 20f).dp)

        rule.node(AccountTags.ANALYTICS_SWITCH).assertIsOn().performClick()
        assertTrue("switching analytics off opts out", optOut)
    }

    @Test
    fun accountAnalyticsSwitchShowsOptOut() {
        rule.setHappyContent {
            AccountScreen(
                anonId = null, publicId = null, formattedSecretKey = "",
                analyticsOptOut = true, onAnalyticsOptOutChange = {}, onLogout = {}, onBack = {},
            )
        }
        rule.node(AccountTags.ANALYTICS_SWITCH).assertIsOff()
        rule.onAllNodesWithText("Not available").assertCountEquals(2)
    }

    private val profile = Profile(
        id = "account-1", timestamp = 0, firstName = "Ada", lastName = null, avatar = null,
        github = GitHubProfile(id = 1.0, login = "ada", name = "Ada", avatarUrl = "", email = null, bio = null),
        connectedServices = listOf("anthropic", "openai", "unknown-service"),
    )

    private val token = PushToken(id = "pt1", token = "ExponentPushToken[abcdefghijklmnop]", createdAt = 0, updatedAt = 0)

    @Test
    fun accountProfileAndServicesDisconnectAfterConfirming() {
        val disconnected = mutableListOf<String>()
        rule.setHappyContent {
            AccountScreen(
                anonId = null, publicId = null, formattedSecretKey = "",
                analyticsOptOut = false, onAnalyticsOptOutChange = {}, onLogout = {}, onBack = {},
                profile = profile,
                onDisconnectGitHub = { disconnected += "github" },
                onDisconnectService = { service, _ -> disconnected += service },
            )
        }
        rule.onNodeWithText("@ada").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("OpenAI Codex").performScrollTo().assertIsDisplayed()
        rule.onAllNodesWithText("Active").assertCountEquals(3)
        rule.onNodeWithText("Claude Code").performScrollTo().performClick()
        rule.onNodeWithText("Are you sure you want to disconnect Claude Code from your account?").assertIsDisplayed()
        rule.onNodeWithText("Disconnect").performClick()
        rule.onNodeWithText("@ada").performScrollTo().performClick()
        rule.onNodeWithText("Disconnect").performClick()
        assertEquals(listOf("anthropic", "github"), disconnected)
    }

    @Test
    fun accountWithoutProfileHasNoProfileGroup() {
        rule.setHappyContent {
            AccountScreen(anonId = null, publicId = null, formattedSecretKey = "", analyticsOptOut = false, onAnalyticsOptOutChange = {}, onLogout = {}, onBack = {})
        }
        rule.onAllNodesWithText("PROFILE").assertCountEquals(0)
        rule.onAllNodesWithText("CONNECTED ACCOUNTS").assertCountEquals(0)
        rule.onNodeWithText("No registered push tokens").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("REGISTERED TOKENS (0)").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun accountPushRowsWithoutPush() {
        val deleted = mutableListOf<String>()
        rule.setHappyContent {
            AccountScreen(
                anonId = null, publicId = null, formattedSecretKey = "",
                analyticsOptOut = false, onAnalyticsOptOutChange = {}, onLogout = {}, onBack = {},
                push = PushState(permission = PushPermission.Undetermined, tokens = listOf(token)),
                onDeletePushToken = { deleted += it.id },
            )
        }
        rule.onNodeWithText("Not requested").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("iOS has stopped prompting. Open system settings to enable notifications again.").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("abcdef…klmnop").performScrollTo().performClick()
        rule.onNodeWithText("Remove abcdef…klmnop from your account?").assertIsDisplayed()
        rule.onNodeWithText("Delete").performClick()
        assertEquals(listOf("pt1"), deleted)
    }

    @Test
    fun linkNewDeviceScansAndReadsScanningWhileLinking() {
        var scans = 0
        var linking by mutableStateOf(false)
        rule.setHappyContent {
            AccountScreen(
                anonId = null, publicId = null, formattedSecretKey = "",
                analyticsOptOut = false, onAnalyticsOptOutChange = {}, onLogout = {}, onBack = {},
                linkingDevice = linking,
                onLinkNewDevice = { scans++ },
            )
        }
        rule.onNodeWithText("Scan QR code to link device").performClick()
        assertEquals(1, scans)

        linking = true
        rule.onAllNodesWithText("Scan QR code to link device").assertCountEquals(0)
        rule.onNodeWithText("Scanning...").performClick()
        assertEquals("a link in progress takes no taps", 1, scans)
    }

    @Test
    fun aRefusedSecretKeyCopySaysSo() {
        // account.tsx handleCopySecret: a failed copy alerts instead of crashing.
        val refusing = object : Clipboard {
            override val nativeClipboard: NativeClipboard get() = error("unused")
            override suspend fun getClipEntry(): ClipEntry? = null
            override suspend fun setClipEntry(clipEntry: ClipEntry?) = throw SecurityException("denied")
        }
        rule.setHappyContent {
            CompositionLocalProvider(LocalClipboard provides refusing) {
                AccountScreen(anonId = null, publicId = null, formattedSecretKey = "AAAAA", analyticsOptOut = false, onAnalyticsOptOutChange = {}, onLogout = {}, onBack = {})
            }
        }
        rule.onNodeWithText("Secret Key").performClick()
        rule.node(AccountTags.SECRET_KEY).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Failed to copy secret key").assertIsDisplayed()
    }

    @Test
    fun gitHubRowShowsTheUploadedAvatar() {
        val withAvatar = profile.copy(avatar = ImageRef(64.0, 64.0, "", "a.png", "https://example.com/a.png"))
        rule.setHappyContent {
            AccountScreen(anonId = null, publicId = null, formattedSecretKey = "", analyticsOptOut = false, onAnalyticsOptOutChange = {}, onLogout = {}, onBack = {}, profile = withAvatar)
        }
        rule.onNodeWithText("@ada").performScrollTo()
        val avatar = rule.node(AccountTags.GITHUB_AVATAR).bounds
        assertDp("29 wide", 29, avatar.right - avatar.left)
        assertDp("29 high", 29, avatar.bottom - avatar.top)
    }
}

