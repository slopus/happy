package com.slopus.happy.ui.connection

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.connection.CloudInvitePreview
import com.slopus.happy.connection.CloudInviteRefusal
import com.slopus.happy.connection.CloudServer
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** An invite link's Join screen, as each step reads. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class CloudInviteScreenTest {
    @get:Rule val rule = createComposeRule()

    private val taps = mutableListOf<String>()
    private val preview = CloudInvitePreview(CloudServer(id = "s1", name = "acme", url = "", displayName = "Acme"), roleName = "Viewer")

    private fun screen(step: CloudInviteStep, signedIn: Boolean = true) = rule.setHappyContent {
        CloudInviteScreen(
            step = step,
            signedIn = signedIn,
            image = { null },
            onJoin = { taps += "join" },
            onRetry = { taps += "retry" },
            onOtherAccount = { taps += "other" },
            onBack = { taps += "back" },
        )
    }

    @Test
    fun theServerAndRoleThenJoin() {
        screen(CloudInviteStep.Ready(preview))
        rule.onNodeWithText("You’re invited").assertExists()
        rule.onNodeWithText("Join Acme on Happy Cloud.").assertExists()
        rule.onNodeWithText("@acme").assertExists()
        rule.onNodeWithText("Viewer").assertExists()
        rule.onNodeWithText("Join").performClick()
        assertEquals(listOf("join"), taps)
    }

    @Test
    fun signedOutJoinSaysItSignsInFirst() {
        screen(CloudInviteStep.Ready(preview), signedIn = false)
        rule.onNodeWithText("Sign in to join").performClick()
        assertEquals(listOf("join"), taps)
    }

    @Test
    fun anExpiredInviteSaysSo() {
        screen(CloudInviteStep.Refused(CloudInviteRefusal.Expired))
        rule.onNodeWithText("This invite can’t be used").assertExists()
        rule.onNodeWithText("This invite has expired. Ask whoever sent it for a new link.").assertExists()
        rule.onNodeWithText("OK").performClick()
        assertEquals(listOf("back"), taps)
    }

    @Test
    fun anotherAddressesInviteOffersAnotherAccount() {
        screen(CloudInviteStep.Refused(CloudInviteRefusal.EmailMismatch("s…@…"), preview))
        rule.onNodeWithText("This invite was sent to ${CloudEmail.unbroken("s…@…")}. Sign in with that email to join.").assertExists()
        rule.onNodeWithText("Sign in with another account").performClick()
        assertEquals(listOf("other"), taps)
    }
}
