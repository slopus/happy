package com.slopus.happy.ui

import android.os.Looper
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.auth.AuthState
import com.slopus.happy.crypto.AccountLink
import com.slopus.happy.crypto.decodeBase64
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.onboarding.RestoreTags
import com.slopus.happy.ui.start.StartTags
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Duration

/**
 * Restore by QR when the request fails: the code's place says so with
 * Retry instead of a spinner with nothing behind it, Retry is a new request
 * with its own key, and an attempt that was replaced or left behind never
 * asks again nor signs in. The whole app against the in-memory server.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class RestoreRetryTest {
    @get:Rule
    val rule = createComposeRule()

    private val server = FakeHappyServer().start()
    private val graph = AppGraph(
        context = ApplicationProvider.getApplicationContext(),
        clientId = "android/test",
        defaultServerUrl = server.url,
        secureStoreKeys = SoftwareKeys(),
        databaseName = null,
    )

    @After
    fun tearDown() = server.close()

    private fun openRestore() {
        rule.waitUntilAtLeastOneExists(hasTestTag(StartTags.CONTENT), 5_000)
        rule.onNodeWithContentDescription("More").performClick()
        rule.onNodeWithText("Restore Legacy Account").performClick()
    }

    /** The key the code on screen carries. */
    private fun shownKey(): String {
        rule.waitUntilAtLeastOneExists(hasTestTag(RestoreTags.QR_CODE), 5_000)
        val keys = synchronized(server) { server.accountRequests.keys.toList() }
        return keys.single { rule.isShowing(it) }
    }

    private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.isShowing(key: String): Boolean = runCatching {
        onNode(hasTestTag(RestoreTags.QR_CODE), useUnmergedTree = true)
            .assertContentDescriptionEquals(AccountLink.linkUrl(decodeBase64(key)))
    }.isSuccess

    /** How often [key] has been registered or asked about. */
    private fun asks(key: String): Int =
        server.requestsTo("/v1/auth/account/request").count { it.body!!.utf8() == """{"publicKey":"$key"}""" }

    private fun approve(key: String) = server.approveAccountRequest(decodeBase64(key), AccountLink.sealSecret(server.secret, decodeBase64(key)))

    /**
     * Waits while the wait's second-long pauses go by: they are delays on the
     * main looper, which Robolectric holds still until time is moved on.
     */
    private fun waitPolling(condition: () -> Boolean) = rule.waitUntil(10_000) {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(250))
        condition()
    }

    private fun signedIn() = graph.auth.state.value is AuthState.SignedIn

    private fun waitForFailure() {
        rule.waitUntilAtLeastOneExists(hasTestTag(RestoreTags.FAILED), 10_000)
        // Nothing is waiting any more, so nothing turns.
        rule.node(RestoreTags.QR_SLOT).assertDoesNotExist()
        rule.node(RestoreTags.QR_CODE).assertDoesNotExist()
    }

    @Test
    fun aRequestThatCannotBeRegisteredSaysSoAndRetryStartsANewOneThatSignsIn() {
        synchronized(server) { server.failAccountRequests.add(500) }
        rule.setContent { HappyApp(graph) }
        openRestore()
        waitForFailure()
        // Back and the secret key stay where they were.
        rule.node(RestoreTags.USE_KEY).assertExists()
        rule.onNodeWithContentDescription("Back").assertExists()

        rule.node(RestoreTags.RETRY).performClick()
        val key = shownKey()
        rule.node(RestoreTags.FAILED).assertDoesNotExist()
        approve(key)
        waitPolling { signedIn() }
        assertEquals(setOf(key), synchronized(server) { server.accountRequests.keys.toSet() })
    }

    @Test
    fun aWaitThatFailsIsReplacedByRetryAndNeverAsksOrSignsInAgain() {
        rule.setContent { HappyApp(graph) }
        openRestore()
        val first = shownKey()
        waitPolling { asks(first) >= 2 }
        synchronized(server) { server.failAccountRequests.add(500) }
        waitForFailure()
        val firstAsks = asks(first)

        rule.node(RestoreTags.RETRY).performClick()
        val second = shownKey()
        assertNotEquals(first, second)
        // The first request is approved after it was given up: nothing may come of it.
        approve(first)
        waitPolling { asks(second) >= 3 }
        assertEquals("the replaced wait asked again", firstAsks, asks(first))
        assertTrue("the replaced request signed in", !signedIn())

        approve(second)
        waitPolling { signedIn() }
    }

    @Test
    fun leavingTheScreenStopsTheWait() {
        rule.setContent { HappyApp(graph) }
        openRestore()
        val left = shownKey()
        rule.onNodeWithContentDescription("Back").performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag(StartTags.CONTENT), 5_000)
        val leftAsks = asks(left)
        approve(left)

        // Coming back is a new request; while it asks a few times the one left behind stays silent.
        openRestore()
        val again = shownKey()
        assertNotEquals(left, again)
        waitPolling { asks(again) >= 3 }
        assertEquals("the left wait asked again", leftAsks, asks(left))
        assertTrue("the left request signed in", !signedIn())
    }

    /**
     * Rotation doesn't recreate the activity (`configChanges`); a recreation
     * from the system rebuilds the screen around the same request, so the
     * code on screen is the one the other phone may already have scanned,
     * and a failure stays a failure rather than quietly starting over.
     */
    @Test
    fun aRecreatedScreenKeepsItsRequestAndItsFailure() {
        val restoration = StateRestorationTester(rule)
        restoration.setContent { HappyApp(graph) }
        openRestore()
        val key = shownKey()

        restoration.emulateSavedInstanceStateRestore()
        assertEquals(key, shownKey())
        assertEquals(setOf(key), synchronized(server) { server.accountRequests.keys.toSet() })

        synchronized(server) { server.failAccountRequests.add(500) }
        waitForFailure()
        restoration.emulateSavedInstanceStateRestore()
        rule.waitUntilAtLeastOneExists(hasTestTag(RestoreTags.FAILED), 5_000)
        assertEquals(setOf(key), synchronized(server) { server.accountRequests.keys.toSet() })
    }
}
