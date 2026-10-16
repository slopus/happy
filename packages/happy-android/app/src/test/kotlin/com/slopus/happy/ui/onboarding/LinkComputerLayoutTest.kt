package com.slopus.happy.ui.onboarding

import android.content.Context
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.config.LocalSettings
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.hasRole
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

private const val PHONE_HEIGHT = 891

/**
 * Link Your Computer, its offline variant, the terminal block and the
 * onboarding settings, against LinkComputer.tsx, OnboardingContent.tsx,
 * TerminalBlock.tsx and onboarding/settings.tsx.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LinkComputerLayoutTest {
    @get:Rule
    val rule = createComposeRule()

    /** The visible layer of the content slot; invisible copies sit under it with the same tags. */
    private fun visible(tag: String) = rule.onAllNodesWithTag(tag, useUnmergedTree = true).onLast()

    @Test
    fun linkScreenPutsItsActionsWhereWelcomeHasThem() {
        // Both first-run screens stacked, each a full phone tall.
        rule.setHappyContent {
            Column(Modifier.wrapContentHeight(unbounded = true)) {
                Box(Modifier.fillMaxWidth().height(PHONE_HEIGHT.dp)) {
                    WelcomeScreen(customServerLabel = null, creatingAccount = false, onCreateAccount = {}, onRestore = {}, onServer = {})
                }
                Box(Modifier.fillMaxWidth().height(PHONE_HEIGHT.dp)) {
                    OnboardingLinkComputerScreen(
                        customServerLabel = null, ticked = emptySet(), onToggle = {}, busy = false, error = null,
                        onScan = {}, onPasteLink = {}, onSettings = {}, onOpenDesktopSite = {},
                    )
                }
            }
        }
        for (tag in listOf(OnboardingTags.CONTENT, OnboardingTags.PRIMARY, OnboardingTags.SECONDARY)) {
            val nodes = rule.onAllNodesWithTag(tag, useUnmergedTree = true)
            val welcome = nodes[0].bounds
            val link = nodes[1].bounds
            assertBox(tag, link, welcome.left, welcome.top + PHONE_HEIGHT.dp, welcome.right - welcome.left, welcome.bottom - welcome.top)
        }
    }

    @Test
    fun checklistSpecAndTicking() {
        var ticked by mutableStateOf(emptySet<LinkChecklistStep>())
        var scans = 0
        rule.setHappyContent {
            OnboardingLinkComputerScreen(
                customServerLabel = null,
                ticked = ticked,
                onToggle = { step -> ticked = if (step in ticked) ticked - step else ticked + step },
                busy = false,
                error = null,
                onScan = { scans++ },
                onPasteLink = {},
                onSettings = {},
                onOpenDesktopSite = {},
            )
        }
        val content = rule.node(OnboardingTags.CONTENT).bounds
        val title = rule.onNode(hasText("Link Your Computer")).bounds
        assertDp("title top", content.top, title.top)
        val install = visible(OnboardingContentTags.INSTALL_ROW).bounds
        val open = visible(OnboardingContentTags.OPEN_ROW).bounds
        assertDp("rows 24 below the title", title.bottom + 24.dp, install.top)
        assertDp("install row left", 24, install.left)

        val primary = rule.node(OnboardingTags.PRIMARY).bounds
        assertDp("scan button 12 below the content", content.bottom + 12.dp, primary.top)
        rule.onNode(hasText("Scan QR code") and hasClickAction()).assertIsNotEnabled()

        val installBox = rule.onNode(hasText("Install Happy on your computer") and hasClickAction(), useUnmergedTree = false)
        installBox.assertIsOff().performClick().assertIsOn()
        rule.onNode(hasText("Scan QR code") and hasClickAction()).assertIsNotEnabled()
        rule.onNode(hasText("Open Happy and choose Link\u00A0Mobile\u00A0App") and hasClickAction()).performClick()
        rule.onNode(hasText("Scan QR code") and hasClickAction()).assertIsEnabled().performClick()
        assertEquals(1, scans)
        assertEquals(setOf(LinkChecklistStep.Install, LinkChecklistStep.Open), ticked)
        // Ticking changed only the boxes.
        assertBox("open row", visible(OnboardingContentTags.OPEN_ROW).bounds, open.left, open.top, open.right - open.left, open.bottom - open.top)
    }

    @Test
    fun busyAndErrorStates() {
        var error by mutableStateOf<String?>(null)
        var busy by mutableStateOf(true)
        rule.setHappyContent {
            OnboardingLinkComputerScreen(
                customServerLabel = "happy.example.com", ticked = LinkChecklistStep.entries.toSet(), onToggle = {}, busy = busy,
                error = error, onScan = {}, onPasteLink = {}, onSettings = {}, onOpenDesktopSite = {},
            )
        }
        rule.onNodeWithText("Linking…").assertExists()
        rule.onNode(hasText("Can’t scan QR code? Paste link instead") and hasClickAction()).assertIsNotEnabled()
        val errorLine = visible(OnboardingContentTags.ERROR).bounds
        busy = false
        error = "Couldn’t link. Scan the code again."
        rule.onNodeWithText("Couldn’t link. Scan the code again.").assertExists()
        // The error line held its height, so nothing moved.
        assertBox("error line", visible(OnboardingContentTags.ERROR).bounds, errorLine.left, errorLine.top, errorLine.right - errorLine.left, 20.dp)
        rule.node(OnboardingTags.HEADER_SUBTITLE).assertExists()
    }

    @Test
    fun terminalBlockSpec() {
        rule.setHappyContent {
            TerminalBlock(listOf(TerminalLine.Comment("# Prefer the terminal?"), TerminalLine.Command("npm install -g happy")))
        }
        val block = rule.node(TerminalBlockTags.BLOCK).bounds
        val lines = rule.onAllNodesWithTag(TerminalBlockTags.LINE, useUnmergedTree = true)
        val first = lines[0].bounds
        val second = lines[1].bounds
        // 14/18 padding inside the 1 border; 24 per line.
        assertBox("first line", first, block.left + 19.dp, block.top + 15.dp, first.right - first.left, 24.dp)
        assertBox("second line", second, first.left, first.bottom, block.right - block.left - 38.dp, 24.dp)
        assertDp("bottom padding", second.bottom + 15.dp, block.bottom)
        assertDp("block width", PHONE_WIDTH, block.right - block.left)
        val prompt = rule.node(TerminalBlockTags.PROMPT).bounds
        assertDp("prompt starts the command line", second.left, prompt.left)
    }

    @Test
    fun offlineChecklistForOneComputer() {
        var troubleshoot = 0
        rule.setHappyContent {
            LinkComputerChecklistScreen(
                computers = listOf("Mac"), busy = false, approved = false,
                onTroubleshoot = { troubleshoot++ }, onLinkAnother = {},
            )
        }
        val title = rule.node(LinkComputerChecklistTags.TITLE)
        title.assertExists()
        rule.onNodeWithText("Mac is offline").assertExists()
        rule.onNodeWithText("Linked Mac").assertExists()
        val titleBox = title.bounds
        // 4 of side padding inside the 24.
        assertBox("title", titleBox, 24.dp, 16.dp, (PHONE_WIDTH - 48).dp, 30.dp)

        val terminal = rule.node(LinkComputerChecklistTags.TERMINAL).bounds
        assertDp("terminal block indented under the row", 24 + 38, terminal.left)
        val troubleshootButton = rule.node(LinkComputerChecklistTags.TROUBLESHOOT).bounds
        // The second row keeps its 20 below, then the actions' 6.
        assertBox("troubleshoot", troubleshootButton, 24.dp, terminal.bottom + 26.dp, 260.dp, 50.dp)
        val another = rule.node(LinkComputerChecklistTags.LINK_ANOTHER).bounds
        assertBox("link another", another, 24.dp, troubleshootButton.bottom + 8.dp, 260.dp, 44.dp)
        rule.node(LinkComputerChecklistTags.SHOW_ARCHIVED).assertDoesNotExist()

        rule.onNodeWithText("Troubleshoot").performClick()
        assertEquals(1, troubleshoot)
    }

    @Test
    fun offlineChecklistForSeveralComputers() {
        rule.setHappyContent {
            LinkComputerChecklistScreen(
                computers = listOf("Mac", "Linux", "Windows"), busy = true, approved = true,
                onTroubleshoot = {}, onLinkAnother = {}, onShowArchived = {},
            )
        }
        rule.onNodeWithText("Your computers are offline").assertExists()
        rule.onNodeWithText("Linked 3 computers").assertExists()
        rule.node(LinkComputerChecklistTags.SHOW_ARCHIVED).assertExists()
        val another = rule.node(LinkComputerChecklistTags.LINK_ANOTHER).bounds
        val archived = rule.node(LinkComputerChecklistTags.SHOW_ARCHIVED).bounds
        assertDp("show archived 8 below", another.bottom + 8.dp, archived.top)
    }

    @Test
    fun onboardingSettingsSpec() {
        var server = 0
        var logout = 0
        rule.setHappyContent {
            OnboardingSettingsScreen(customServerLabel = null, onServer = { server++ }, onLogout = { logout++ }, onBack = {})
        }
        rule.onNodeWithText("Default").assertExists()
        rule.onNodeWithText("This account has nothing in it yet, so nothing is lost.").assertExists()
        rule.onNodeWithText("Server").performClick()
        assertEquals(1, server)

        rule.onNodeWithText("Log out and start over").performClick()
        rule.onNodeWithText("You will go back to Create account. Nothing on your computer changes.").assertExists()
        rule.onNode(hasText("Logout") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        assertEquals(1, logout)
    }

    @Test
    fun checklistTicksAreTheLocalSetting() {
        val prefs = ApplicationProvider.getApplicationContext<Context>()
            .getSharedPreferences(LocalSettings.PREFS_NAME, Context.MODE_PRIVATE)
            .also { it.edit().clear().commit() }
        val settings = LocalSettings(prefs)
        assertEquals(emptySet<LinkChecklistStep>(), linkChecklistTicked(settings.values.value.linkComputerChecklist))
        settings.toggleLinkChecklist(LinkChecklistStep.Install)
        assertEquals(mapOf("install" to true), settings.values.value.linkComputerChecklist)
        settings.toggleLinkChecklist(LinkChecklistStep.Open)
        settings.toggleLinkChecklist(LinkChecklistStep.Install)
        assertEquals(setOf(LinkChecklistStep.Open), linkChecklistTicked(LocalSettings(prefs).values.value.linkComputerChecklist))
        // Logout clears the local settings, and the checklist with them.
        settings.clear()
        assertEquals(emptySet<LinkChecklistStep>(), linkChecklistTicked(LocalSettings(prefs).values.value.linkComputerChecklist))
    }

    /**
     * TalkBack over the first-run screens, as happy-app labels them: the
     * titles are headers (OnboardingContent, LinkComputer), the wordmark an
     * image named "Happy Engineering", the gear a button named after where it
     * goes, the checklist rows checkboxes, Get help a named button, and the
     * error line a polite live region. Nothing actionable goes unnamed.
     */
    @Test
    fun firstRunScreensReadForTalkBack() {
        var error by mutableStateOf<String?>(null)
        rule.setHappyContent {
            Column(Modifier.wrapContentHeight(unbounded = true)) {
                Box(Modifier.fillMaxWidth().height(PHONE_HEIGHT.dp)) {
                    WelcomeScreen(customServerLabel = null, creatingAccount = false, onCreateAccount = {}, onRestore = {}, onServer = {})
                }
                Box(Modifier.fillMaxWidth().height(PHONE_HEIGHT.dp)) {
                    OnboardingLinkComputerScreen(
                        customServerLabel = null, ticked = emptySet(), onToggle = {}, busy = false, error = error,
                        onScan = {}, onPasteLink = {}, onSettings = {}, onOpenDesktopSite = {},
                    )
                }
            }
        }
        rule.onNode(hasContentDescription("Happy Engineering")).assertExists()
        rule.onNode(hasText("Claude, Codex, Grok\nin your pocket") and isHeading()).assertExists()
        rule.onNode(hasText("Link Your Computer") and isHeading()).assertExists()
        rule.onNode(hasContentDescription("Server") and hasRole(Role.Button)).assertExists()
        rule.onNode(hasContentDescription("Settings") and hasRole(Role.Button)).assertExists()
        rule.onNode(hasText("Install Happy on your computer") and hasRole(Role.Checkbox)).assertIsOff()
        rule.onAllNodes(hasContentDescription("Get help") and hasRole(Role.Button)).assertCountEquals(2)
        error = "Couldn’t link. Scan the code again."
        rule.onNode(hasText("Couldn’t link. Scan the code again.") and SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite), useUnmergedTree = true)
            .assertExists()
        rule.assertActionsLabelled()
    }
}
