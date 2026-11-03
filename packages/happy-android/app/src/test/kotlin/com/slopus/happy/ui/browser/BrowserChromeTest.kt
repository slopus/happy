package com.slopus.happy.ui.browser

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onChildAt
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.browser.BrowserProblem
import com.slopus.happy.browser.BrowserProgress
import com.slopus.happy.browser.BrowserProxy
import com.slopus.happy.connection.RequestCategory
import com.slopus.happy.connection.Transport
import com.slopus.happy.connection.TransportResponse
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The browser's own parts (iOS's BrowserLayoutTests and HostedBrowserStatesTests,
 * 34aa464e1): the error page's layout and words, the bar's buttons and
 * what they do over the error page, the header's words and the loading bar.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class BrowserChromeTest {
    @get:Rule
    val rule = createComposeRule()

    private val client = AgentClient(
        object : Transport {
            override suspend fun request(method: String, path: String, credential: String, body: ByteArray?, headers: Map<String, String>, category: RequestCategory) =
                TransportResponse(404, body = ByteArray(0))
            override suspend fun close() {}
        },
        "token",
    )

    private fun failure(problem: BrowserProblem, host: String? = "localhost:3000") {
        rule.setHappyContent {
            Box(Modifier.fillMaxSize()) {
                BrowserFailurePage(problem, computer = "Studio Mac", host = host, onRetry = {}, modifier = Modifier.fillMaxSize())
            }
        }
    }

    /** iOS's BrowserFailureLayout: glyph, title, words and button, 16, 8 and 24 apart, centred in at most 320, 24 above the middle. */
    @Test fun theErrorPageIsCentredALittleAboveTheMiddle() {
        failure(BrowserProblem.ServerNotResponding)
        val page = rule.node(BrowserTags.ERROR).bounds
        val title = rule.node(BrowserTags.ERROR_TITLE).bounds
        val message = rule.node(BrowserTags.ERROR_MESSAGE).bounds
        val retry = rule.node(BrowserTags.RETRY).bounds
        assertDp("page width", 411, page.right - page.left)
        // 411 less 32 each side is wider than 320: the words run 320, centred.
        assertDp("title left", 45.5.dp, title.left)
        assertDp("title width", 320, title.right - title.left)
        assertDp("message left", 45.5.dp, message.left)
        assertDp("title height", 25, title.bottom - title.top)
        assertDp("message under the title", 8.dp, message.top - title.bottom)
        assertDp("button under the message", 24.dp, retry.top - message.bottom)
        assertDp("button centred", 205.5.dp, (retry.left + retry.right) / 2)
        val iconTop = title.top - 16.dp - 52.dp
        val block = retry.bottom - iconTop
        assertDp("lifted 24 above the middle", page.top + (page.bottom - page.top - block) / 2 - 24.dp, iconTop)
    }

    @Test fun theErrorPageSaysWhatWentWrong() {
        failure(BrowserProblem.ServerNotResponding)
        rule.node(BrowserTags.ERROR_TITLE).assertTextEquals("Server Isn’t Responding")
        rule.node(BrowserTags.ERROR_MESSAGE).assertTextEquals("The server on your computer at “localhost:3000” isn’t responding. Make sure it’s running, then try again.")
        rule.node(BrowserTags.RETRY).onChildAt(0).assertTextEquals("Try Again")
    }

    @Test fun theComputerIsNamedWhenItIsUnreachable() {
        failure(BrowserProblem.ComputerUnreachable, host = null)
        rule.node(BrowserTags.ERROR_TITLE).assertTextEquals("Can’t Reach Studio Mac")
        rule.node(BrowserTags.ERROR_MESSAGE).assertTextEquals("Pages open through Studio Mac, and it isn’t answering. Make sure it’s awake and Happy is running there.")
    }

    @Test fun anEmptyErrorStatusNamesItsStatus() {
        failure(BrowserProblem.Http(404, "Not Found"))
        rule.node(BrowserTags.ERROR_TITLE).assertTextEquals("Page Error 404")
        rule.node(BrowserTags.ERROR_MESSAGE).assertTextEquals("The server answered “Not Found” with nothing to show.")
    }

    @Test fun beforeAPageOnlyNothingButTryAgainWorks() {
        val state = BrowserState()
        rule.setHappyContent { Row { BrowserControls(state) } }
        rule.node(BrowserTags.BACK).assertIsNotEnabled()
        rule.node(BrowserTags.FORWARD).assertIsNotEnabled()
        rule.node(BrowserTags.RELOAD).assertIsNotEnabled()
        rule.node(BrowserTags.SHARE).assertIsNotEnabled()
        // Opening failed: reload is Try Again, which opens the page again.
        rule.runOnIdle { state.fail(BrowserProblem.ComputerUnreachable, null) }
        rule.node(BrowserTags.RELOAD).assertIsEnabled().onChildAt(0).assertContentDescriptionEquals("Reload")
        rule.node(BrowserTags.RELOAD).performClick()
        rule.runOnIdle {
            assertNull(state.problem)
            assertEquals(1, state.attempt)
            assertEquals(BrowserProgress.Phase.Loading, state.progress.phase)
        }
    }

    @Test fun theLinkComingBackOpensWhatFailedForWantOfIt() {
        val state = BrowserState()
        state.fail(BrowserProblem.ComputerUnreachable, "https://example.com/a")
        state.linkChanged(com.slopus.happy.browser.BrowserLink.Offline)
        assertEquals(BrowserProblem.ComputerUnreachable, state.problem)
        state.linkChanged(com.slopus.happy.browser.BrowserLink.Online)
        assertNull(state.problem)
        assertEquals(1, state.attempt)
        // A page error isn't the link's: it stays.
        state.fail(BrowserProblem.Http(500), "https://example.com/a")
        state.linkChanged(com.slopus.happy.browser.BrowserLink.Offline)
        state.linkChanged(com.slopus.happy.browser.BrowserLink.Online)
        assertEquals(BrowserProblem.Http(500), state.problem)
    }

    @Test fun webViewsOwnErrorDocumentIsNoNewLoad() {
        val state = BrowserState()
        state.started("http://localhost:5999/")
        state.failed(android.webkit.WebViewClient.ERROR_CONNECT, "net::ERR_CONNECTION_REFUSED", "http://localhost:5999/")
        assertEquals(BrowserProblem.ServerNotResponding, state.problem)
        // WebView then commits its error document for the same address: the bar stays hidden and the error page up.
        state.started("http://localhost:5999/")
        assertEquals(BrowserProgress(), state.progress)
        assertEquals(false, state.loading)
        state.finished()
        assertEquals(BrowserProgress(), state.progress)
        assertEquals(BrowserProblem.ServerNotResponding, state.problem)
    }

    @Test fun theRendererStoppingTwiceShowsTheErrorPage() {
        val state = BrowserState()
        state.started("https://example.com/")
        state.finished()
        state.crashed()
        assertNull(state.problem)
        assertEquals(1, state.generation)
        // The quiet reload, which WebView may finish twice.
        state.started("https://example.com/")
        state.finished()
        state.finished()
        state.crashed()
        assertEquals(BrowserProblem.Crashed, state.problem)
        assertEquals("https://example.com/", state.failedUrl)
        // Try Again, then another page stopping: one quiet reload again.
        state.retry()
        state.started("https://example.com/")
        state.finished()
        state.started("https://example.com/next")
        state.crashed()
        assertNull(state.problem)
    }

    @Test fun aLoadWithNoNetworkGivesUpAndOpensWhenTheNetworkIsBack() {
        val state = BrowserState()
        state.linkChanged(com.slopus.happy.browser.BrowserLink.NoNetwork)
        // Nothing loading: nothing to give up.
        state.offline()
        assertNull(state.problem)
        state.begin()
        state.offline()
        assertEquals(BrowserProblem.NoNetwork, state.problem)
        assertEquals(BrowserProgress(), state.progress)
        // The phone's network back, then the computer's connection: the page opens again by itself.
        state.linkChanged(null)
        assertEquals(BrowserProblem.NoNetwork, state.problem)
        state.linkChanged(com.slopus.happy.browser.BrowserLink.Online)
        assertNull(state.problem)
        assertEquals(1, state.attempt)
        assertEquals(BrowserProgress.Phase.Loading, state.progress.phase)
    }

    @Test fun theHeaderIsThePagesTitleOverItsHost() {
        val state = BrowserState()
        assertEquals("example.com" to null, browserHeader(state, "example.com"))
        state.page = BrowserPage("https://docs.example.com:8443/guide", BrowserProxy.Scope.Workspace(client) { "ws" })
        assertEquals("docs.example.com" to null, browserHeader(state, "fallback"))
        state.title("The Guide")
        assertEquals("The Guide" to "docs.example.com", browserHeader(state, "fallback"))
        // A title that is only the address is no title.
        state.title("https://docs.example.com:8443/guide")
        assertEquals("docs.example.com" to null, browserHeader(state, "fallback"))
        state.title("The Guide")
        state.fail(BrowserProblem.TimedOut, "https://other.example.com/x")
        assertEquals("other.example.com" to null, browserHeader(state, "fallback"))
        assertEquals("other.example.com", BrowserState.address("https://other.example.com/x"))
        assertEquals("localhost:3000", BrowserState.address("http://localhost:3000/"))
        assertNull(BrowserState.address("http://a1.happy-artifact.invalid/index.html"))
    }

    @Test fun theLoadingBarSaysHowFarWhileLoading() {
        val state = BrowserState()
        rule.setHappyContent { BrowserProgressBar(state.progress, onFaded = state::faded) }
        rule.node(BrowserTags.PROGRESS).assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.ProgressBarRangeInfo))
        assertDp("bar height", 2.5.dp, rule.node(BrowserTags.PROGRESS).bounds.let { it.bottom - it.top })
        rule.runOnIdle { state.begin() }
        rule.node(BrowserTags.PROGRESS).assert(SemanticsMatcher.expectValue(SemanticsProperties.ProgressBarRangeInfo, ProgressBarRangeInfo(0.1f, 0f..1f)))
        rule.runOnIdle { state.estimate(0.5f) }
        rule.node(BrowserTags.PROGRESS).assert(SemanticsMatcher.expectValue(SemanticsProperties.ProgressBarRangeInfo, ProgressBarRangeInfo(0.5f, 0f..1f)))
    }
}
