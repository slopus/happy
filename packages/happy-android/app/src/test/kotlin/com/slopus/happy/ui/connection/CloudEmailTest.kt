package com.slopus.happy.ui.connection

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.connection.CloudException
import com.slopus.happy.connection.EmailSignIn
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.HeaderTags
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * Continue with email's two steps on Happy Cloud's gradient: the address
 * with Send code, then the 6-digit code with Verify, Resend (a minute after
 * each code) and Change email; why either was refused under its field, and
 * a 429's wait on its buttons.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class CloudEmailTest {
    @get:Rule val rule = createComposeRule()

    private val taps = mutableListOf<String>()
    private var outcome by mutableStateOf<EmailSignIn?>(null)
    private var wait by mutableStateOf(0L)
    private var resendWait by mutableStateOf(0L)
    private var busy by mutableStateOf(false)

    private fun emailStep() = rule.setHappyContent {
        var email by androidx.compose.runtime.remember { mutableStateOf("") }
        CloudEmailScreen(
            email = email,
            busy = busy,
            outcome = outcome,
            wait = wait,
            onEmail = { email = it },
            onSend = { taps += "send $email" },
            onBack = { taps += "back" },
        )
    }

    private var mailApp by mutableStateOf(false)
    private var pasteMissed by mutableStateOf(false)

    private fun codeStep() = rule.setHappyContent {
        var code by androidx.compose.runtime.remember { mutableStateOf("") }
        CloudEmailCodeScreen(
            email = "ada@example.com",
            code = code,
            busy = busy,
            outcome = outcome,
            wait = wait,
            resendWait = resendWait,
            onCode = { code = it },
            onVerify = { taps += "verify $code" },
            onResend = { taps += "resend" },
            onChangeEmail = { taps += "change" },
            onBack = { taps += "back" },
            onPaste = { taps += "paste" },
            pasteMissed = pasteMissed,
            onOpenMail = if (mailApp) ({ taps += "mail" }) else null,
        )
    }

    private fun label(tag: String, text: String) = rule.node(tag).assert(hasAnyDescendant(hasText(text)))

    /** The column's 363 (411 less 24 a side), the field 56 tall, Send code 48 above the bottom. */
    @Test
    fun theEmailStepAsksForAnAddress() {
        emailStep()
        rule.onNodeWithText("Sign in with email").assertExists()
        rule.onNodeWithText("We’ll email you a 6-digit code. No password needed.").assertExists()
        val field = rule.node(CloudTags.EMAIL).bounds
        assertDp("field as wide as the column", (PHONE_WIDTH - 48).dp, field.width)
        assertDp("field 56 tall", 56.dp, field.height)
        val send = rule.node(CloudTags.PRIMARY).bounds
        assertDp("send 48 above the bottom", (891 - 48).dp, send.bottom)
        assertDp("send centred", (PHONE_WIDTH / 2f).dp, (send.left + send.right) / 2)
        rule.node(CloudTags.EMAIL).assert(SemanticsMatcher.expectValue(SemanticsProperties.ContentType, ContentType.EmailAddress))
        // Nothing worth sending yet.
        label(CloudTags.PRIMARY, "Send code")
        rule.node(CloudTags.PRIMARY).assertIsNotEnabled()
        rule.node(CloudTags.EMAIL).performTextInput("ada")
        rule.node(CloudTags.PRIMARY).assertIsNotEnabled()
        rule.node(CloudTags.EMAIL).performTextInput("@example.com")
        rule.node(CloudTags.PRIMARY).assertIsEnabled().performClick()
        rule.node(HeaderTags.LEFT).performClick()
        assertEquals(listOf("send ada@example.com", "back"), taps)
    }

    @Test
    fun theEmailStepSaysWhyItWasRefused() {
        emailStep()
        val said = listOf(
            EmailSignIn.InvalidEmail to "That doesn’t look like an email address.",
            EmailSignIn.Unavailable to "Email sign-in isn’t working right now. Try again in a moment.",
            EmailSignIn.Unsupported("Email sign-in is not configured.") to "Email sign-in is not configured.",
            EmailSignIn.Unsupported(null) to "Email sign-in isn’t available yet.",
            EmailSignIn.RateLimited(42, null) to "Too many tries. Wait a moment, then try again.",
            EmailSignIn.Failed(CloudException.Reason.Failed) to "Something went wrong. Try again.",
        )
        for ((answer, text) in said) {
            outcome = answer
            rule.onNodeWithText(text).assertExists()
        }
    }

    /** A 429: the service's words, and Send code counts down until it may go again. */
    @Test
    fun aRateLimitHoldsSendCode() {
        emailStep()
        rule.node(CloudTags.EMAIL).performTextInput("ada@example.com")
        outcome = EmailSignIn.RateLimited(102, "Too many requests. Try again later.")
        wait = 102
        rule.onNodeWithText("Too many requests. Try again later.").assertExists()
        label(CloudTags.PRIMARY, "Try again in 1:42")
        rule.node(CloudTags.PRIMARY).assertIsNotEnabled()
        wait = 0
        label(CloudTags.PRIMARY, "Send code")
        rule.node(CloudTags.PRIMARY).assertIsEnabled()
    }

    /** Verify over Resend at the bottom, Resend 48 above it; Change email under the field. */
    @Test
    fun theCodeStepTakesSixDigits() {
        resendWait = 60
        codeStep()
        rule.onNodeWithText("Check your email").assertExists()
        rule.onNodeWithText("Enter the 6-digit code we sent to ${CloudEmail.unbroken("ada@example.com")}.").assertExists()
        rule.node(CloudTags.EMAIL_CODE).assert(SemanticsMatcher.expectValue(SemanticsProperties.ContentType, ContentType.SmsOtpCode))
        val field = rule.node(CloudTags.EMAIL_CODE).bounds
        assertDp("field as wide as the column", (PHONE_WIDTH - 48).dp, field.width)
        val change = rule.node(CloudTags.CHANGE_EMAIL).bounds
        assertEquals(true, change.top >= field.bottom + 16.dp)
        val verify = rule.node(CloudTags.PRIMARY).bounds
        val resend = rule.node(CloudTags.SECONDARY).bounds
        assertDp("resend 48 above the bottom", (891 - 48).dp, resend.bottom)
        assertDp("resend 8 under verify", verify.bottom + 8.dp, resend.top)
        // A fresh code: Resend waits its minute.
        label(CloudTags.SECONDARY, "Resend in 1:00")
        rule.node(CloudTags.SECONDARY).assertIsNotEnabled()
        rule.node(CloudTags.PRIMARY).assertIsNotEnabled()
        // Digits only, six at most.
        rule.node(CloudTags.EMAIL_CODE).performTextInput("12 3-4a5")
        rule.node(CloudTags.EMAIL_CODE).assertTextEquals("12345")
        rule.node(CloudTags.PRIMARY).assertIsNotEnabled()
        rule.node(CloudTags.EMAIL_CODE).performTextInput("678")
        rule.node(CloudTags.EMAIL_CODE).assertTextEquals("123456")
        rule.node(CloudTags.PRIMARY).assertIsEnabled().performClick()
        resendWait = 0
        label(CloudTags.SECONDARY, "Resend code")
        rule.node(CloudTags.SECONDARY).assertIsEnabled().performClick()
        rule.node(CloudTags.CHANGE_EMAIL).performClick()
        rule.node(HeaderTags.LEFT).performClick()
        assertEquals(listOf("verify 123456", "resend", "change", "back"), taps)
    }

    /**
     * Paste sits inside the field at its end, as tall as the field and 48
     * or more across, and moves nothing: the field is as wide as the column
     * and 56 tall with it, as the address step's is without. It only hands
     * the press over; the clipboard is the caller's to read then.
     */
    @Test
    fun pasteIsInsideTheFieldAndMovesNothing() {
        codeStep()
        val field = rule.node(CloudTags.EMAIL_CODE).bounds
        assertDp("field as wide as the column", (PHONE_WIDTH - 48).dp, field.width)
        assertDp("field 56 tall", 56.dp, field.height)
        val paste = rule.node(CloudTags.EMAIL_PASTE).bounds
        label(CloudTags.EMAIL_PASTE, "Paste")
        assertDp("paste ends with the field", field.right, paste.right)
        assertDp("paste as tall as the field", field.top, paste.top)
        assertDp("paste as tall as the field", field.bottom, paste.bottom)
        assertEquals("a target at least 48 across", true, paste.width >= 48.dp)
        assertEquals(emptyList<String>(), taps)
        rule.node(CloudTags.EMAIL_PASTE).performClick()
        assertEquals(listOf("paste"), taps)
        // Typing doesn't move it, and a check holds it.
        rule.node(CloudTags.EMAIL_CODE).performTextInput("123456")
        assertEquals(paste, rule.node(CloudTags.EMAIL_PASTE).bounds)
        busy = true
        rule.node(CloudTags.EMAIL_PASTE).assertIsNotEnabled()
        busy = false
        // Nothing to paste: said under the field, quietly, until something else is.
        pasteMissed = true
        rule.onNodeWithText("There’s no 6-digit code on the clipboard.").assertExists()
        outcome = EmailSignIn.InvalidCode
        rule.onNodeWithText("There’s no 6-digit code on the clipboard.").assertDoesNotExist()
        rule.onNodeWithText("That code is wrong or has expired.").assertExists()
    }

    /**
     * With a mail app on the phone, "Open email app" sits beside Change
     * email on one line under the field, 8 apart and centred in the column;
     * with none it is left out and Change email is where it was, alone.
     * The field and both buttons are where they are without it.
     */
    @Test
    fun openEmailAppSitsBesideChangeEmail() {
        codeStep()
        rule.node(CloudTags.OPEN_MAIL).assertDoesNotExist()
        val alone = rule.node(CloudTags.CHANGE_EMAIL).bounds
        val field = rule.node(CloudTags.EMAIL_CODE).bounds
        val verify = rule.node(CloudTags.PRIMARY).bounds
        val resend = rule.node(CloudTags.SECONDARY).bounds
        assertDp("change email centred", (PHONE_WIDTH / 2f).dp, (alone.left + alone.right) / 2)
        assertDp("change email at least 280 wide", 280.dp, alone.width)

        mailApp = true
        rule.waitForIdle()
        val mail = rule.node(CloudTags.OPEN_MAIL).bounds
        val change = rule.node(CloudTags.CHANGE_EMAIL).bounds
        label(CloudTags.OPEN_MAIL, "Open email app")
        assertDp("on one line", mail.top, change.top)
        assertDp("as tall as each other", mail.bottom, change.bottom)
        assertDp("8 apart", mail.right + 8.dp, change.left)
        assertDp("the pair centred", (PHONE_WIDTH / 2f).dp, (mail.left + change.right) / 2)
        assertDp("where change email was", alone.top, change.top)
        assertDp("as tall as change email was", alone.bottom, change.bottom)
        assertEquals("nothing else moved", listOf(field, verify, resend), listOf(rule.node(CloudTags.EMAIL_CODE).bounds, rule.node(CloudTags.PRIMARY).bounds, rule.node(CloudTags.SECONDARY).bounds))
        rule.node(CloudTags.OPEN_MAIL).performClick()
        rule.node(CloudTags.CHANGE_EMAIL).performClick()
        assertEquals(listOf("mail", "change"), taps)
        // Opening the mail app never waits on a check.
        busy = true
        rule.node(CloudTags.OPEN_MAIL).assertIsEnabled()
    }

    /** The clipboard is read by [clipboardText] alone, which only Paste's press calls; the phone's mail app is found through the manifest's queries. */
    @Test
    fun theClipboardAndTheMailApp() {
        val context = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        val clipboard = context.getSystemService(android.content.ClipboardManager::class.java)
        assertEquals(null, CloudEmail.pastedCode(clipboardText(context)))
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("mail", "Your Happy code is 493 021? No: 493021. It expires in 10 minutes."))
        assertEquals("493021", CloudEmail.pastedCode(clipboardText(context)))

        assertEquals("no mail app, no action", null, mailAppIntent(context))
        val mail = android.content.Intent(android.content.Intent.ACTION_MAIN).addCategory(android.content.Intent.CATEGORY_APP_EMAIL)
        org.robolectric.Shadows.shadowOf(context.packageManager).addResolveInfoForIntent(
            mail,
            android.content.pm.ResolveInfo().apply { activityInfo = android.content.pm.ActivityInfo().apply { packageName = "com.example.mail"; name = "Inbox" } },
        )
        val intent = mailAppIntent(context)!!
        assertEquals(android.content.Intent.ACTION_MAIN, intent.action)
        assertEquals(setOf(android.content.Intent.CATEGORY_APP_EMAIL), intent.categories)
        assertEquals("a task of its own", android.content.Intent.FLAG_ACTIVITY_NEW_TASK, intent.flags and android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        assertEquals("the system picks the app", null, intent.component)

        // API 30 and later show the app a mail app only because the manifest asks.
        val manifest = java.io.File("src/main/AndroidManifest.xml").readText().replace(Regex("\\s+"), " ")
        assertEquals(true, """<intent> <action android:name="android.intent.action.MAIN" /> <category android:name="android.intent.category.APP_EMAIL" /> </intent>""" in manifest)
    }

    @Test
    fun theCodeStepSaysWhyItWasRefused() {
        codeStep()
        val said = listOf(
            EmailSignIn.InvalidCode to "That code is wrong or has expired.",
            EmailSignIn.Sent to "We sent you a new code.",
            EmailSignIn.Unsupported("Email sign-in is not configured.") to "Email sign-in is not configured.",
            EmailSignIn.Failed(CloudException.Reason.Unreachable) to "Happy Cloud couldn't be reached. Check your connection and try again.",
        )
        for ((answer, text) in said) {
            outcome = answer
            rule.onNodeWithText(text).assertExists()
        }
    }

    /** A 429 holds Verify and Resend both, Resend for the longer of its wait and its own minute. */
    @Test
    fun aRateLimitHoldsVerifyAndResend() {
        codeStep()
        rule.node(CloudTags.EMAIL_CODE).performTextInput("123456")
        outcome = EmailSignIn.RateLimited(30, "Too many requests. Try again later.")
        wait = 30
        resendWait = 12
        rule.onNodeWithText("Too many requests. Try again later.").assertExists()
        label(CloudTags.PRIMARY, "Try again in 0:30")
        label(CloudTags.SECONDARY, "Resend in 0:30")
        rule.node(CloudTags.PRIMARY).assertIsNotEnabled()
        rule.node(CloudTags.SECONDARY).assertIsNotEnabled()
    }

    @Test
    fun whileBusyNothingElseGoes() {
        busy = true
        codeStep()
        rule.node(CloudTags.PRIMARY).assertIsNotEnabled()
        rule.node(CloudTags.SECONDARY).assertIsNotEnabled()
        rule.node(CloudTags.CHANGE_EMAIL).assertIsNotEnabled()
    }

    @Test
    fun theRules() {
        assertEquals(true, CloudEmail.plausible(" ada@example.com "))
        assertEquals(false, CloudEmail.plausible("ada@"))
        assertEquals(false, CloudEmail.plausible("@example.com"))
        assertEquals(false, CloudEmail.plausible("ada"))
        assertEquals("123456", CloudEmail.typedCode("123 456 789"))
        // Paste: the first run of exactly six digits, wherever it is in what was copied.
        assertEquals("493021", CloudEmail.pastedCode("493021"))
        assertEquals("493021", CloudEmail.pastedCode("  493021\n"))
        assertEquals("493021", CloudEmail.pastedCode("Your code is 493021."))
        assertEquals("493021", CloudEmail.pastedCode("Sign in to Happy\n\n493021\n\nThis code expires in 10 minutes."))
        assertEquals("493021", CloudEmail.pastedCode("Order 12345, code 493021, then 777777"))
        assertEquals("a longer number holds no code", "493021", CloudEmail.pastedCode("+1 4155550100 1234567 493021"))
        assertEquals(null, CloudEmail.pastedCode("1234567"))
        assertEquals(null, CloudEmail.pastedCode("493 021"))
        assertEquals(null, CloudEmail.pastedCode("12345"))
        assertEquals(null, CloudEmail.pastedCode("no digits"))
        assertEquals(null, CloudEmail.pastedCode(""))
        assertEquals(null, CloudEmail.pastedCode(null))
        // Only ASCII digits are a code, as the field takes.
        assertEquals(null, CloudEmail.pastedCode("٤٩٣٠٢١"))
        assertEquals("0:05", CloudEmail.countdown(5))
        assertEquals("15:00", CloudEmail.countdown(900))
        assertEquals("a\u2060@\u2060b", CloudEmail.unbroken("a@b"))
    }
}
