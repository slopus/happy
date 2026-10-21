package com.slopus.happy.ui.onboarding

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.max
import androidx.compose.ui.unit.sp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.components.RoundButtonTags
import com.slopus.happy.ui.components.wordmarkWidth
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private const val PHONE_HEIGHT = 891
private val LARGE_TEXT = Density(3f, fontScale = 2f)

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OnboardingLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    private fun setWelcome(customServerLabel: String? = null, density: Density? = null, height: Int? = null) {
        rule.setHappyContent {
            val content = @Composable {
                Box(if (height != null) Modifier.fillMaxWidth().height(height.dp) else Modifier.fillMaxSize()) {
                    WelcomeScreen(
                        customServerLabel = customServerLabel,
                        creatingAccount = false,
                        onCreateAccount = {},
                        onRestore = {},
                        onServer = {},
                    )
                    // Invisible copies of both first-run contents at the block's content width, to measure.
                    Column(Modifier.width((PHONE_WIDTH - 48).dp).alpha(0f)) {
                        WelcomeContent(Modifier.clearAndSetSemantics { testTag = "measure.welcome" })
                        LinkComputerContent(Modifier.clearAndSetSemantics { testTag = "measure.link" })
                    }
                }
            }
            if (density != null) CompositionLocalProvider(LocalDensity provides density, content = content) else content()
        }
    }

    @Test
    fun welcomeBlockReservesBothContentsAndSitsCentred() {
        setWelcome()
        assertBox("header bar", rule.node(HeaderTags.BAR).bounds, 0.dp, 0.dp, PHONE_WIDTH.dp, 64.dp)
        assertBox("gear slot", rule.node(HeaderTags.RIGHT).bounds, (PHONE_WIDTH - 16 - 48).dp, 8.dp, 48.dp, 48.dp)

        // Footer: Get help, 36 high, 16 from the right, 12 above the bottom.
        val help = rule.node(OnboardingTags.GET_HELP).bounds
        assertDp("get help height", 36, help.bottom - help.top)
        assertDp("get help right", PHONE_WIDTH - 16, help.right)
        assertDp("get help bottom", PHONE_HEIGHT - 12, help.bottom)

        val body = rule.node(OnboardingTags.BODY).bounds
        assertBox("body", body, 0.dp, 64.dp, PHONE_WIDTH.dp, (PHONE_HEIGHT - 64 - 48).dp)

        val welcome = rule.node("measure.welcome").bounds
        val link = rule.node("measure.link").bounds
        val reserved = max(welcome.bottom - welcome.top, link.bottom - link.top)

        val content = rule.node(OnboardingTags.CONTENT).bounds
        val primary = rule.node(OnboardingTags.PRIMARY).bounds
        val secondary = rule.node(OnboardingTags.SECONDARY).bounds
        assertDp("content left", 24, content.left)
        assertDp("content width", PHONE_WIDTH - 48, content.right - content.left)
        assertDp("content reserves the taller first-run content", reserved, content.bottom - content.top)
        assertBox("primary", primary, 24.dp, content.bottom + 12.dp, (PHONE_WIDTH - 48).dp, 50.dp)
        assertBox("secondary", secondary, 24.dp, primary.bottom + 4.dp, (PHONE_WIDTH - 48).dp, 44.dp)

        // The block is centred in the body inside its 8 of vertical padding.
        val block = rule.node(OnboardingTags.BLOCK).bounds
        assertDp("block top", content.top, block.top)
        assertDp("block bottom", secondary.bottom, block.bottom)
        assertDp("space above = space below", block.top - (body.top + 8.dp), (body.bottom - 8.dp) - block.bottom)
    }

    @Test
    fun welcomeContentSpec() {
        setWelcome()
        val content = rule.node(OnboardingTags.CONTENT).bounds
        // Merged tree: the invisible reserve copies are cleared from it.
        val wordmark = rule.onNodeWithTag(OnboardingContentTags.WORDMARK).bounds
        assertBox("wordmark", wordmark, 24.dp, content.top, wordmarkWidth(84.dp), 84.dp)
        assertEquals("wordmark width rounds like the RN view box", 229f, wordmarkWidth(84.dp).value)
        val headline = rule.onNodeWithTag(OnboardingContentTags.HEADLINE).bounds
        assertBox("headline", headline, 24.dp, wordmark.bottom + 28.dp, headline.right - headline.left, 68.dp)
        val props = rule.onNodeWithTag(OnboardingContentTags.PROPS).bounds
        assertBox("props", props, 24.dp, headline.bottom + 12.dp, props.right - props.left, 72.dp)
    }

    @Test
    fun largeTextScrollsFromTheTopAndCapsTheHeadline() {
        // Largest system text on a short screen: the block no longer fits.
        setWelcome(density = LARGE_TEXT, height = 600)
        val body = rule.node(OnboardingTags.BODY).bounds
        val block = rule.node(OnboardingTags.BLOCK).bounds
        assertDp("block starts under the body padding", body.top + 8.dp, block.top)
        // Titles grow at most 1.2x: never more than 34 * 1.2 = 40.8 per line.
        val line = minOf(with(LARGE_TEXT) { 34.sp.toDp() }, 40.8.dp)
        val headline = rule.onNodeWithTag(OnboardingContentTags.HEADLINE).bounds
        val lines = (headline.bottom - headline.top) / line
        assertEquals("headline is whole lines of $line", Math.round(lines).toFloat(), lines, 0.02f)
    }

    @Test
    fun customServerHostShowsUnderTheHeader() {
        setWelcome(customServerLabel = "happy.example.com:3005")
        val subtitle = rule.node(OnboardingTags.HEADER_SUBTITLE)
        subtitle.assertIsDisplayed().assertTextEquals("happy.example.com:3005")
        val box = subtitle.bounds
        assertDp("subtitle line height", 14, box.bottom - box.top)
        assertDp("subtitle centred", PHONE_WIDTH / 2f, ((box.left + box.right) / 2).value)
        assertDp("subtitle centred vertically in the bar", 32, (box.top + box.bottom) / 2)
    }

    @Test
    fun restoreScreenWaitsWithASpinnerInTheCodesPlace() {
        rule.setHappyContent { RestoreScreen(qrUrl = null, onBack = {}, onUseSecretKey = {}) }
        val instruction = rule.node(RestoreTags.INSTRUCTION).bounds
        val path = rule.node(RestoreTags.PATH).bounds
        val slot = rule.node(RestoreTags.QR_SLOT).bounds
        val useKey = rule.node(RestoreTags.USE_KEY).bounds
        assertDp("instruction line", 22, instruction.bottom - instruction.top)
        assertDp("path top", instruction.bottom + 8.dp, path.top)
        assertBox("QR slot", slot, ((PHONE_WIDTH - 260) / 2f).dp, path.bottom + 32.dp, 260.dp, 260.dp)
        assertBox("use key button", useKey, ((PHONE_WIDTH - 280) / 2f).dp, slot.bottom + 32.dp, 280.dp, 44.dp)
        // The column is centred in the content area (below the 64 header, inside 24 padding).
        assertDp("centred", instruction.top - (64 + 24).dp, (PHONE_HEIGHT - 24).dp - useKey.bottom)
    }

    @Test
    fun restoreScreenShowsTheCodeInAWhiteFrame() {
        rule.setHappyContent { RestoreScreen(qrUrl = "happy:///account?abc", onBack = {}, onUseSecretKey = {}) }
        rule.node(RestoreTags.QR_SLOT).assertDoesNotExist()
        val path = rule.node(RestoreTags.PATH).bounds
        val frame = rule.node(RestoreTags.QR_FRAME).bounds
        val code = rule.node(RestoreTags.QR_CODE).bounds
        // 260 code inside 12 of padding: a 284 frame.
        assertBox("frame", frame, ((PHONE_WIDTH - 284) / 2f).dp, path.bottom + 32.dp, 284.dp, 284.dp)
        assertBox("code", code, frame.left + 12.dp, frame.top + 12.dp, 260.dp, 260.dp)
        val useKey = rule.node(RestoreTags.USE_KEY).bounds
        assertDp("use key 32 below the frame", frame.bottom + 32.dp, useKey.top)
    }

    @Test
    fun restoreManualSpec() {
        rule.setHappyContent {
            RestoreManualScreen(secretKey = "", onSecretKeyChange = {}, restoring = false, onRestore = {}, onBack = {}, autoFocus = false)
        }
        val body = rule.node(RestoreTags.KEY_BODY).bounds
        assertDp("body left", 24, body.left)
        assertDp("body top", 64 + 24, body.top)
        val input = rule.node(RestoreTags.KEY_INPUT).bounds
        assertBox("input", input, 24.dp, body.bottom + 20.dp, (PHONE_WIDTH - 48).dp, 120.dp)
        val button = rule.onAllNodesWithTag(RoundButtonTags.CONTAINER, useUnmergedTree = true)[0].bounds
        assertBox("restore button", button, 24.dp, input.bottom + 24.dp, (PHONE_WIDTH - 48).dp, 50.dp)
    }

    private fun assertDp(message: String, expected: Float, actual: Float) = assertDp(message, expected.dp, actual.dp)
}
