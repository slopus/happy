package com.slopus.happy.fixture

import android.content.ClipData
import android.content.ClipboardManager
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.slopus.happy.connection.CloudException
import com.slopus.happy.connection.CloudInvitePreview
import com.slopus.happy.connection.CloudInviteRefusal
import com.slopus.happy.connection.CloudInviter
import com.slopus.happy.connection.CloudServer
import com.slopus.happy.connection.EmailSignIn
import com.slopus.happy.ui.connection.CloudEmail
import com.slopus.happy.ui.connection.CloudEmailCodeScreen
import com.slopus.happy.ui.connection.CloudInviteScreen
import com.slopus.happy.ui.connection.CloudInviteStep
import com.slopus.happy.ui.connection.CloudTags
import com.slopus.happy.ui.connection.clipboardText
import com.slopus.happy.ui.connection.mailAppIntent
import com.slopus.happy.ui.theme.HappyTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * An invite link's screen in each of its states, and the email code step
 * with Paste and "Open email app", on a device with its own fonts,
 * clipboard and mail app. Captured to the app's files under
 * `device-evidence/cloud-invite-links/`.
 */
@RunWith(AndroidJUnit4::class)
class CloudInviteLinksDeviceShots {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val evidence = File(instrumentation.targetContext.filesDir, "device-evidence/cloud-invite-links").apply { mkdirs() }

    private fun shot(name: String) {
        rule.waitForIdle()
        Thread.sleep(1200)
        device.takeScreenshot(File(evidence, "$name.png"))
    }

    /** Puts [text] on the clipboard as a mail app would, and waits out the system's own "copied" preview so it is in no capture. */
    private fun copy(clipboard: ClipboardManager, text: String) {
        instrumentation.runOnMainSync { clipboard.setPrimaryClip(ClipData.newPlainText("mail", text)) }
        Thread.sleep(8000)
    }

    /** Every state in one layout: the title, the details and the buttons stay where they are, with the device's own text metrics. */
    @Test
    fun theInviteScreenInEachState() {
        val acme = CloudServer(id = "", name = "acme", url = "", displayName = "Acme")
        val preview = CloudInvitePreview(acme, roleName = "Member", inviter = CloudInviter("Ada Lovelace", image = null))
        var step by mutableStateOf<CloudInviteStep>(CloudInviteStep.Loading)
        var signedIn by mutableStateOf(false)
        rule.setContent {
            HappyTheme {
                CloudInviteScreen(step = step, signedIn = signedIn, image = { null }, onJoin = {}, onRetry = {}, onOtherAccount = {}, onBack = {})
            }
        }
        val states = listOf(
            Triple("invite-offered-signed-out", CloudInviteStep.Ready(preview), false),
            Triple("invite-offered-signed-in", CloudInviteStep.Ready(preview), true),
            Triple("invite-joining", CloudInviteStep.Ready(preview, joining = true), true),
            Triple("invite-accept-failed", CloudInviteStep.Ready(preview, failure = CloudException.Reason.Unreachable), true),
            Triple("invite-preview-failed", CloudInviteStep.Unloaded(CloudException.Reason.Unreachable), false),
            Triple("invite-closed-invalid", CloudInviteStep.Refused(CloudInviteRefusal.Unknown), false),
            Triple("invite-closed-expired", CloudInviteStep.Refused(CloudInviteRefusal.Expired), false),
            Triple("invite-closed-revoked", CloudInviteStep.Refused(CloudInviteRefusal.Revoked), false),
            Triple("invite-closed-used-up", CloudInviteStep.Refused(CloudInviteRefusal.UsedUp), false),
            Triple("invite-closed-accepted", CloudInviteStep.Refused(CloudInviteRefusal.Accepted), false),
            Triple("invite-mismatch", CloudInviteStep.Refused(CloudInviteRefusal.EmailMismatch("a…@example.com"), preview), true),
        )
        fun layout() = listOf(CloudTags.TITLE, CloudTags.INVITE_SERVER, CloudTags.PRIMARY).map { tag ->
            rule.onNodeWithTag(tag, useUnmergedTree = true).getUnclippedBoundsInRoot().let { it.top to it.bottom }
        }
        rule.waitForIdle()
        val first = layout()
        val moved = ArrayList<String>()
        for ((name, next, account) in states) {
            step = next
            signedIn = account
            shot(name)
            if (layout() != first) moved += name
        }
        assertEquals("states whose title, details or button moved", emptyList<String>(), moved)
    }

    /**
     * The code step as a person coming back from their mail app has it: a
     * whole message on the clipboard, Paste taking its six digits into the
     * field, and "Open email app" there only when the device has one.
     */
    @Test
    fun theCodeStepPastesFromTheClipboard() {
        val context = instrumentation.targetContext
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        copy(clipboard, "no code here")
        val mailApp = mailAppIntent(context) != null
        val verified = ArrayList<String>()
        rule.setContent {
            HappyTheme {
                var code by remember { mutableStateOf("") }
                var missed by remember { mutableStateOf(false) }
                var outcome by remember { mutableStateOf<EmailSignIn?>(null) }
                val here = LocalContext.current
                CloudEmailCodeScreen(
                    email = "ada@example.com", code = code, busy = false, outcome = outcome, wait = 0, resendWait = 42,
                    onCode = { code = it; missed = false }, onVerify = { verified += code }, onResend = {}, onChangeEmail = {}, onBack = {},
                    onPaste = {
                        val pasted = CloudEmail.pastedCode(clipboardText(here))
                        missed = pasted == null
                        if (pasted != null) {
                            code = pasted
                            outcome = null
                            verified += pasted
                        }
                    },
                    pasteMissed = missed,
                    onOpenMail = if (mailApp) ({}) else null,
                )
            }
        }
        shot(if (mailApp) "code-step" else "code-step-no-mail-app")
        assertEquals(mailApp, rule.onAllNodes(androidx.compose.ui.test.hasTestTag(CloudTags.OPEN_MAIL), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        if (mailApp) {
            val mail = rule.onNodeWithTag(CloudTags.OPEN_MAIL, useUnmergedTree = true).getUnclippedBoundsInRoot()
            val change = rule.onNodeWithTag(CloudTags.CHANGE_EMAIL, useUnmergedTree = true).getUnclippedBoundsInRoot()
            assertEquals("Open email app and Change email on one line", mail.top, change.top)
        }
        val field = rule.onNodeWithTag(CloudTags.EMAIL_CODE, useUnmergedTree = true).getUnclippedBoundsInRoot()

        rule.onNodeWithTag(CloudTags.EMAIL_PASTE, useUnmergedTree = true).performClick()
        rule.onNodeWithText("There’s no 6-digit code on the clipboard.").assertExists()
        shot("code-step-nothing-to-paste")

        copy(clipboard, "Sign in to Happy\n\nYour code is 493021. It expires in 10 minutes.\n\nIf you didn’t ask for it, ignore this email.")
        rule.onNodeWithTag(CloudTags.EMAIL_PASTE, useUnmergedTree = true).performClick()
        rule.onNodeWithTag(CloudTags.EMAIL_CODE, useUnmergedTree = true).assertTextEquals("493021")
        assertEquals(listOf("493021"), verified)
        shot("code-step-pasted")
        assertEquals("the field stays where it is", field, rule.onNodeWithTag(CloudTags.EMAIL_CODE, useUnmergedTree = true).getUnclippedBoundsInRoot())
    }
}
