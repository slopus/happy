package com.slopus.happy.ui.browser

import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalTextToolbar
import androidx.compose.ui.platform.TextToolbar
import androidx.compose.ui.platform.TextToolbarStatus
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.TextLayoutResult
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ChatRow
import com.slopus.happy.chat.markdown.parseMarkdown
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.artifacts.ArtifactActions
import com.slopus.happy.ui.artifacts.ArtifactLink
import com.slopus.happy.ui.artifacts.ArtifactScreen
import com.slopus.happy.ui.artifacts.ArtifactUi
import com.slopus.happy.ui.changelog.Changelog
import com.slopus.happy.ui.changelog.ChangelogEntry
import com.slopus.happy.ui.changelog.ChangelogScreen
import com.slopus.happy.ui.changelog.ChangelogTags
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.MessageView
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.connection.PlaceRead
import com.slopus.happy.ui.connection.SurfaceBody
import com.slopus.happy.ui.connection.SurfaceScreen
import com.slopus.happy.ui.onboarding.DESKTOP_URL
import com.slopus.happy.ui.onboarding.LinkComputerContent
import com.slopus.happy.ui.onboarding.OnboardingContentTags
import com.slopus.happy.ui.settings.AboutActions
import com.slopus.happy.ui.settings.AboutCard
import com.slopus.happy.ui.settings.AboutInfo
import com.slopus.happy.ui.settings.SettingsSpec
import com.slopus.happy.ui.troubleshoot.TroubleshootScreen
import com.slopus.happy.ui.troubleshoot.TroubleshootTags
import com.slopus.happy.ui.chat.CopyMenuTags
import com.slopus.happy.ui.chat.LongPressCopyable
import com.slopus.happy.ui.chat.MarkdownTags
import com.slopus.happy.ui.chat.MarkdownView
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Link taps and long presses in chat Markdown: which browser a tap opens
 * in each mode, and that a long press opens only the link menu (no tap,
 * no copy menu, no text selection), whose choices go where they say. Then
 * every other place a link is pressed: artifact and Surface documents, a
 * legacy chat message, What's New, Troubleshoot, onboarding, the bot face
 * credit and About's rows.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LinksTest {
    @get:Rule
    val rule = createComposeRule()

    private val url = "https://example.com/page"
    private val blocks = parseMarkdown("[example link here](https://example.com/page) and some more words after it")

    private class Calls {
        val taps = mutableListOf<String>()
        val inApp = mutableListOf<String>()
        val external = mutableListOf<String>()
    }

    private fun opener(calls: Calls, proxied: Boolean = true) = LinkOpener(
        proxied = proxied,
        computer = if (proxied) "Studio" else null,
        tap = { calls.taps += it },
        inApp = { calls.inApp += it },
        external = { calls.external += it },
    )

    private fun show(opener: LinkOpener, wrap: @Composable (@Composable () -> Unit) -> Unit = { it() }) {
        rule.setHappyContent { ProvideLinks(opener) { wrap { MarkdownView(blocks) } } }
    }

    /** A point on the link's first word. */
    private val onLink = Offset(30f, 30f)

    /** A point on the plain words after it. */
    private fun androidx.compose.ui.test.TouchInjectionScope.offLink() = Offset(width * 0.75f, 30f)

    @Test fun tapOpensTheLinkOnceTheDefaultWay() {
        val calls = Calls()
        show(opener(calls))
        rule.node(MarkdownTags.TEXT).performTouchInput { click(onLink) }
        rule.waitForIdle()
        assertEquals(listOf(url), calls.taps)
        assertTrue(calls.inApp.isEmpty() && calls.external.isEmpty())
        assertEquals(0, rule.onAllNodesWithTag(LinkTags.MENU, useUnmergedTree = true).fetchSemanticsNodes().size)
    }

    @Test fun tapOffTheLinkOpensNothing() {
        val calls = Calls()
        show(opener(calls))
        rule.node(MarkdownTags.TEXT).performTouchInput { click(offLink()) }
        rule.waitForIdle()
        assertTrue(calls.taps.isEmpty())
    }

    @Test fun longPressOpensOnlyTheMenu() {
        val calls = Calls()
        show(opener(calls))
        rule.node(MarkdownTags.TEXT).performTouchInput { longClick(onLink) }
        rule.waitForIdle()
        rule.node(LinkTags.MENU).assertIsDisplayed()
        rule.node(LinkTags.URL).assertIsDisplayed()
        assertTrue("A long press is not a tap", calls.taps.isEmpty())
    }

    @Test fun menuChoicesGoWhereTheySay() {
        val calls = Calls()
        val opener = opener(calls)
        show(opener)
        for ((tag, expected) in listOf(LinkTags.IN_APP to calls.inApp, LinkTags.EXTERNAL to calls.external)) {
            rule.node(MarkdownTags.TEXT).performTouchInput { longClick(onLink) }
            rule.waitForIdle()
            rule.node(tag).performClick()
            rule.waitForIdle()
            assertEquals(listOf(url), expected)
            assertEquals(null, opener.menu)
        }
        rule.node(MarkdownTags.TEXT).performTouchInput { longClick(onLink) }
        rule.waitForIdle()
        rule.node(LinkTags.COPY).performClick()
        rule.waitForIdle()
        val clipboard = ApplicationProvider.getApplicationContext<android.content.Context>().getSystemService(android.content.ClipboardManager::class.java)
        assertEquals(url, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertTrue(calls.taps.isEmpty())
    }

    /**
     * A selection that started would also show the Magnifier, which has no
     * surface under Robolectric and fails the test (a long press off the link
     * does exactly that), so passing here also means none started.
     */
    @Test fun longPressInSelectableTextDoesNotStartSelection() {
        val calls = Calls()
        val toolbar = object : TextToolbar {
            var shown = 0
            override val status get() = TextToolbarStatus.Hidden
            override fun hide() {}
            override fun showMenu(rect: Rect, onCopyRequested: (() -> Unit)?, onPasteRequested: (() -> Unit)?, onCutRequested: (() -> Unit)?, onSelectAllRequested: (() -> Unit)?) {
                shown++
            }
        }
        show(opener(calls)) { content -> CompositionLocalProvider(LocalTextToolbar provides toolbar) { SelectionContainer { content() } } }
        rule.node(MarkdownTags.TEXT).performTouchInput { longClick(onLink) }
        rule.waitForIdle()
        rule.node(LinkTags.MENU).assertIsDisplayed()
        assertEquals("No selection toolbar under the link menu", 0, toolbar.shown)
    }

    @Test fun longPressInACopyableBubbleShowsOnlyTheLinkMenu() {
        val calls = Calls()
        show(opener(calls)) { content -> LongPressCopyable(text = "copy me") { content() } }
        rule.node(MarkdownTags.TEXT).performTouchInput { longClick(onLink) }
        rule.waitForIdle()
        rule.node(LinkTags.MENU).assertIsDisplayed()
        assertEquals(0, rule.onAllNodesWithTag(CopyMenuTags.MENU, useUnmergedTree = true).fetchSemanticsNodes().size)
        // Control: off the link, the bubble's copy menu still opens.
        rule.onNodeWithTag(LinkTags.IN_APP, useUnmergedTree = true).performClick()
        rule.waitForIdle()
        rule.node(MarkdownTags.TEXT).performTouchInput { longClick(offLink()) }
        rule.waitForIdle()
        rule.node(CopyMenuTags.MENU).assertExists()
    }

    @Test fun aDragFromALinkIsNotATap() {
        val calls = Calls()
        show(opener(calls))
        rule.node(MarkdownTags.TEXT).performTouchInput { swipeUp(startY = 30f, endY = 0f) }
        rule.waitForIdle()
        assertTrue(calls.taps.isEmpty())
    }

    @Test fun legacyTapsUseTheSystemHandlerAsBefore() {
        val opened = mutableListOf<String>()
        val system = object : UriHandler { override fun openUri(uri: String) { opened += uri } }
        val opener = LinkOpener.legacy(ApplicationProvider.getApplicationContext(), system)
        assertEquals(false, opener.proxied)
        show(opener)
        rule.node(MarkdownTags.TEXT).performTouchInput { click(onLink) }
        rule.waitForIdle()
        assertEquals(listOf(url), opened)
    }

    // Every other place a link can be pressed: a long press opens the menu for its address and
    // nothing else; a tap still does what it did there.

    /** The middle of [node]'s first link, from its own text layout. */
    private fun linkCenter(node: SemanticsNodeInteraction): Offset {
        val layouts = mutableListOf<TextLayoutResult>()
        node.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action!!.invoke(layouts)
        val layout = layouts.first()
        val text = layout.layoutInput.text
        val link = text.getLinkAnnotations(0, text.length).first()
        return layout.getBoundingBox((link.start + link.end) / 2).center
    }

    /** Long-presses [node]'s link: only the menu opens, for [address]. Then a tap on it, which the site handles. */
    private fun assertLinkSite(node: () -> SemanticsNodeInteraction, address: String, calls: Calls) {
        val at = linkCenter(node())
        node().performTouchInput { longClick(at) }
        rule.waitForIdle()
        rule.node(LinkTags.MENU).assertIsDisplayed()
        rule.node(LinkTags.URL).assertTextEquals(address)
        assertTrue("A long press is not a tap", calls.taps.isEmpty())
        rule.node(LinkTags.COPY).performClick()
        rule.waitForIdle()
        node().performTouchInput { click(at) }
        rule.waitForIdle()
    }

    @Test fun artifactDocumentLinks() {
        val calls = Calls()
        val web = mutableListOf<String>()
        val document = ArtifactUi.Document("notes.md", blocks, emptyMap(), emptyList())
        val actions = ArtifactActions(onBack = {}, link = { raw, _ -> ArtifactLink.Web(raw) }, onOpenWeb = { web += it })
        rule.setHappyContent { ProvideLinks(opener(calls)) { ArtifactScreen("Notes", document, null, "Studio", actions) } }
        assertLinkSite({ rule.node(MarkdownTags.TEXT) }, url, calls)
        assertEquals("A tap resolves through the artifact, as before", listOf(url), web)
        assertTrue(calls.taps.isEmpty())
    }

    @Test fun surfaceDocumentLinks() {
        val calls = Calls()
        rule.setHappyContent {
            ProvideLinks(opener(calls)) {
                SurfaceScreen("Plan", PlaceRead.Ready(SurfaceBody.Document("[example link here](https://example.com/page) and more")), {}, {}, {})
            }
        }
        assertLinkSite({ rule.node(MarkdownTags.TEXT) }, url, calls)
        assertEquals(listOf(url), calls.taps)
    }

    @Test fun legacyChatMessageLinks() {
        val calls = Calls()
        val row = ChatRow.AgentText(ChatMessage.AgentText("m1", 1L, "x"), blocks)
        rule.setHappyContent {
            ProvideLinks(opener(calls, proxied = false)) { MessageView(row, userMessageBubblePalette(null, false), MessageCallbacks()) }
        }
        assertLinkSite({ rule.node(MarkdownTags.TEXT) }, url, calls)
        assertEquals(listOf(url), calls.taps)
    }

    @Test fun changelogSummaryLinks() {
        val calls = Calls()
        val changelog = Changelog(listOf(ChangelogEntry("Version 9", summary = "Read [the notes](https://example.com/page) first.")), "Version 9")
        rule.setHappyContent { ProvideLinks(opener(calls)) { ChangelogScreen(changelog, onViewed = {}, onBack = {}) } }
        assertLinkSite({ rule.node(ChangelogTags.SUMMARY) }, url, calls)
        assertEquals(listOf(url), calls.taps)
    }

    @Test fun troubleshootLinks() {
        val calls = Calls()
        val opened = mutableListOf<String>()
        rule.setHappyContent {
            ProvideLinks(opener(calls)) { TroubleshootScreen(emptyList(), "x", onOpenMachine = {}, onOpenUrl = { opened += it }, onBack = {}) }
        }
        assertLinkSite({ rule.node(TroubleshootTags.DESKTOP_LINK) }, DESKTOP_URL, calls)
        assertEquals(listOf(DESKTOP_URL), opened)
    }

    @Test fun onboardingInstallLink() {
        val calls = Calls()
        var opened = 0
        rule.setHappyContent { ProvideLinks(opener(calls)) { LinkComputerContent(onToggle = {}, onOpenDesktopSite = { opened++ }) } }
        assertLinkSite({ rule.node(OnboardingContentTags.INSTALL_BODY) }, DESKTOP_URL, calls)
        assertEquals(1, opened)
    }

    @Test fun aboutRowsOfferTheMenuAndStillOpenOnATap() {
        val calls = Calls()
        val opened = mutableListOf<String>()
        rule.setHappyContent { ProvideLinks(opener(calls)) { AboutCard(AboutInfo("1.0"), AboutActions(onOpenUrl = { opened += it })) } }
        for ((title, address) in listOf("GitHub" to SettingsSpec.GITHUB_URL, "Privacy Policy" to SettingsSpec.PRIVACY_URL)) {
            rule.onNodeWithText(title).performTouchInput { longClick() }
            rule.waitForIdle()
            rule.node(LinkTags.URL).assertTextEquals(address)
            rule.node(LinkTags.COPY).performClick()
            rule.waitForIdle()
        }
        assertTrue(opened.isEmpty())
        rule.onNodeWithText("GitHub").performClick()
        assertEquals(listOf(SettingsSpec.GITHUB_URL), opened)
    }

    @Test fun agentLinksBrowseInTheAppAndHandOtherSchemesToTheSystem() {
        val browsed = mutableListOf<String>()
        val opener = LinkOpener.agent(ApplicationProvider.getApplicationContext(), "Studio") { browsed += it }
        opener.open(url)
        opener.openInApp("http://localhost:3000/")
        opener.open("mailto:someone@example.com")
        assertEquals(listOf(url, "http://localhost:3000/"), browsed)
        val started = org.robolectric.Shadows.shadowOf(ApplicationProvider.getApplicationContext<android.app.Application>()).nextStartedActivity
        assertEquals("mailto:someone@example.com", started?.dataString)
        assertTrue(opener.proxied)
    }

    @Test fun agentLinksTheAppOpensItselfGoNowhereElse() {
        val browsed = mutableListOf<String>()
        val app = mutableListOf<String>()
        val opener = LinkOpener.agent(ApplicationProvider.getApplicationContext(), "Studio", app = { url -> url.startsWith("happy://").also { if (it) app += url } }) { browsed += it }
        opener.open("happy://artifacts/r1")
        opener.open(url)
        assertEquals(listOf("happy://artifacts/r1"), app)
        assertEquals(listOf(url), browsed)
        assertEquals(null, org.robolectric.Shadows.shadowOf(ApplicationProvider.getApplicationContext<android.app.Application>()).nextStartedActivity)
    }

    @Test fun legacyTapsLeaveTheAppsOwnLinksAlone() {
        val opened = mutableListOf<String>()
        val system = object : UriHandler { override fun openUri(uri: String) { opened += uri } }
        val opener = LinkOpener.legacy(ApplicationProvider.getApplicationContext(), system)
        opener.open("happy://artifacts/r1")
        opener.open(com.slopus.happy.references.HappyReferences.link(com.slopus.happy.references.HappyReferences.Reference("agent", "a1")))
        opener.open(url)
        assertEquals(listOf(url), opened)
    }
}
