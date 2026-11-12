package com.slopus.happy.ui.connection

import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.R
import com.slopus.happy.connection.CloudAccountState
import com.slopus.happy.connection.CloudException
import com.slopus.happy.connection.CloudServer
import com.slopus.happy.connection.PasswordSignIn
import com.slopus.happy.connection.ServerAuthException
import androidx.test.core.app.ApplicationProvider
import java.security.MessageDigest
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.start.StartGalleryTags
import com.slopus.happy.ui.start.StartSlide
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * Happy Cloud's steps, desktop's (CloudConnectScreen.tsx): the welcome's
 * slides and Continue, its hidden test-account sign-in, and Join a server.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class CloudWelcomeTest {
    @get:Rule val rule = createComposeRule()

    private val tries = mutableListOf<Pair<String, String>>()
    private val answers = ArrayDeque<PasswordSignIn>()
    private val taps = mutableListOf<String>()

    private fun screen(
        state: CloudAccountState = CloudAccountState.SignedOut(),
        servers: List<CloudServer>? = null,
        here: Set<String> = emptySet(),
        joins: Map<String, CloudJoin> = emptyMap(),
    ) = rule.setHappyContent {
        CloudScreen(
            state = state,
            servers = servers,
            failure = null,
            here = here,
            joins = joins,
            image = { null },
            onOpenBrowser = { taps += "browser ${it.id}" },
            onSignInWithGoogle = { taps += "google" },
            onEmail = { taps += "email" },
            signInWithPassword = { login, password -> tries += login to password; answers.removeFirst() },
            onReload = {},
            onJoinServer = { taps += "join ${it.name}" },
            onContinue = { taps += "continue" },
            onCreate = { taps += "create" },
            onSignOut = { taps += "signOut" },
            onBack = { taps += "back" },
        )
    }

    /** The clock moves only as told: left to itself, it would run out each replay of the scene between presses. */
    private fun press(times: Int, apartMillis: Long = 100) {
        rule.mainClock.autoAdvance = false
        repeat(times) {
            // Whichever slide shows: they move on by themselves while the presses go.
            val shown = CloudSlides.indices.first { runCatching { rule.node(StartGalleryTags.art(it)).fetchSemanticsNode() }.isSuccess }
            rule.node(StartGalleryTags.art(shown)).performClick()
            rule.mainClock.advanceTimeBy(apartMillis)
        }
        rule.mainClock.autoAdvance = true
    }

    /**
     * Desktop's five slides in its order, with its words (the first in Liquid
     * Metal), then Sign in with Apple and with GitHub in the first screen's
     * two places, and the quiet Continue with email right under them.
     */
    @Test
    fun theWelcomeIsDesktopsSlidesThenAppleGitHubAndEmail() {
        assertEquals(StartSlide.Art.Cloud, CloudSlides[0].art)
        assertEquals(
            listOf(R.raw.state_robot, R.raw.state_closed_lock, R.raw.state_sparkles, R.raw.state_open_hands),
            CloudSlides.drop(1).map { (it.art as StartSlide.Art.Scene).raw },
        )
        screen()
        rule.onNodeWithText("Happy Cloud").assertExists()
        rule.onNodeWithText("A hardened, high-performance control plane for your agents, hosted by Happy.").assertExists()
        for (title in listOf("Built for lots of agents", "Programmable permissions", "No lock-in", "Private open source")) {
            rule.onNodeWithContentDescription(title).assertExists()
        }
        // Apple where Start is, GitHub where Use Happy Cloud is, as iOS.
        val apple = rule.node(CloudTags.PRIMARY).bounds
        val github = rule.node(CloudTags.SECONDARY).bounds
        rule.node(CloudTags.PRIMARY).assert(hasAnyDescendant(hasText("Sign in with Apple")))
        rule.node(CloudTags.SECONDARY).assert(hasAnyDescendant(hasText("Sign in with GitHub")))
        assertDp("github 12 under apple", apple.bottom + 12.dp, github.top)
        val email = rule.node(CloudTags.EMAIL_SIGN_IN).bounds
        rule.node(CloudTags.EMAIL_SIGN_IN).assert(hasAnyDescendant(hasText("Continue with email")))
        assertDp("email right under github", github.bottom, email.top)
        assertDp("email 24 above the bottom", (891 - 24).dp, email.bottom)
        assertDp("as wide as each other", apple.width, github.width)
        assertDp("email as wide too", apple.width, email.width)
        assertDp("centred", (PHONE_WIDTH / 2f).dp, (apple.left + apple.right) / 2)
        rule.onNodeWithText("Continue").assertDoesNotExist()
        rule.onNodeWithText("Other ways", substring = true).assertDoesNotExist()
        rule.onNodeWithText("Sign in with Apple").performClick()
        rule.onNodeWithText("Sign in with GitHub").performClick()
        rule.onNodeWithText("Continue with email").performClick()
        rule.node(HeaderTags.LEFT).performClick()
        assertEquals(listOf("browser apple", "browser github", "email", "back"), taps)
    }

    /**
     * Continue with Google, Google's button (its G, 20, 10 before the words),
     * 12 over Apple and as wide, a pill as tall as the others; Apple and
     * GitHub stay where they were.
     */
    @Test
    fun continueWithGoogleStandsOverApple() {
        screen()
        val google = rule.node(CloudTags.GOOGLE).bounds
        val apple = rule.node(CloudTags.PRIMARY).bounds
        val github = rule.node(CloudTags.SECONDARY).bounds
        rule.node(CloudTags.GOOGLE).assert(hasAnyDescendant(hasText("Continue with Google")))
        assertDp("apple 12 under google", google.bottom + 12.dp, apple.top)
        assertDp("as tall as apple", apple.height, google.height)
        assertDp("50 tall", 50.dp, google.height)
        assertDp("as wide as apple", apple.width, google.width)
        assertDp("github still right over email", rule.node(CloudTags.EMAIL_SIGN_IN).bounds.top, github.bottom)
        rule.onNodeWithText("Continue with Google").performClick()
        assertEquals(listOf("google"), taps)
    }

    /** While Google's sheet is up or the code is exchanged none can be pressed again. */
    @Test
    fun whileFinishingAllWait() {
        screen(CloudAccountState.Finishing)
        rule.node(CloudTags.GOOGLE).assertIsNotEnabled()
        rule.node(CloudTags.PRIMARY).assertIsNotEnabled()
        rule.node(CloudTags.SECONDARY).assertIsNotEnabled()
        rule.node(CloudTags.EMAIL_SIGN_IN).assertIsNotEnabled()
    }

    /** A failed sign-in stays on the welcome: why, in red over the button, which tries again. */
    @Test
    fun aFailedSignInSaysWhyOverTheButton() {
        screen(CloudAccountState.Failed(ServerAuthException.Reason.Denied))
        rule.node(CloudTags.SLIDES).assertExists()
        rule.onNodeWithText("Sign in with GitHub").performClick()
        assertEquals(listOf("browser github"), taps)
    }

    /** Desktop's scenes, its files byte for byte (assets/animations/PROVENANCE.md at dca9b205). */
    @Test
    fun theScenesAreDesktopsBytes() {
        val resources = ApplicationProvider.getApplicationContext<android.content.Context>().resources
        for ((raw, hash) in listOf(
            R.raw.state_closed_lock to "f6087f51de1ccc7d",
            R.raw.state_open_hands to "7b5b9d98156057d2",
            R.raw.state_cloud_variation to "4833ea8c714e3538",
            R.raw.state_tree to "cb7c9a130992909a",
        )) {
            val bytes = resources.openRawResource(raw).use { it.readBytes() }
            val actual = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            assertEquals(resources.getResourceEntryName(raw), hash, actual.take(16))
        }
    }

    @Test
    fun theHourUpSaysSoOverContinue() {
        screen(CloudAccountState.SignedOut(expired = true))
        rule.onNodeWithText("sign-in lasts an hour", substring = true).assertExists()
        rule.node(CloudTags.PRIMARY).assertExists()
    }

    @Test
    fun nineQuickPressesOrTenSlowOnesRevealNothing() {
        screen()
        press(9)
        rule.node(CloudTags.LOGIN).assertDoesNotExist()
        rule.onNodeWithText("Sign in with a test account.").assertDoesNotExist()
        // A pause, then ten more spread over five seconds: never ten within four.
        rule.mainClock.advanceTimeBy(5_000)
        press(10, apartMillis = 500)
        rule.node(CloudTags.LOGIN).assertDoesNotExist()
        rule.node(CloudTags.PRIMARY).assertExists()
    }

    @Test
    fun tenQuickPressesRevealTheFormAndItsErrorsShowInline() {
        screen()
        press(10)
        rule.onNodeWithText("Sign in with a test account.").assertExists()
        rule.node(CloudTags.LOGIN).performTextInput(" qa-android ")
        rule.node(CloudTags.PASSWORD).performTextInput("hunter22")
        rule.node(CloudTags.PASSWORD).assertTextEquals("••••••••")

        answers += PasswordSignIn.Wrong
        rule.node(CloudTags.PRIMARY).performClick()
        rule.onNodeWithText("That login or password is wrong.").assertExists()
        assertEquals(listOf("qa-android" to "hunter22"), tries)

        answers += PasswordSignIn.Locked(15)
        rule.node(CloudTags.PRIMARY).performClick()
        rule.onNodeWithText("Too many tries. Try again in 15 min.").assertExists()

        answers += PasswordSignIn.Failed(CloudException.Reason.Unreachable)
        rule.node(CloudTags.PRIMARY).performClick()
        rule.onNodeWithText("Too many tries", substring = true).assertDoesNotExist()
        assertEquals(3, tries.size)
        // The browser's sign-in is still there, under it.
        rule.node(CloudTags.SECONDARY).assertExists()
    }

    private val acme = CloudServer(id = "s1", name = "acme", url = "https://acme.happy-clusters.com", displayName = "Acme")
    private val beta = CloudServer(id = "s2", name = "beta", url = "https://beta.happy-clusters.com")

    /** Join a server: each server with Join; Continue only once one is on the phone; Bootstrap a new one under them, and no invite code. */
    @Test
    fun joinAServer() {
        screen(CloudAccountState.SignedIn, servers = listOf(acme, beta))
        rule.onNodeWithText("Join a server").assertExists()
        rule.onNodeWithText("Your account is already on these servers. Join as many as you like.").assertExists()
        rule.onNodeWithText("@acme").assertExists()
        rule.node(CloudTags.PRIMARY).assertDoesNotExist()
        rule.onNodeWithContentDescription("Join Acme").performClick()
        rule.onNodeWithText("Bootstrap a new one").performClick()
        // Invites are links, accepted on the web.
        rule.onNodeWithText("Join with an invite").assertDoesNotExist()
        // Back leaves the account, so the welcome's Continue can use another.
        rule.node(HeaderTags.LEFT).performClick()
        assertEquals(listOf("join acme", "create", "signOut"), taps)
    }

    @Test
    fun aJoinedServerReadsJoinedAndContinueTakesYouIn() {
        screen(CloudAccountState.SignedIn, servers = listOf(acme, beta), here = setOf("https://beta.happy-clusters.com"))
        rule.onNodeWithText("Joined").assertExists()
        rule.onNodeWithContentDescription("Join beta").assertDoesNotExist()
        rule.node(CloudTags.PRIMARY).performClick()
        assertEquals(listOf("continue"), taps)
    }

    /** While one joins, the others wait, Continue waits, and Back stays. */
    @Test
    fun whileOneJoinsNothingElseGoes() {
        screen(CloudAccountState.SignedIn, servers = listOf(acme, beta), here = setOf("https://beta.happy-clusters.com"), joins = mapOf("s1" to CloudJoin.Joining))
        rule.node(CloudTags.PRIMARY).assertIsNotEnabled()
        rule.node(CloudTags.CREATE).assertIsNotEnabled()
        rule.node(HeaderTags.LEFT).performClick()
        assertEquals(emptyList<String>(), taps)
    }

    /** The account's first server: Bootstrap a server says it has none, with no invite to type in. */
    @Test
    fun theFirstBootstrapHasNoInvite() {
        rule.setHappyContent {
            CloudCreateScreen(name = "", availability = null, busy = false, failure = null, onName = {}, onCreate = {}, onBack = {}, first = true)
        }
        rule.onNodeWithText("Bootstrap a server").assertExists()
        rule.onNodeWithText("Your account has no servers yet. Name your team’s first one.").assertExists()
        rule.onNodeWithText("Have an invite? Join a server").assertDoesNotExist()
    }
}
