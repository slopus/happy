package com.slopus.happy.ui.connection

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.connection.CloudException
import com.slopus.happy.connection.CloudInvitePreview
import com.slopus.happy.connection.CloudInviteRefusal
import com.slopus.happy.connection.CloudInviter
import com.slopus.happy.connection.CloudServer
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** An invite link's Join screen, as each step reads, and one layout for them all. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class CloudInviteScreenTest {
    @get:Rule val rule = createComposeRule()

    private val taps = mutableListOf<String>()
    private val acme = CloudServer(id = "", name = "acme", url = "", displayName = "Acme")
    private val preview = CloudInvitePreview(acme, roleName = "Viewer", inviter = CloudInviter("Ada Lovelace", image = null))
    private var step by mutableStateOf<CloudInviteStep>(CloudInviteStep.Loading)
    private var signedIn by mutableStateOf(true)

    private fun screen(first: CloudInviteStep, signedIn: Boolean = true) {
        step = first
        this.signedIn = signedIn
        rule.setHappyContent {
            CloudInviteScreen(
                step = step,
                signedIn = this.signedIn,
                image = { null },
                onJoin = { taps += "join" },
                onRetry = { taps += "retry" },
                onOtherAccount = { taps += "other" },
                onBack = { taps += "back" },
            )
        }
    }

    @Test
    fun theServerItsRoleAndWhoInvited() {
        screen(CloudInviteStep.Ready(preview))
        rule.onNodeWithText("You’re invited").assertExists()
        rule.onNodeWithText("Join Acme on Happy Cloud.").assertExists()
        rule.onNodeWithText("@acme · Viewer").assertExists()
        rule.onNodeWithText("Ada Lovelace invited you").assertExists()
        // No picture: the inviter's initials.
        rule.onNodeWithText("AL").assertExists()
        rule.onNodeWithText("Join").performClick()
        rule.onNodeWithText("Not now").performClick()
        assertEquals(listOf("join", "back"), taps)
    }

    @Test
    fun signedOutJoinSaysItSignsInFirst() {
        screen(CloudInviteStep.Ready(preview), signedIn = false)
        rule.onNodeWithText("Sign in to join").performClick()
        assertEquals(listOf("join"), taps)
    }

    /** Closed: titled by why, with the sentence under it, no Join, and OK as the one way out. */
    @Test
    fun anInviteThatCantBeUsedIsTitledByWhy() {
        val closed = listOf(
            CloudInviteRefusal.Unknown to ("Invalid invitation" to "This invite link isn’t valid. Check that you opened the whole link."),
            CloudInviteRefusal.Expired to ("Invitation expired" to "This invite has expired. Ask whoever sent it for a new link."),
            CloudInviteRefusal.Revoked to ("Invitation revoked" to "This invite was withdrawn. Ask whoever sent it for a new link."),
            CloudInviteRefusal.UsedUp to ("Invitation used up" to "This invite has already been used. Ask whoever sent it for a new link."),
            CloudInviteRefusal.Accepted to ("Invitation already accepted" to "This invite has already been accepted. If it was you, the server is in your list."),
        )
        screen(CloudInviteStep.Loading)
        for ((refusal, words) in closed) {
            step = CloudInviteStep.Refused(refusal)
            rule.waitForIdle()
            rule.onNodeWithText(words.first).assertExists()
            rule.onNodeWithText(words.second).assertExists()
            rule.onNodeWithText("Join").assertDoesNotExist()
            rule.onNodeWithText("Sign in to join").assertDoesNotExist()
            rule.onNodeWithText("Not now").assertDoesNotExist()
        }
        rule.onNodeWithText("OK").performClick()
        assertEquals(listOf("back"), taps)
    }

    /** The accept couldn't be asked: the offer stays, and its button is Try again, the same press as Join. */
    @Test
    fun anAcceptThatFailedOffersTryAgain() {
        screen(CloudInviteStep.Ready(preview, failure = CloudException.Reason.Unreachable))
        rule.onNodeWithText("You’re invited").assertExists()
        rule.onNodeWithText("Happy Cloud couldn't be reached. Check your connection and try again.").assertExists()
        rule.onNodeWithText("Join").assertDoesNotExist()
        rule.onNodeWithText("Try again").performClick()
        assertEquals(listOf("join"), taps)
    }

    /** The preview couldn't be had: Try again loads it again. */
    @Test
    fun aPreviewThatFailedOffersTryAgain() {
        screen(CloudInviteStep.Unloaded(CloudException.Reason.Unreachable))
        rule.onNodeWithText("Try again").performClick()
        assertEquals(listOf("retry"), taps)
    }

    /** The session gone on the accept: the offer, signed out. */
    @Test
    fun aSessionGoneOffersSignInToJoin() {
        screen(CloudInviteStep.Ready(preview, failure = CloudException.Reason.SignInRequired), signedIn = false)
        rule.onNodeWithText("Try again").assertDoesNotExist()
        rule.onNodeWithText("Sign in to join").performClick()
        assertEquals(listOf("join"), taps)
    }

    @Test
    fun anotherAddressesInviteOffersAnotherAccount() {
        screen(CloudInviteStep.Refused(CloudInviteRefusal.EmailMismatch("s…@…"), preview))
        rule.onNodeWithText("Use your invited email").assertExists()
        rule.onNodeWithText("This invite was sent to ${CloudEmail.unbroken("s…@…")} Sign in with that email to join.").assertExists()
        rule.onNodeWithText("Sign in with another email").performClick()
        assertEquals(listOf("other"), taps)
    }

    /** Steve's rule: scenes don't jump. The title, the details and both buttons stay put through every step. */
    @Test
    fun everyStepKeepsOneLayout() {
        val steps = listOf(
            CloudInviteStep.Loading,
            CloudInviteStep.Ready(preview),
            CloudInviteStep.Ready(preview, joining = true),
            CloudInviteStep.Joined(acme),
            CloudInviteStep.Ready(preview, failure = CloudException.Reason.Unreachable),
            CloudInviteStep.Unloaded(CloudException.Reason.Unreachable),
            CloudInviteStep.Refused(CloudInviteRefusal.Expired),
            CloudInviteStep.Refused(CloudInviteRefusal.Revoked),
            CloudInviteStep.Refused(CloudInviteRefusal.UsedUp),
            CloudInviteStep.Refused(CloudInviteRefusal.Accepted),
            CloudInviteStep.Refused(CloudInviteRefusal.Unknown),
            CloudInviteStep.Refused(CloudInviteRefusal.EmailMismatch("s…@…"), preview),
        )
        screen(steps.first(), signedIn = false)
        // The detail lines are centred, so only their width follows what they say.
        fun DpRect.rows() = DpRect(0.dp, top, 0.dp, bottom)
        fun layout(): List<DpRect> = listOf(
            rule.node(CloudTags.TITLE).bounds,
            rule.node(CloudTags.INVITE_SERVER).bounds.rows(),
            rule.node(CloudTags.INVITER).bounds.rows(),
            rule.node(CloudTags.PRIMARY).bounds,
        )
        val first = layout()
        for (next in steps.drop(1)) {
            step = next
            rule.waitForIdle()
            assertEquals("$next", first, layout())
        }
    }
}
