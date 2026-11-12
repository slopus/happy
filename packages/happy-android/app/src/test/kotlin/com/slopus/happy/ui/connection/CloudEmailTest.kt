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

    @Test
    fun theCodeStepSaysWhyItWasRefused() {
        codeStep()
        val said = listOf(
            EmailSignIn.InvalidCode to "That code is wrong or has expired.",
            EmailSignIn.Sent to "We sent you a new code.",
            EmailSignIn.Unsupported("Email sign-in is not configured.") to "Email sign-in is not configured.",
            EmailSignIn.Failed(CloudException.Reason.Unreachable) to "Could not reach the server. Check the address and your connection.",
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
        assertEquals("0:05", CloudEmail.countdown(5))
        assertEquals("15:00", CloudEmail.countdown(900))
        assertEquals("a\u2060@\u2060b", CloudEmail.unbroken("a@b"))
    }
}
